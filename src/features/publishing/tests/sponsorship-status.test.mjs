import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { renderComponent, install, teardown } from '../../../../scripts/harness.mjs'
beforeEach(install)
after(teardown)
const entry = { eligible: true, reason: 'ens', posting_available: true, posting_paused_reason: null, at: 0 }
const render = (props = {}) => renderComponent('features/publishing/SponsorshipStatus.svelte', {
  entry, offered: true, payMyself: false, onToggle: () => {}, onRefresh: () => {}, ...props,
})
// The line's words, without the comments Svelte leaves in rendered markup.
const words = html => html.replace(/<!--.*?-->/gs, '')

test('active sponsorship identifies the qualifying rule without redundant payment copy', async () => {
  for (const [reason, label] of [['ens', 'your ENS name'], ['basename', 'your Basename'], ['curated', 'the curated list']]) {
    const html = await render({ entry: { ...entry, reason } })
    assert.match(html, /free via /)
    assert.equal(html.match(/\bvia\b/g).length, 1, 'the reason is given once')
    assert.doesNotMatch(html, /gas paid by the host|refresh free posting|>retry</)
    assert.ok(html.includes(label))
    assert.match(html, /pay my own gas/)
  }
})

test('paused sponsorship explains gas, quota or funding limits without claiming it is active', async () => {
  for (const reason of ['gas fees are above the limit', 'daily allowance used', 'host balance too low']) {
    const html = await render({ entry: { ...entry, posting_available: false, posting_paused_reason: reason } })
    assert.match(html, /free posting paused/)
    assert.ok(html.includes(reason))
    assert.match(html, />retry</)
    assert.doesNotMatch(html, /free via|use free posting/)
    assert.match(html, /pay my own gas/)
  }
})

test('paying gas goes unsaid, and eligible users who chose to pay can switch back', async () => {
  const html = await render({ payMyself: true })
  assert.match(html, /use free posting/)
  assert.doesNotMatch(html, /you pay gas|free via|·/)
})

test('checking, unavailable and ineligible states are distinct', async () => {
  const checking = await render({ entry: undefined })
  assert.match(checking, /checking free posting/)
  assert.doesNotMatch(checking, />retry</)
  const unknown = await render({ entry: { eligible: null, reason: null, error: 'RPC unavailable', at: 0 }, namesEnabled: true })
  assert.match(unknown, /free posting check failed/)
  assert.match(unknown, />retry<\/button>\s+or <button[^>]*>pay my own gas<\/button>/)
  assert.doesNotMatch(unknown, /RPC unavailable|get an/)
  assert.match(unknown, />retry</)
  const ineligible = await render({ entry: { eligible: false, reason: null, at: 0 } })
  assert.doesNotMatch(ineligible, /you pay gas|·|not eligible|free posting is not offered/)
  assert.doesNotMatch(ineligible, /check failed|free via|>retry</)
  const hinted = words(await render({ entry: { eligible: false, reason: null, at: 0 }, namesEnabled: true }))
  assert.match(hinted, /<span class="dim">get an <a[^>]*>ENS<\/a> or <a[^>]*>Basename<\/a> for free posting<\/span>/, 'a name hint alone needs no separator')
  assert.doesNotMatch(hinted, /you pay gas|·/)
  const checkingHint = words(await render({ entry: undefined, namesEnabled: true }))
  assert.match(checkingHint, /checking free posting….*·.*pay my own gas<\/button>\s*<span class="dim"> · get an /s, 'after the check and its button, the hint follows a separator')
  const unavailable = await render({ offered: false })
  assert.doesNotMatch(unavailable, /you pay gas|·|not eligible|not offered/)
})

test('older eligibility-only responses do not promise current availability', async () => {
  const html = await render({ entry: { eligible: true, reason: 'ens', at: 0 } })
  assert.match(html, /eligible for free posting/)
  assert.match(html, /availability checked when you post/)
  assert.doesNotMatch(html, /free via/)
})

test('paused sponsorship selects paid posting with a visible explanation and recovers to free', async () => {
  const { load, mock, author, response } = await import('../../../../scripts/harness.mjs')
  const { host } = await load('lib/host.svelte.ts')
  const { wallet } = await load('lib/wallet.svelte.ts')
  const { sponsorship } = await load('features/publishing/sponsorship.svelte.ts')
  const { DraftBox } = await load('features/publishing/draft-box.svelte.ts')
  host.status = null
  host.relay = { chains: [{ ...mock.chain, name_sponsorship: { ens: true, basenames: true } }] }
  wallet.account = author
  const owner = new DraftBox()
  owner.edit({ text: 'hello', mentions: {}, attachments: [] })
  globalThis.fetch = async () => response({ address: author, ...entry, posting_available: false, posting_paused_reason: 'gas fees are high' })
  await sponsorship.require(mock.chain, author)
  const paused = await renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, owner })
  assert.match(paused, /free posting paused/)
  const postButton = html => html.match(/<button[^>]*class="post-action[^"]*"[^>]*>.*?<\/button>/s)?.[0] ?? ''
  assert.doesNotMatch(postButton(paused), /^<button[^>]*\sdisabled(?:=|\s|>)/)
  assert.match(postButton(paused), /<span[^>]*aria-hidden="false"[^>]*>post<\/span>/)
  assert.match(paused, /you pay gas/)
  assert.doesNotMatch(paused, /pay my own gas/)
  globalThis.fetch = async () => response({ address: author, ...entry })
  sponsorship.forget(mock.chain, author)
  await sponsorship.require(mock.chain, author)
  const active = await renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, owner })
  assert.match(active, /free via /)
  assert.doesNotMatch(postButton(active), /^<button[^>]*\sdisabled(?:=|\s|>)/)
  assert.match(postButton(active), /<span[^>]*aria-hidden="false"[^>]*>post<\/span>/, 'the status line, not the button, says it is free')
  wallet.account = null
})

test('refresh keeps an unchanged composer stable while sponsorship is checked again', async () => {
  const { load, mock, author, response, deferred } = await import('../../../../scripts/harness.mjs')
  const { host } = await load('lib/host.svelte.ts')
  const { wallet } = await load('lib/wallet.svelte.ts')
  const { sponsorship } = await load('features/publishing/sponsorship.svelte.ts')
  const { DraftBox } = await load('features/publishing/draft-box.svelte.ts')
  host.status = null
  host.relay = { chains: [{ ...mock.chain, name_sponsorship: { ens: true, basenames: true } }] }
  wallet.account = author
  const owner = new DraftBox(), waiting = deferred()
  globalThis.fetch = async () => response({ address: author, ...entry })
  try {
    await sponsorship.require(mock.chain, author)
    const before = await renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, owner })
    globalThis.fetch = async () => { await waiting.promise; return response({ address: author, ...entry }) }
    sponsorship.forget(mock.chain, author)
    const refresh = sponsorship.require(mock.chain, author)
    const during = await renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, owner })
    waiting.resolve()
    await refresh
    const after = await renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, owner })
    assert.equal(during, before, 'refresh must not insert an ENS hint or replace the existing sponsorship status')
    assert.equal(after, before)
  } finally {
    waiting.resolve()
    wallet.account = null
  }
})

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'

// A public test deployment, set before Vite creates the module environment.
process.env.VITE_ACCOUNT_KEYS_ADDRESS = '0x1111111111111111111111111111111111111111'
process.env.VITE_ACCOUNT_KEYS_DEV_FUND = '0x3333333333333333333333333333333333333333'
const { load, install, teardown, mock, author, renderComponent } = await import('../../../../scripts/host-harness.mjs')
const { parse, href, router } = await load('features/navigation/router.svelte.ts')
const { gates } = await load('lib/gates.svelte.ts')
const { TOMBSTONE } = await load('lib/board.ts')
beforeEach(() => { install(); router.route = { kind: 'home' } })
after(teardown)

test('settings preserves the chain named by its link and rejects malformed routes', () => {
  assert.deepEqual(parse(href.settings(84532)), { kind: 'settings', chainId: 84532 })
  assert.deepEqual(parse(href.settings(8453)), { kind: 'settings', chainId: 8453 })
  for (const path of ['#/settings/0', '#/settings/no', '#/settings/8453/extra', '#/settings/8453?extra', '#/settings/9007199254740993']) {
    assert.equal(parse(path).kind, 'unknown', path)
  }
})

test('settings is linked before about in the left navigation, using the displayed chain', async () => {
  router.route = { kind: 'settings', chainId: mock.chain.id }
  const previous = globalThis.document
  globalThis.document = { documentElement: { dataset: {} } }
  try {
    const html = await renderComponent('features/navigation/Sidebar.svelte', { selected: mock.chain })
    assert.ok(html.indexOf(href.settings(mock.chain.id)) < html.indexOf('href="/about"'))
    assert.match(html.match(new RegExp(`<a[^>]*href="#/settings/${mock.chain.id}"[^>]*>`))[0], /active/)
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test('signed-out settings has no account mutation control', async () => {
  const html = await renderComponent('features/account/Settings.svelte', { chain: mock.chain, address: null })
  assert.match(html, /connect your wallet/)
  assert.doesNotMatch(html, /deactivate account…|reactivate account/)
  assert.equal(mock.calls.length, 0)
})

test('a deactivated account offers reactivation and no reply rule selector', async () => {
  mock.authorGate = TOMBSTONE
  await gates.ensureAuthor(mock.chain, author)
  const props = { chain: mock.chain, address: author }
  const settings = await renderComponent('features/account/Settings.svelte', props)
  assert.match(settings, /reactivate account/)
  assert.doesNotMatch(settings, /deactivate account…|<select id="author-reply-rule"/)
})

test('an active account gets the reply rule, and deactivation stays out of the rule selector', async () => {
  await gates.ensureAuthor(mock.chain, author)
  const props = { chain: mock.chain, address: author }
  const settings = await renderComponent('features/account/Settings.svelte', props)
  assert.match(settings, /deactivate account…/)
  assert.match(settings, /posts with their own reply rule are unaffected/)
  assert.match(settings, /who can reply/)
  const rule = await renderComponent('features/account/AuthorGate.svelte', { ...props, keyStatus: 'inactive' })
  assert.doesNotMatch(rule, /value="deactivated"|deactivate account…/)
})

test('settings links to key activation only on the configured rollout chain', async () => {
  const html = await renderComponent('features/account/Settings.svelte', { chain: { ...mock.chain, id: 84532 }, address: author })
  assert.match(html, /href="#\/keys\/84532"[^>]*>account key activation/)
  const mainnet = await renderComponent('features/account/Settings.svelte', { chain: { ...mock.chain, id: 8453 }, address: null })
  assert.doesNotMatch(mainnet, /account key activation/)
})


test('signed-out settings hides keyring management even on an indexed chain', async () => {
  const { host } = await load('lib/host.svelte.ts')
  const saved = host.status
  try {
    host.status = { chains: [mock.chain], keyrings: [{ chain: mock.chain.id, market: '0x7777777777777777777777777777777777777777', start_block: 1 }] }
    const html = await renderComponent('features/account/Settings.svelte', { chain: mock.chain, address: null })
    assert.doesNotMatch(html, /manage keyring|account key activation/)
    const other = await renderComponent('features/account/Settings.svelte', { chain: { ...mock.chain, id: mock.chain.id + 1 }, address: null })
    assert.doesNotMatch(other, /manage keyring/)
  } finally { host.status = saved }
})

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, curate, mock, address, author, response, deferred } from '../../../../scripts/host-harness.mjs'
const { sponsorship } = await load('features/publishing/sponsorship.svelte.ts')
const { host } = await load('lib/host.svelte.ts')
const { names } = await load('lib/names.svelte.ts')
const { sponsorName, setSponsorName } = await load('features/publishing/sponsor-name.ts')
const { relayPost, sponsorEligibility } = await load('features/publishing/relay.ts')
let requests, handler
beforeEach(() => {
  install()
  requests = []
  host.relay = { chains: [{ id: mock.chain.id, contract: mock.chain.contract, name_sponsorship: { ens: true, basenames: true } }] }
  host.status = null
  names.entries = {}
  const otherFetch = globalThis.fetch
  handler = (wallet, name) => ({ eligible: name === 'alice.eth' || name === 'alice.base.eth', reason: name === 'alice.eth' ? 'ens' : name === 'alice.base.eth' ? 'basename' : null })
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://client.invalid')
    if (url.pathname.includes('/eligibility/')) {
      const wallet = url.pathname.split('/').at(-1), name = url.searchParams.get('name')
      requests.push({ wallet, name })
      const result = await handler(wallet, name)
      return result instanceof Response ? result : response({ address: wallet, ...result })
    }
    return otherFetch(input, init)
  }
})
after(teardown)

test('list-only eligibility follows host policy immediately without remote checks', async () => {
  host.relay.chains[0].name_sponsorship = null
  curate([author])
  assert.equal(sponsorship.lookup(mock.chain, author).eligible, true)
  assert.equal(await sponsorship.require(mock.chain, author), true)
  host.status.host_policy.blocked = [author]
  assert.equal(sponsorship.lookup(mock.chain, author).eligible, false)
  assert.equal(await sponsorship.require(mock.chain, author), false)
  curate([])
  assert.equal(sponsorship.lookup(mock.chain, author).eligible, false)
  curate([author])
  const unavailable = { ...mock.chain, curated: false }
  assert.equal(sponsorship.lookup(unavailable, author), undefined)
  assert.equal(await sponsorship.require(unavailable, author), false)
  assert.equal(mock.calls.length, 0)
  assert.equal(requests.length, 0)
})

test('discovers a profile name but authorizes only after backend ownership verification', async () => {
  names.entries[author.toLowerCase()] = { name: 'alice.base.eth', source: 'basenames', avatar: null, checkedAt: Date.now() }
  assert.equal(await sponsorship.require(mock.chain, author), true)
  assert.deepEqual(requests.map((r) => r.name), ['alice.base.eth'], 'one request, carrying the profile name')
  assert.equal(sponsorName(mock.chain.id, author), 'alice.base.eth')
  assert.equal(await sponsorship.require(mock.chain, author), true)
  assert.equal(requests.length, 1, 'brief advisory cache')
})

test('a list member is answered without waiting for a slow name lookup', async () => {
  host.status = { gateway: { names: true } }
  const fetch = globalThis.fetch
  globalThis.fetch = (input, init) => String(input).includes('/api/names/') ? new Promise(() => {}) : fetch(input, init)
  handler = () => ({ eligible: true, reason: 'curated' })
  const waited = new Promise((_, reject) => setTimeout(() => reject(new Error('eligibility waited on the name lookup')), 1000).unref())
  assert.equal(await Promise.race([sponsorship.require(mock.chain, author), waited]), true)
  assert.deepEqual(requests.map((r) => r.name), [null], 'asked at once, without a name')
})

test('profile resolution alone cannot grant sponsorship', async () => {
  names.entries[author.toLowerCase()] = { name: 'alice.eth', source: 'ens', avatar: null, checkedAt: Date.now() }
  handler = () => ({ eligible: false, reason: null })
  assert.equal(await sponsorship.require(mock.chain, author), false)
  assert.equal(sponsorName(mock.chain.id, author), undefined)
})

test('curated eligibility does not depend on name discovery', async () => {
  handler = () => ({ eligible: true, reason: 'curated' })
  names.entries[author.toLowerCase()] = { name: null, source: null, avatar: null, checkedAt: Date.now(), error: true }
  assert.equal(await sponsorship.require(mock.chain, author), true)
  assert.equal(requests.length, 1)
})

test('name ownership remains usable when the initial list-only lookup is unavailable', async () => {
  names.entries[author.toLowerCase()] = { name: 'alice.eth', source: 'ens', avatar: null, checkedAt: Date.now() }
  handler = (_, name) => name ? { eligible: true, reason: 'ens' } : response({ error: 'list unavailable' }, 502)
  assert.equal(await sponsorship.require(mock.chain, author), true)
})

test('outages stay unknown, and a stored name hint is used when discovery fails', async () => {
  // The name service is down: an earlier failure is asked about again, and fails again.
  host.status = { gateway: { names: true } }
  const fetch = globalThis.fetch
  let lookups = 0
  globalThis.fetch = (input, init) => String(input).includes('/api/names/') ? (lookups++, Promise.resolve(response({ error: 'unavailable' }, 500))) : fetch(input, init)
  names.entries[author.toLowerCase()] = { name: null, source: null, avatar: null, checkedAt: Date.now(), error: true }
  await assert.rejects(sponsorship.require(mock.chain, author), /look up your name/)
  assert.equal(lookups, 1)
  assert.equal(sponsorship.lookup(mock.chain, author).eligible, null)
  setSponsorName(mock.chain.id, author, 'alice.eth')
  sponsorship.forget(mock.chain, author)
  assert.equal(await sponsorship.require(mock.chain, author), true)
  assert.equal(sponsorName(mock.chain.id, author), 'alice.eth')
  sponsorship.forget(mock.chain, author)
  handler = () => response({ error: 'RPC unavailable' }, 502)
  await assert.rejects(sponsorship.require(mock.chain, author), /RPC unavailable/)
  assert.equal(sponsorship.lookup(mock.chain, author).eligible, null)
})

test('pending answers and name hints stay isolated across wallets and chains', async () => {
  const waiting = deferred(), other = address('33')
  handler = async (wallet) => {
    if (wallet === author) { await waiting.promise; return { eligible: true, reason: 'curated' } }
    return { eligible: false, reason: null }
  }
  const first = sponsorship.require(mock.chain, author)
  assert.equal(await sponsorship.require(mock.chain, other), false)
  waiting.resolve()
  assert.equal(await first, true)
  assert.equal(sponsorship.lookup(mock.chain, other).eligible, false)
  setSponsorName(mock.chain.id, author, 'alice.eth')
  assert.equal(sponsorName(mock.chain.id, other), undefined)
  assert.equal(sponsorName(mock.chain.id + 1, author), undefined)
})

test('a late discovery answer cannot overwrite a newer name hint', async () => {
  const waiting = deferred()
  names.entries[author.toLowerCase()] = { name: 'alice.eth', source: 'ens', avatar: null, checkedAt: Date.now() }
  handler = async (_, name) => {
    if (!name) { await waiting.promise; return { eligible: false, reason: null } }
    return { eligible: true, reason: name.endsWith('base.eth') ? 'basename' : 'ens' }
  }
  const earlier = sponsorship.require(mock.chain, author)
  setSponsorName(mock.chain.id, author, 'alice.base.eth')
  sponsorship.forget(mock.chain, author)
  assert.equal(await sponsorship.require(mock.chain, author), true)
  waiting.resolve()
  await earlier
  assert.equal(sponsorName(mock.chain.id, author), 'alice.base.eth')
})

test('submission carries the author-scoped hint and keeps Board fields intact', async () => {
  setSponsorName(mock.chain.id, author, 'alice.eth')
  mock.relayStatus = 200
  const signed = { author, nonce: '1' }
  let url
  const fetch = globalThis.fetch
  globalThis.fetch = (input, init) => { url = String(input); return fetch(input, init) }
  await relayPost(mock.chain.id, signed)
  assert.ok(url.endsWith('/post?name=alice.eth'))
  assert.deepEqual(mock.calls.at(-1).signed, signed)
  await relayPost(mock.chain.id, { ...signed, author: address('33') })
  assert.ok(url.endsWith('/post'))
})

test('rejects malformed names and mismatched eligibility responses', async () => {
  assert.throws(() => setSponsorName(mock.chain.id, author, 'sub.alice.eth'), /directly under/)
  handler = () => response({ address: address('33'), eligible: true, reason: 'ens' })
  await assert.rejects(sponsorEligibility(mock.chain.id, author), /invalid sponsorship/)
})

test('a discovered ineligible name is reused briefly without a second list-only poll', async () => {
  names.entries[author.toLowerCase()] = { name: 'alice.eth', source: 'ens', avatar: null, checkedAt: Date.now() }
  handler = () => ({ eligible: false, reason: null })
  const originalNow = Date.now, start = Date.now()
  try {
    Date.now = () => start
    assert.equal(await sponsorship.require(mock.chain, author), false)
    assert.deepEqual(requests.map(r => r.name), ['alice.eth'])
    // A refresh within the hint's five minutes asks with it directly.
    Date.now = () => start + 121_000
    sponsorship.forget(mock.chain, author)
    assert.equal(await sponsorship.require(mock.chain, author), false)
    assert.deepEqual(requests.map(r => r.name), ['alice.eth', 'alice.eth'])
    assert.equal(sponsorName(mock.chain.id, author), undefined, 'a lookup hint is not proof of eligibility')
    names.entries[author.toLowerCase()] = { name: 'new.eth', source: 'ens', avatar: null, checkedAt: Date.now() }
    Date.now = () => start + 721_000
    assert.equal(await sponsorship.require(mock.chain, author), false)
    assert.deepEqual(requests.slice(-1).map(r => r.name), ['new.eth'], 'failed hints eventually refresh')
    assert.equal(requests.length, 3)
  } finally { Date.now = originalNow }
})


test('composer watching refreshes expired eligibility, shares readers and stops when closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const originalDocument = globalThis.document
  globalThis.document = { visibilityState: 'visible' }
  handler = () => ({ eligible: true, reason: 'curated' })
  const step = async ms => { t.mock.timers.tick(ms); await new Promise(setImmediate) }
  const first = sponsorship.watch(mock.chain, author), second = sponsorship.watch(mock.chain, author)
  try {
    await step(0)
    assert.equal(requests.length, 1, 'two composers share the first read')
    await step(30_000)
    assert.equal(await sponsorship.require(mock.chain, author), true)
    assert.equal(requests.length, 1, 'no thirty-second network refresh')
    await step(569_999); assert.equal(requests.length, 1, 'a healthy answer stands for ten minutes')
    await step(1); assert.equal(requests.length, 2)
    globalThis.document.visibilityState = 'hidden'
    await step(600_000); assert.equal(requests.length, 2)
    await step(3_600_000); assert.equal(requests.length, 2, 'a hidden tab asks nothing')
    globalThis.document.visibilityState = 'visible'
    await step(60_000); assert.equal(requests.length, 3, 'a tab shown again catches up within a minute')
    sponsorship.forget(mock.chain, author)
    await sponsorship.require(mock.chain, author)
    assert.equal(requests.length, 4, 'explicit refresh bypasses the client cache')
  } finally { first(); second(); globalThis.document = originalDocument }
  await step(1_200_000); assert.equal(requests.length, 4, 'closed composers leave no polling')
})

test('invalidation keeps display stable but fetches fresh availability and rejects stale completions', async () => {
  handler = () => ({ eligible: true, reason: 'curated', posting_available: true, posting_paused_reason: null })
  await sponsorship.require(mock.chain, author)
  const old = deferred(), latest = deferred()
  handler = async () => { await old.promise; return { eligible: true, reason: 'curated', posting_available: true, posting_paused_reason: null } }
  sponsorship.forget(mock.chain, author)
  const staleRead = sponsorship.require(mock.chain, author)
  assert.equal(sponsorship.lookup(mock.chain, author).posting_available, true)
  handler = async () => { await latest.promise; return { eligible: true, reason: 'curated', posting_available: false, posting_paused_reason: 'daily allowance used' } }
  sponsorship.forget(mock.chain, author)
  const freshRead = sponsorship.require(mock.chain, author)
  assert.equal(requests.length, 3, 'each invalidation requires a fresh answer')
  latest.resolve(); await freshRead
  old.resolve(); await staleRead
  assert.equal(sponsorship.lookup(mock.chain, author).posting_available, false)
  assert.equal(sponsorship.lookup(mock.chain, author).posting_paused_reason, 'daily allowance used')
  handler = () => response({ error: 'RPC unavailable' }, 502)
  sponsorship.forget(mock.chain, author)
  await assert.rejects(sponsorship.require(mock.chain, author), /RPC unavailable/)
  assert.equal(sponsorship.lookup(mock.chain, author).eligible, null, 'a failed check must replace stale eligibility with unknown')
})

test('paused sponsorship retries promptly and shares the retry across composers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const oldDocument = globalThis.document
  globalThis.document = { visibilityState: 'visible' }
  handler = () => ({ eligible: true, reason: 'curated', posting_available: false, posting_paused_reason: 'gas price unavailable' })
  const stop = sponsorship.watch(mock.chain, author)
  const stopOther = sponsorship.watch(mock.chain, author)
  try {
    await new Promise(setImmediate)
    assert.equal(requests.length, 1)
    assert.equal(sponsorship.lookup(mock.chain, author).posting_available, false)
    handler = () => ({ eligible: true, reason: 'curated', posting_available: true, posting_paused_reason: null })
    t.mock.timers.tick(9999)
    await new Promise(setImmediate)
    assert.equal(requests.length, 1)
    t.mock.timers.tick(1)
    await new Promise(setImmediate)
    assert.equal(requests.length, 2)
    assert.equal(sponsorship.lookup(mock.chain, author).posting_available, true)
  } finally { stop(); stopOther(); globalThis.document = oldDocument }
})

test('a pause another check finds is retried on its own schedule, not the earlier answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const oldDocument = globalThis.document
  globalThis.document = { visibilityState: 'visible' }
  const healthy = () => ({ eligible: true, reason: 'curated', posting_available: true, posting_paused_reason: null })
  handler = healthy
  const step = async ms => { t.mock.timers.tick(ms); await new Promise(setImmediate) }
  const stop = sponsorship.watch(mock.chain, author), stopOther = sponsorship.watch(mock.chain, author)
  try {
    await step(0)
    assert.equal(requests.length, 1)
    await step(60_000)
    handler = () => ({ eligible: true, reason: 'curated', posting_available: false, posting_paused_reason: 'gas price unavailable' })
    sponsorship.forget(mock.chain, author)
    await sponsorship.require(mock.chain, author)
    assert.equal(requests.length, 2, 'a refresh, or the check after posting, finds a pause')
    handler = healthy
    await step(9_999)
    assert.equal(requests.length, 2)
    await step(1)
    assert.equal(requests.length, 3, 'both composers retry after ten seconds, sharing one request')
    assert.equal(sponsorship.lookup(mock.chain, author).posting_available, true)
    await step(599_999)
    assert.equal(requests.length, 3, 'and the recovered answer stands for its ten minutes')
    await step(1)
    assert.equal(requests.length, 4)
  } finally { stop(); stopOther(); globalThis.document = oldDocument }
  await step(1_200_000)
  assert.equal(requests.length, 4, 'closed composers leave no timers behind')
})

test('a pause seen before the tab was hidden is retried soon after it is shown again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const oldDocument = globalThis.document
  globalThis.document = { visibilityState: 'visible' }
  handler = () => ({ eligible: true, reason: 'curated', posting_available: false, posting_paused_reason: 'gas price unavailable' })
  const step = async ms => { t.mock.timers.tick(ms); await new Promise(setImmediate) }
  const stop = sponsorship.watch(mock.chain, author)
  try {
    await step(0)
    assert.equal(requests.length, 1)
    globalThis.document.visibilityState = 'hidden'
    await step(3_600_000)
    assert.equal(requests.length, 1, 'a hidden tab asks nothing')
    handler = () => ({ eligible: true, reason: 'curated', posting_available: true, posting_paused_reason: null })
    globalThis.document.visibilityState = 'visible'
    await step(60_000)
    assert.equal(requests.length, 2, 'not a full healthy lifetime later')
    assert.equal(sponsorship.lookup(mock.chain, author).posting_available, true)
  } finally { stop(); globalThis.document = oldDocument }
})

test('continued pauses back off together, manual retry bypasses the wait and recovery resets it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const oldDocument = globalThis.document
  globalThis.document = { visibilityState: 'visible' }
  const paused = () => ({ eligible: true, reason: 'curated', posting_available: false, posting_paused_reason: 'gas price unavailable' })
  handler = paused
  const step = async ms => { t.mock.timers.tick(ms); await new Promise(setImmediate) }
  const stop = sponsorship.watch(mock.chain, author), stopOther = sponsorship.watch(mock.chain, author)
  try {
    await step(0)
    for (const delay of [10_000, 30_000, 60_000, 120_000, 120_000]) {
      const count = requests.length
      await step(delay - 1)
      await sponsorship.require(mock.chain, author)
      assert.equal(requests.length, count, 'all readers honor the shared backoff')
      await step(1)
      assert.equal(requests.length, count + 1, 'two composers share one retry')
    }
    handler = () => ({ eligible: true, reason: 'curated', posting_available: true, posting_paused_reason: null })
    const count = requests.length
    sponsorship.forget(mock.chain, author)
    await sponsorship.require(mock.chain, author)
    assert.equal(requests.length, count + 1, 'manual retry does not wait')
    assert.equal(sponsorship.lookup(mock.chain, author).posting_available, true)
    handler = paused
    // The retry timers set during the pause find the new answer and wait out its lifetime.
    await step(120_000)
    await step(479_999)
    assert.equal(requests.length, count + 1, 'the recovered answer stands for ten minutes')
    await step(1)
    assert.equal(requests.length, count + 2)
    await step(9999)
    assert.equal(requests.length, count + 2)
    await step(1)
    assert.equal(requests.length, count + 3, 'a new pause starts with ten seconds')
  } finally { stop(); stopOther(); globalThis.document = oldDocument }
})

test('failed eligibility requests also back off and recover', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  setSponsorName(mock.chain.id, author, 'alice.eth')
  handler = () => response({ error: 'RPC unavailable' }, 502)
  await assert.rejects(sponsorship.require(mock.chain, author))
  for (const delay of [10_000, 30_000, 60_000, 120_000]) {
    const count = requests.length
    t.mock.timers.tick(delay - 1)
    await assert.rejects(sponsorship.require(mock.chain, author))
    assert.equal(requests.length, count)
    t.mock.timers.tick(1)
    await assert.rejects(sponsorship.require(mock.chain, author))
    assert.equal(requests.length, count + 1)
  }
  handler = () => ({ eligible: true, reason: 'ens', posting_available: true, posting_paused_reason: null })
  sponsorship.forget(mock.chain, author)
  assert.equal(await sponsorship.require(mock.chain, author), true)
})


test('name queue exhaustion leaves sponsorship unknown and retryable, not ineligible', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000_000 })
  host.status = { gateway: { names: true } }
  const held = deferred(), otherFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith('/api/names/')) return otherFetch(input, init)
    await held.promise
    return response({ name: 'alice.eth', source: 'ens', avatar: null })
  }
  const pending = Array.from({ length: 512 }, (_, i) => names.hint(`0x${(i + 1).toString(16).padStart(40, '0')}`))
  try {
    await assert.rejects(sponsorship.require(mock.chain, author), /could not look up your name/)
    assert.equal(sponsorship.lookup(mock.chain, author).eligible, null)
  } finally {
    held.resolve()
    await Promise.all(pending)
  }
  t.mock.timers.tick(10_000)
  assert.equal(await sponsorship.require(mock.chain, author), true, 'retries after the short failure pause, not ten minutes')
})

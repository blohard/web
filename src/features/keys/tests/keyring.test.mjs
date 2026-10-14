import assert from 'node:assert/strict'
import { test, beforeEach, after } from 'node:test'
import { load, install, teardown, mock, address, hash } from '../../../../scripts/harness.mjs'
const { readKeyring, sharedKeyring, forgetKeyrings } = await load('features/keys/keyring.ts')
const { pollVisible } = await load('shared/visible-poll.ts')
const { keyTransaction } = await load('features/keys/key-transaction.svelte.ts')
const market = address('77'), holder = address('22'), creator = address('33')
beforeEach(install)
after(teardown)
test('keyring requests the connected wallet and validates its market', async () => {
  let url
  globalThis.fetch = async path => { url = path; return Response.json({ market, truncated: { holders: false, holding: false }, active: true, holders: [creator], holding: [] }) }
  assert.deepEqual(await readKeyring(mock.chain, holder, market), { truncated: { holders: false, holding: false }, active: true, holders: [creator], holding: [] })
  assert.equal(url, `/api/chains/${mock.chain.id}/keyring/${holder}`)
  await assert.rejects(readKeyring(mock.chain, holder, address('88')), /invalid keyring/)
})
test('empty lists differ from failed or malformed responses', async () => {
  globalThis.fetch = async () => Response.json({ market, truncated: { holders: false, holding: false }, active: true, holders: [], holding: [] })
  assert.deepEqual(await readKeyring(mock.chain, holder, market), { truncated: { holders: false, holding: false }, active: true, holders: [], holding: [] })
  globalThis.fetch = async () => Response.json({ error: 'keyring_syncing' }, { status: 503 })
  await assert.rejects(readKeyring(mock.chain, holder, market), /keyring syncing/)
  for (const authors of [[creator, creator], ['not an address'], Array(257).fill(creator), null]) {
    for (const field of ['holders', 'holding']) {
      globalThis.fetch = async () => Response.json({ market, truncated: { holders: false, holding: false }, active: true, holders: [], holding: [], [field]: authors })
      await assert.rejects(readKeyring(mock.chain, holder, market))
    }
  }
})
test('self holdings are excluded from both views while zero-purchase activation is retained', async () => {
  globalThis.fetch = async () => Response.json({ market, truncated: { holders: false, holding: false }, active: true, holders: [holder], holding: [holder, creator] })
  assert.deepEqual(await readKeyring(mock.chain, holder, market), { truncated: { holders: false, holding: false }, active: true, holders: [], holding: [creator] })
  globalThis.fetch = async () => Response.json({ market, truncated: { holders: false, holding: false }, active: false, holders: [], holding: [creator] })
  assert.deepEqual(await readKeyring(mock.chain, holder, market), { truncated: { holders: false, holding: false }, active: false, holders: [], holding: [creator] })
})

test('keyring polling pauses when hidden, avoids overlapping reads, and ignores results after cleanup', async () => {
  const saved = { window: globalThis.window, document: globalThis.document, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  let tick, resolve, reads = 0, updates = 0, cleared = false
  globalThis.window = new EventTarget()
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  globalThis.setInterval = (callback, delay) => { tick = callback; assert.equal(delay, 5000); return 42 }
  globalThis.clearInterval = id => { assert.equal(id, 42); cleared = true }
  try {
    const stop = pollVisible(() => { reads++; return new Promise(r => { resolve = r }) }, () => { updates++ }, assert.fail, 5000)
    await tick()
    assert.equal(reads, 1)
    resolve({ truncated: { holders: false, holding: false }, active: true, holders: [], holding: [] })
    await new Promise(setImmediate)
    assert.equal(updates, 1)
    document.visibilityState = 'hidden'
    await tick()
    assert.equal(reads, 1)
    document.visibilityState = 'visible'
    const pending = tick()
    assert.equal(reads, 2)
    stop()
    resolve({ truncated: { holders: false, holding: false }, active: true, holders: [], holding: [] })
    await pending
    assert.equal(updates, 1)
    assert.equal(cleared, true)
  } finally { Object.assign(globalThis, saved) }
})


test('partial lists preserve the other direction and reject invalid truncation flags', async () => {
  const result = { market, active: true, holders: [creator], holding: [], truncated: { holders: true, holding: false } }
  globalThis.fetch = async () => Response.json(result)
  const read = await readKeyring(mock.chain, holder, market)
  assert.deepEqual(read.truncated, { holders: true, holding: false })
  assert.deepEqual(read.holders, [creator])
  assert.deepEqual(read.holding, [])
  for (const truncated of [undefined, null, {}, { holders: true, holding: 'false' }, { holders: 1, holding: false }]) {
    globalThis.fetch = async () => Response.json({ ...result, truncated })
    await assert.rejects(readKeyring(mock.chain, holder, market), /invalid keyring/)
  }
})

test('views share one keyring read in flight or under a minute old, and polls ask again', async t => {
  forgetKeyrings()
  const realNow = Date.now
  let now = realNow(), calls = 0, active = false
  Date.now = () => now
  t.after(() => { Date.now = realNow })
  globalThis.fetch = async () => { calls++; return Response.json({ market, truncated: { holders: false, holding: false }, active, holders: [], holding: [] }) }
  const [first, second] = await Promise.all([sharedKeyring(mock.chain, holder, market), sharedKeyring(mock.chain, holder, market)])
  assert.equal(first, second)
  assert.equal(calls, 1, 'the navigation links and home share the read in flight')
  now += 59_000
  await sharedKeyring(mock.chain, holder, market)
  assert.equal(calls, 1, 'a page visit within a minute asks nothing')
  active = true
  assert.equal((await sharedKeyring(mock.chain, holder, market, true)).active, true)
  assert.equal(calls, 2, 'a poll asks again')
  assert.equal((await sharedKeyring(mock.chain, holder, market)).active, true, 'and the views after it share its answer')
  assert.equal(calls, 2)
  now += 60_000
  await sharedKeyring(mock.chain, holder, market)
  assert.equal(calls, 3, 'a read a minute old is asked again')
  await sharedKeyring(mock.chain, creator, market)
  await sharedKeyring(mock.chain, holder, address('88')).catch(() => {})
  assert.equal(calls, 5, 'another wallet or market is its own read')
})

test('a failed keyring read is never reused, and a refresh or a confirmed key transaction forgets the last one', async () => {
  forgetKeyrings()
  let calls = 0, fail = true
  globalThis.fetch = async () => {
    calls++
    return fail ? Response.json({ error: 'keyring_syncing' }, { status: 503 })
      : Response.json({ market, truncated: { holders: false, holding: false }, active: true, holders: [], holding: [] })
  }
  await assert.rejects(sharedKeyring(mock.chain, holder, market), /keyring syncing/)
  fail = false
  await sharedKeyring(mock.chain, holder, market)
  assert.equal(calls, 2)
  forgetKeyrings()
  await sharedKeyring(mock.chain, holder, market)
  assert.equal(calls, 3, 'an explicit refresh asks again')
  keyTransaction('keyring-test').confirm(hash('ab'), { active: true, supply: 1n, holdings: 1n, fees: 0n })
  await sharedKeyring(mock.chain, holder, market)
  assert.equal(calls, 4, 'a confirmed key transaction asks again')
})


test('a returning keyring watcher cues membership changes until explicit refresh', async t => {
  const { KeyringView } = await load('features/streams/keyring-view.svelte.ts')
  const saved = { window: globalThis.window, document: globalThis.document, setInterval, clearInterval }
  t.after(() => Object.assign(globalThis, saved))
  globalThis.window = new EventTarget()
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}
  forgetKeyrings()
  const view = new KeyringView()
  let holding = [creator]
  globalThis.fetch = async () => Response.json({ market, active: true, holders: [], holding, truncated: { holders: false, holding: false } })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  let applied = 0
  let stop = view.watch(mock.chain, holder, market, true, false, () => applied++)
  await flush()
  assert.deepEqual(view.shown.holding, [creator], 'initial read still adopts its first snapshot')
  assert.equal(applied, 1)
  stop()
  holding = []
  stop = view.watch(mock.chain, holder, market, true, false, () => applied++)
  await flush()
  assert.deepEqual(view.shown.holding, [creator])
  assert.equal(view.changed('holding'), true)
  assert.equal(applied, 1, 'returning never invalidates the retained stream')
  stop()
  forgetKeyrings()
  stop = view.watch(mock.chain, holder, market, true, true, () => applied++)
  await flush()
  assert.deepEqual(view.shown.holding, [])
  assert.equal(view.changed('holding'), false)
  assert.equal(applied, 2, 'an explicit refresh can invalidate the newly selected feed')
  stop()
})

for (const selected of [true, false]) test(`startup fills the keyring ${selected ? 'stream' : 'tab selector'} without waiting for its poll`, async t => {
  const { KeyringView } = await load('features/streams/keyring-view.svelte.ts')
  const saved = { window: globalThis.window, document: globalThis.document, setInterval, clearInterval }
  // A new browser tab can mount before it becomes visible. Navigation already
  // asks for this snapshot, but Home must still adopt the shared answer.
  globalThis.window = new EventTarget()
  globalThis.document = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} }
  let tick, calls = 0
  globalThis.setInterval = (callback, delay) => { tick = callback; assert.equal(delay, selected ? 30_000 : 300_000); return 1 }
  globalThis.clearInterval = () => {}
  forgetKeyrings()
  globalThis.fetch = async () => {
    calls++
    return Response.json({ market, active: false, holders: [], holding: [creator], truncated: { holders: false, holding: false } })
  }
  const navigation = sharedKeyring(mock.chain, holder, market)
  const view = new KeyringView()
  const stop = view.watch(mock.chain, holder, market, selected, false)
  t.after(() => { stop(); Object.assign(globalThis, saved) })
  await navigation
  document.visibilityState = 'visible'
  await new Promise(setImmediate)
  assert.deepEqual(view.shown?.holding, [creator], 'first display does not wait 30 seconds or five minutes')
  assert.equal(view.available, true, 'the Keyring selector can appear even on another stream')
  assert.equal(calls, 1, 'Home shares the navigation read')
  document.visibilityState = 'hidden'
  await tick()
  assert.equal(calls, 1, 'later background polls still pause')
})

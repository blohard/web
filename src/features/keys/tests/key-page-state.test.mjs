import assert from 'node:assert/strict'
import { test, beforeEach, after } from 'node:test'
import { load, install, teardown, mock, address, deferred } from '../../../../scripts/host-harness.mjs'
const { KeyringView } = await load('features/streams/keyring-view.svelte.ts')
const { sharedKeyring, forgetKeyrings } = await load('features/keys/keyring.ts')
beforeEach(() => { install(); forgetKeyrings() })
after(teardown)
const holder = address('11'), market = address('22'), alice = address('33'), bob = address('44')
const page = (holding) => ({ market, active: true, holders: [], holding, truncated: { holders: false, holding: false } })
const settle = () => new Promise(setImmediate)

function fixture(t) {
  const saved = { window: globalThis.window, document: globalThis.document, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  let tick, interval, stop, reads = 0, result = page([alice]), failure = false
  globalThis.window = new EventTarget()
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  globalThis.setInterval = (fn, ms) => { tick = fn; interval = ms; return 42 }
  globalThis.clearInterval = () => {}
  globalThis.fetch = async () => {
    reads++
    return failure ? Response.json({ error: 'keyring_syncing' }, { status: 503 }) : Response.json(result)
  }
  const view = new KeyringView()
  t.after(() => { stop?.(); Object.assign(globalThis, saved) })
  return {
    view, get reads() { return reads }, get interval() { return interval }, poll: () => tick(),
    answer: value => { result = value }, fail: value => { failure = value },
    watch(selected = true) { stop?.(); stop = view.watch(mock.chain, holder, market, selected) },
    stop() { stop?.() },
  }
}

test('the first keyring read is shared, polls retain displayed membership, and refresh applies it', async t => {
  const f = fixture(t)
  await sharedKeyring(mock.chain, holder, market)
  f.watch(); await settle()
  assert.equal(f.reads, 1, 'reuse the navigation read')
  assert.equal(f.interval, 30_000)
  assert.deepEqual(f.view.shown.holding, [alice])
  f.answer(page([bob]))
  await f.poll()
  assert.equal(f.reads, 2, 'polls bypass the recent cache')
  assert.deepEqual(f.view.shown.holding, [alice])
  assert.equal(f.view.changed('holding'), true)
  forgetKeyrings(); f.watch(); await settle()
  assert.equal(f.reads, 3)
  assert.deepEqual(f.view.shown.holding, [bob])
  assert.equal(f.view.changed('holding'), false)
})

test('keyring polling is slower off its tab and makes no request while hidden', async t => {
  const f = fixture(t)
  f.watch(false); await settle()
  assert.equal(f.interval, 300_000)
  document.visibilityState = 'hidden'
  await f.poll(); assert.equal(f.reads, 1)
  document.visibilityState = 'visible'
  await f.poll(); assert.equal(f.reads, 2)
  f.watch(true); await settle()
  assert.equal(f.interval, 30_000)
})

test('a failed refresh retains its snapshot and the next successful poll completes the refresh', async t => {
  const f = fixture(t)
  f.watch(); await settle()
  f.fail(true); forgetKeyrings(); f.watch(); await settle()
  assert.deepEqual(f.view.shown.holding, [alice])
  assert.ok(f.view.error)
  f.fail(false); f.answer(page([bob])); await f.poll()
  assert.deepEqual(f.view.shown.holding, [bob])
  assert.equal(f.view.error, '')
})

test('a keyring answer arriving after cleanup cannot replace the shown snapshot', async t => {
  const f = fixture(t)
  f.watch(); await settle()
  const held = deferred()
  globalThis.fetch = () => held.promise
  const pending = f.poll()
  f.stop()
  held.resolve(Response.json(page([bob])))
  await pending
  assert.deepEqual(f.view.shown.holding, [alice])
  assert.equal(f.view.changed('holding'), false)
})

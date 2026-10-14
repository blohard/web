// Pictures that open on their own share a few download slots, and a card that leaves stops its own.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, hash } from '../../../../scripts/harness.mjs'
const { Slots } = await load('features/messages/picture-slots.ts')
const { fetchContent } = await load('lib/store.ts')
beforeEach(install)
after(teardown)

test('at most the slot count run at once, the rest start in order as slots come back', async () => {
  const slots = new Slots(2), started = []
  const take = (name) => slots.take(new AbortController().signal).then((release) => { started.push(name); return release })
  const a = await take('a'), b = await take('b')
  const c = take('c'), d = take('d')
  await Promise.resolve()
  assert.deepEqual(started, ['a', 'b'], 'two at once')
  a()
  const releaseC = await c
  assert.deepEqual(started, ['a', 'b', 'c'])
  a()
  await Promise.resolve()
  assert.deepEqual(started, ['a', 'b', 'c'], 'a slot given back twice counts once')
  b()
  await d
  assert.deepEqual(started, ['a', 'b', 'c', 'd'])
  releaseC()
})

test('a picture whose card left while it waited never takes a slot', async () => {
  const slots = new Slots(1)
  const first = await slots.take(new AbortController().signal)
  const gone = new AbortController()
  const waiting = slots.take(gone.signal)
  const next = slots.take(new AbortController().signal)
  gone.abort()
  assert.equal(await waiting, null)
  first()
  assert.equal(typeof await next, 'function', 'the slot went to the next picture still wanted')
  assert.equal(await slots.take(gone.signal), null, 'an already-left card asks for nothing')
})

test('a fetch for a card that left is cancelled', async () => {
  const left = new AbortController()
  let seen
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    seen = init.signal
    init.signal.addEventListener('abort', () => reject(init.signal.reason))
  })
  const read = fetchContent(hash('ab'), undefined, left.signal)
  left.abort()
  const content = await read
  assert.equal(content.ok, false)
  assert.equal(seen.aborted, true, 'the download itself stopped')
})

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown, deferred } from '../../../scripts/harness.mjs'
const { ReadCache } = await load('shared/read-cache.ts')
after(teardown)

test('completed reads use LRU order, expire by their start time, and retain existing values', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const cache = new ReadCache(100, 2)
  let calls = 0
  const read = key => cache.read(key, async () => ({ key, call: ++calls }))
  const first = await read('a'); await read('b')
  assert.equal(await read('a'), first)
  await read('c'); assert.equal(calls, 3)
  assert.equal(await read('a'), first)
  await read('b'); assert.equal(calls, 4)
  t.mock.timers.tick(100)
  assert.notEqual(await read('a'), first)
  assert.equal(first.key, 'a')
})

test('eviction and expiry never lose an in-flight share', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const cache = new ReadCache(100, 1), wait = deferred()
  const pending = cache.read('a', () => wait.promise)
  for (const key of ['b', 'c', 'd']) await cache.read(key, async () => key)
  t.mock.timers.tick(101)
  assert.equal(cache.read('a', assert.fail), pending)
  wait.resolve('old'); assert.equal(await pending, 'old')
  assert.equal(await cache.read('a', async () => 'new'), 'new', 'read that already expired is not kept')
})

for (const failed of [false, true]) for (const settled of [false, true]) test(`a superseded ${failed ? 'failure' : 'success'} cannot change a newer ${settled ? 'answer' : 'flight'}`, async () => {
  const cache = new ReadCache(1000, 2), old = deferred(), newer = deferred()
  const first = cache.read('a', () => old.promise)
  const caught = first.catch(() => 'failed')
  const second = cache.read('a', () => newer.promise, true)
  assert.equal(cache.read('a', assert.fail), second)
  if (settled) { newer.resolve('new'); await second }
  if (failed) old.reject(Error('old failure')); else old.resolve('old')
  await caught
  assert.equal(cache.read('a', assert.fail), second, 'old completion cannot replace or delete a newer read')
  newer.resolve('new'); await second
  assert.equal(await cache.read('a', assert.fail), 'new')
})

test('invalidation prevents an old read from repopulating the cache', async () => {
  const cache = new ReadCache(1000, 2), wait = deferred()
  const pending = cache.read('a', () => wait.promise)
  cache.clear(); wait.resolve('old'); await pending
  assert.equal(await cache.read('a', async () => 'new'), 'new')
})

test('failed and refused reads are retried, while expired entries cannot evict fresh answers', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const cache = new ReadCache(100, 2, value => value !== false)
  await assert.rejects(cache.read('bad', async () => { throw Error('failed') }), /failed/)
  assert.equal(await cache.read('bad', async () => false), false)
  assert.equal(await cache.read('bad', async () => 'good'), 'good')
  t.mock.timers.tick(50)
  await cache.read('b', async () => 'b')
  await cache.read('bad', assert.fail) // The old entry is now most recently used.
  t.mock.timers.tick(50)
  await cache.read('c', async () => 'c')
  assert.equal(await cache.read('b', assert.fail), 'b', 'expiry prunes the old entry before the LRU bound')
})

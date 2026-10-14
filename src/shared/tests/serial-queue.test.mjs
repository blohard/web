import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SerialQueue } from '../serial-queue.ts'

test('queued work runs in order, retains its own result, and continues after failure', async () => {
  const queue = new SerialQueue()
  let release
  const held = new Promise((resolve) => { release = resolve })
  const order = []
  const first = queue.run(async () => { order.push(1); await held; throw new Error('first failed') })
  const failure = assert.rejects(first, /first failed/)
  const second = queue.run(() => { order.push(2); return 'second' })
  const third = queue.run(() => { order.push(3); return 'third' })
  await Promise.resolve()
  assert.deepEqual(order, [1])
  release()
  await failure
  assert.equal(await second, 'second')
  assert.equal(await third, 'third')
  assert.deepEqual(order, [1, 2, 3])
})

test('a completed predecessor cannot detach work still queued behind it', async () => {
  const queue = new SerialQueue()
  let release
  const held = new Promise((resolve) => { release = resolve })
  const order = []
  const first = queue.run(() => 'first')
  const second = queue.run(async () => { order.push(2); await held })
  await first
  await Promise.resolve()
  const third = queue.run(() => { order.push(3) })
  await Promise.resolve()
  assert.deepEqual(order, [2])
  release()
  await Promise.all([second, third])
  assert.deepEqual(order, [2, 3])
  assert.equal(await queue.run(() => 'idle again'), 'idle again')
})

test('a synchronous throw rejects its caller without stopping the queue', async () => {
  const queue = new SerialQueue()
  await assert.rejects(queue.run(() => { throw new Error('sync failure') }), /sync failure/)
  assert.equal(await queue.run(() => 42), 42)
})

test('rows arrive before counts, while the next look waits for counts', async () => {
  const queue = new SerialQueue()
  let release
  const countsReady = new Promise((resolve) => { release = resolve })
  const page = { rows: [1], countsReady }
  const first = queue.run(() => page, (result) => result.countsReady)
  let refreshed = false
  const next = queue.run(() => { refreshed = true; return 'refreshed' })
  assert.equal(await first, page)
  await Promise.resolve()
  assert.equal(refreshed, false)
  release()
  assert.equal(await next, 'refreshed')
})

test('a failed follow-up releases the queue without changing the delivered result', async () => {
  const queue = new SerialQueue()
  const first = queue.run(() => 'rows', async () => { throw new Error('counts failed') })
  const next = queue.run(() => 'next')
  assert.equal(await first, 'rows')
  assert.equal(await next, 'next')
})

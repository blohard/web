import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../scripts/harness.mjs'
const { pollVisible } = await load('shared/visible-poll.ts')
after(teardown)
const flush = () => new Promise((r) => setImmediate(r))

/** A page with controllable visibility, interval and delayed timers. */
function page(t) {
  const saved = { window: globalThis.window, document: globalThis.document, setInterval, clearInterval, setTimeout, clearTimeout }
  t.after(() => Object.assign(globalThis, saved))
  const document = new EventTarget()
  document.visibilityState = 'visible'
  globalThis.document = document
  globalThis.window = new EventTarget()
  const timers = { tick: null, delayed: [] }
  globalThis.setInterval = (callback) => { timers.tick = callback; return 1 }
  globalThis.clearInterval = () => { timers.tick = null }
  globalThis.setTimeout = (callback, ms) => { const timer = { callback, ms }; timers.delayed.push(timer); return timer }
  globalThis.clearTimeout = (timer) => { timers.delayed = timers.delayed.filter((d) => d !== timer) }
  const visibility = (state) => { document.visibilityState = state; document.dispatchEvent(new Event('visibilitychange')) }
  return {
    timers,
    hide() { visibility('hidden'); globalThis.window.dispatchEvent(new Event('blur')) },
    show() { visibility('visible'); globalThis.window.dispatchEvent(new Event('focus')) },
    online() { globalThis.window.dispatchEvent(new Event('online')) },
    /** Fire the single delayed retry, if one is pending. */
    async retry() { const timer = timers.delayed.shift(); assert.ok(timer, 'a retry is pending'); assert.equal(timer.ms, 5_000); timer.callback(); await flush() },
  }
}

/** A read answering from a queue; an Error entry rejects. */
function reader() {
  const answers = [], values = [], failures = []
  const read = async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next }
  return { answers, values, failures, read, update: (v) => values.push(v), failed: (e) => failures.push(e.message) }
}

test('a read that fails on return is tried once more soon, then only at the interval', async (t) => {
  const p = page(t), r = reader()
  const stop = pollVisible(r.read, r.update, r.failed, 30_000, false)
  r.answers.push(new Error('offline'), 3)
  p.hide(); p.show(); await flush()
  assert.deepEqual(r.failures, ['offline'])
  assert.equal(p.timers.delayed.length, 1, 'one retry is scheduled after the failed return read')
  await p.retry()
  assert.deepEqual(r.values, [3], 'the retry answers without waiting for the interval')
  assert.equal(p.timers.delayed.length, 0, 'a successful retry schedules nothing more')

  r.answers.push(new Error('still offline'), new Error('still offline'), 5)
  p.hide(); p.show(); await flush()
  await p.retry()
  assert.deepEqual(r.failures, ['offline', 'still offline', 'still offline'])
  assert.equal(p.timers.delayed.length, 0, 'a failed retry leaves the next read to the interval')
  p.timers.tick(); await flush()
  assert.deepEqual(r.values, [3, 5])

  r.answers.push(new Error('interval failure'))
  p.timers.tick(); await flush()
  assert.equal(p.timers.delayed.length, 0, 'an interval failure never schedules a retry')
  stop()
})

test('connectivity returning reads again, and only while the page is visible', async (t) => {
  const p = page(t), r = reader()
  const stop = pollVisible(r.read, r.update, r.failed, 30_000, false)
  r.answers.push(1)
  p.online(); await flush()
  assert.deepEqual(r.values, [1], 'online counts as a return')
  p.hide()
  r.answers.push(2)
  p.online(); await flush()
  assert.deepEqual(r.values, [1], 'a hidden page does not read when connectivity returns')
  p.show(); await flush()
  assert.deepEqual(r.values, [1, 2])
  stop()
})

test('cleanup cancels a pending retry and a return read never overlaps a running one', async (t) => {
  const p = page(t), r = reader()
  let finish
  const slow = () => new Promise((resolve) => { finish = resolve })
  const stop = pollVisible(slow, r.update, r.failed, 30_000, true)
  p.hide(); p.show(); await flush()
  assert.equal(p.timers.delayed.length, 0, 'a running read is not retried')
  finish(7); await flush()
  assert.deepEqual(r.values, [7])
  finish(8); await flush()
  assert.deepEqual(r.values, [7, 8], 'the return remembered while the first read ran is served once it finishes')
  stop()

  const again = reader()
  const stopAgain = pollVisible(again.read, again.update, again.failed, 30_000, false)
  again.answers.push(new Error('offline'))
  p.hide(); p.show(); await flush()
  assert.equal(p.timers.delayed.length, 1)
  stopAgain()
  assert.equal(p.timers.delayed.length, 0, 'cleanup cancels the pending retry')
})

for (const fails of [false, true]) test(`connectivity returning during a visible interval read rechecks after it ${fails ? 'fails' : 'succeeds'}`, async t => {
  const p = page(t)
  let finish, reject, calls = 0
  const values = [], failures = []
  const stop = pollVisible(() => {
    calls++
    return calls === 1 ? new Promise((resolve, fail) => { finish = resolve; reject = fail }) : Promise.resolve(2)
  }, value => values.push(value), error => failures.push(error.message), 30_000, false)
  p.timers.tick()
  p.online(); p.online()
  assert.equal(calls, 1, 'reconnections never overlap the outstanding read')
  if (fails) reject(new Error('old connection failed'))
  else finish(1)
  await flush()
  assert.equal(calls, 2, 'reconnections queue one fresh check without waiting for the interval')
  assert.deepEqual(values, fails ? [2] : [1, 2])
  assert.deepEqual(failures, fails ? ['old connection failed'] : [])
  assert.equal(p.timers.delayed.length, 0)
  stop()
})

for (const source of ['interval', 'online']) test(`an earlier ${source} check cancels the delayed return retry`, async t => {
  const p = page(t), r = reader()
  const stop = pollVisible(r.read, r.update, r.failed, 30_000, false)
  r.answers.push(new Error('offline'), 4)
  p.hide(); p.show(); await flush()
  assert.equal(p.timers.delayed.length, 1)
  if (source === 'interval') p.timers.tick()
  else p.online()
  await flush()
  assert.deepEqual(r.values, [4])
  assert.equal(p.timers.delayed.length, 0, 'a successful earlier check needs no extra retry')
  stop()
})

test('a delayed retry does not read after the page is hidden', async t => {
  const p = page(t), r = reader()
  const stop = pollVisible(r.read, r.update, r.failed, 30_000, false)
  r.answers.push(new Error('offline'), 6)
  p.hide(); p.show(); await flush()
  p.hide()
  await p.retry()
  assert.deepEqual(r.values, [])
  assert.deepEqual(r.answers, [6], 'the hidden page makes no read')
  p.show(); await flush()
  assert.deepEqual(r.values, [6], 'the next return still reads immediately')
  stop()
})

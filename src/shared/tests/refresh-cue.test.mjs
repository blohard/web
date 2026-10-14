import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../scripts/harness.mjs'
const { refreshCue } = await load('shared/refresh-cue.svelte.ts')
after(teardown)
const flush = () => new Promise((r) => setImmediate(r))

test('quiet polling shares an outstanding look, preserves cues on failure and ignores a departed view', async (t) => {
  const saved = { window: globalThis.window, document: globalThis.document, setInterval, clearInterval }
  t.after(() => Object.assign(globalThis, saved))
  globalThis.window = new EventTarget()
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  let tick
  globalThis.setInterval = (callback) => { tick = callback; return 1 }
  globalThis.clearInterval = () => {}
  let finish, fail, calls = 0
  const stop = refreshCue.poll(() => { calls++; return new Promise((resolve, reject) => { finish = resolve; fail = reject }) })
  tick(); tick(); tick()
  assert.equal(calls, 1)
  finish(4); await flush()
  assert.equal(refreshCue.count, 4)
  tick(); fail(new Error('offline')); await flush()
  assert.equal(refreshCue.count, 4)
  tick()
  stop()
  const stopNext = refreshCue.poll(async () => 2)
  tick(); await flush()
  finish(9); await flush()
  assert.equal(refreshCue.count, 2)
  globalThis.document.visibilityState = 'hidden'
  tick(); await flush()
  assert.equal(refreshCue.count, 2)
  stopNext()
})

test('membership-only changes highlight refresh independently of post counts', () => {
  let pending = true
  const stop = refreshCue.cueChanges(() => pending)
  refreshCue.clear()
  assert.equal(refreshCue.highlighted, true)
  const count = refreshCue.cueCount(3)
  pending = false
  assert.equal(refreshCue.highlighted, true)
  refreshCue.clear()
  assert.equal(refreshCue.highlighted, false)
  pending = true; stop(); count.stop()
  assert.equal(refreshCue.changed, false, 'a view that left no longer cues refresh')
})


for (const lateBeforeCleanup of [true, false]) test(`a new page owns its cue when an old poll finishes ${lateBeforeCleanup ? 'before' : 'after'} cleanup`, async t => {
  const saved = { window: globalThis.window, document: globalThis.document, setInterval, clearInterval }
  globalThis.window = new EventTarget()
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  let tick, finish
  globalThis.setInterval = callback => { tick = callback; return 1 }
  globalThis.clearInterval = () => {}
  const stopOld = refreshCue.poll(() => new Promise(resolve => { finish = resolve }))
  tick()
  const stopNew = refreshCue.poll(async () => 2)
  t.after(() => { stopOld(); stopNew(); Object.assign(globalThis, saved) })
  await tick()
  assert.equal(refreshCue.count, 2)
  if (lateBeforeCleanup) { finish(9); await flush(); assert.equal(refreshCue.count, 2, 'the old answer cannot overwrite the new page') }
  stopOld()
  assert.equal(refreshCue.count, 2, 'the old cleanup cannot erase the new page')
  if (!lateBeforeCleanup) { finish(9); await flush(); assert.equal(refreshCue.count, 2) }
})


test('returning to a visible tab checks immediately, shares a running poll and removes the listener on departure', async t => {
  const saved = { window: globalThis.window, document: globalThis.document, setInterval, clearInterval }
  t.after(() => Object.assign(globalThis, saved))
  const listeners = new Set()
  let tick, finish, calls = 0
  globalThis.window = new EventTarget()
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (kind, callback) => { assert.equal(kind, 'visibilitychange'); listeners.add(callback) },
    removeEventListener: (kind, callback) => listeners.delete(callback),
  }
  globalThis.setInterval = callback => { tick = callback; return 1 }
  globalThis.clearInterval = () => {}
  const visibility = state => { document.visibilityState = state; for (const callback of listeners) callback() }
  const stop = refreshCue.poll(() => { calls++; return new Promise(resolve => { finish = resolve }) })
  visibility('hidden'); tick()
  assert.equal(calls, 0, 'hidden streams do not poll')
  visibility('visible')
  assert.equal(calls, 1, 'return does not wait for the next interval')
  tick(); visibility('visible')
  assert.equal(calls, 1, 'a running read is shared')
  finish(3); await flush()
  assert.equal(refreshCue.count, 3)
  visibility('hidden'); visibility('visible')
  assert.equal(calls, 2)
  stop(); finish(8); await flush()
  assert.equal(listeners.size, 0)
  assert.equal(refreshCue.count, 0, 'departed views cannot publish late answers')
})


test('returning to a still-visible window checks immediately without overlapping visibility or timer checks', async t => {
  const saved = { window: globalThis.window, document: globalThis.document, setInterval, clearInterval }
  t.after(() => Object.assign(globalThis, saved))
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  let tick, finish, calls = 0
  globalThis.setInterval = callback => { tick = callback; return 1 }
  globalThis.clearInterval = () => {}
  const stop = refreshCue.poll(() => { calls++; return new Promise(resolve => { finish = resolve }) })
  window.dispatchEvent(new Event('focus'))
  assert.equal(calls, 1, 'window focus does not need a visibility transition')
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus')); tick()
  assert.equal(calls, 1, 'one outstanding read covers the return events')
  finish(3); await flush()
  assert.equal(refreshCue.count, 3)
  document.visibilityState = 'hidden'
  window.dispatchEvent(new Event('focus')); tick()
  assert.equal(calls, 1, 'focus does not poll a hidden stream')
  document.visibilityState = 'visible'
  stop()
  window.dispatchEvent(new Event('focus'))
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(calls, 1, 'departed views unregister both events')
})

for (const returningVia of ['window', 'tab']) for (const rejects of [false, true]) {
  test(`returning via ${returningVia} rechecks after an older poll ${rejects ? 'fails' : 'finishes'}`, async t => {
    const saved = { window: globalThis.window, document: globalThis.document, setInterval, clearInterval }
    globalThis.window = new EventTarget()
    globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    let tick, finish, fail, calls = 0
    globalThis.setInterval = callback => { tick = callback; return 1 }
    globalThis.clearInterval = () => {}
    const stop = refreshCue.poll(() => {
      calls++
      return new Promise((resolve, reject) => { finish = resolve; fail = reject })
    })
    t.after(() => { stop(); Object.assign(globalThis, saved) })
    tick()
    const oldFinish = finish
    if (returningVia === 'window') window.dispatchEvent(new Event('blur'))
    else {
      document.visibilityState = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
    }
    // The old response was captured before the reader left. Returning must
    // eventually read again, even if the browser resumes that response late.
    document.visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    tick()
    assert.equal(calls, 1, 'return events never overlap the outstanding read')
    if (rejects) fail(new Error('suspended request failed'))
    else oldFinish(0)
    await flush()
    assert.equal(calls, 2, 'return is checked without waiting for another interval')
    finish(1); await flush()
    assert.equal(refreshCue.count, 1)
    assert.equal(calls, 2, 'paired return events share the fresh read')
  })
}

for (const departure of ['hidden', 'unmounted']) test(`a queued return check stops when the view is ${departure}`, async t => {
  const saved = { window: globalThis.window, document: globalThis.document, setInterval, clearInterval }
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  let tick, finish, calls = 0
  globalThis.setInterval = callback => { tick = callback; return 1 }
  globalThis.clearInterval = () => {}
  const stop = refreshCue.poll(() => { calls++; return new Promise(resolve => { finish = resolve }) })
  t.after(() => { stop(); Object.assign(globalThis, saved) })
  tick()
  window.dispatchEvent(new Event('blur'))
  window.dispatchEvent(new Event('focus'))
  if (departure === 'hidden') {
    document.visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
  } else stop()
  finish(0); await flush()
  assert.equal(calls, 1, 'no queued read starts after leaving')
  if (departure === 'hidden') {
    document.visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(calls, 2, 'the next return still checks immediately')
    finish(1); await flush()
  } else {
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
    assert.equal(calls, 1)
    assert.equal(refreshCue.count, 0)
  }
})

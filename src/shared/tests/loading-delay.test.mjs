import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactiveFixture } from '../../../scripts/svelte-test.mjs'
const { spinner, flushSync } = await reactiveFixture(new URL('./fixtures/loading-delay.svelte.ts', import.meta.url))

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = spinner()
  t.after(view.stop)
  const set = key => { view.set(key); flushSync() }
  const tick = ms => { t.mock.timers.tick(ms); flushSync() }
  flushSync()
  return { view, set, tick }
}

test('loading waits 300 ms, and one identity covers consecutive loading steps', t => {
  const { view, set, tick } = fixture(t)
  tick(1000); assert.equal(view.ready, false)
  set('keys'); tick(200); assert.equal(view.ready, false)
  set('keys'); tick(99); assert.equal(view.ready, false, 'the module-to-data handoff uses the same identity')
  tick(1); assert.equal(view.ready, true)
  set(null); assert.equal(view.ready, false, 'completion hides it immediately')
})

test('switches cancel old timers and returning to an earlier identity starts fresh', t => {
  const { view, set, tick } = fixture(t)
  set('A'); tick(300); assert.equal(view.ready, true)
  set('B'); assert.equal(view.ready, false)
  tick(200); set('A'); assert.equal(view.ready, false, 'an earlier A cannot reveal this visit')
  tick(100); assert.equal(view.ready, false, 'the cancelled B timer cannot reveal A')
  tick(200); assert.equal(view.ready, true)
  set(null); set('A'); assert.equal(view.ready, false, 'another paging operation gets its own delay')
})

test('unmount cancels the pending indicator', t => {
  const { view, set, tick } = fixture(t)
  set('A'); tick(200); view.stop(); tick(200)
  assert.equal(view.ready, false)
})

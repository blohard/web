import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactiveFixture } from '../../../../scripts/svelte-test.mjs'
const { quoteView, flushSync } = await reactiveFixture(new URL('./fixtures/key-quotes.svelte.ts', import.meta.url))
const wait = async () => { flushSync(); await new Promise(resolve => setTimeout(resolve, 220)); flushSync() }
const settle = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); flushSync() } }
test('quotes debounce edits, hide old results immediately and ignore stale completions', async () => {
  const calls = [], completions = new Map()
  const view = quoteView(amount => { calls.push(amount); return new Promise(resolve => completions.set(amount, resolve)) })
  try {
    flushSync(); view.set(2); flushSync(); view.set(3); await wait()
    assert.deepEqual(calls, [3])
    view.set(4); await wait()
    completions.get(4)(40); await settle(); assert.equal(view.value, 40)
    completions.get(3)(30); await settle(); assert.equal(view.value, 40)
    view.set(5); flushSync(); assert.equal(view.value, null)
    view.disable(); await wait(); assert.deepEqual(calls, [3, 4])
    assert.equal(view.value, null)
  } finally { view.stop() }
})
test('a failed quote can be retried by changing input, and unmount cancels the debounce', async () => {
  let calls = 0
  const view = quoteView(async n => { calls++; if (n === 1) throw Error('quote unavailable'); return n })
  await wait(); assert.match(view.error, /quote unavailable/)
  view.set(2); flushSync(); assert.equal(view.error, '')
  await wait(); assert.equal(view.value, 2)
  view.set(3); flushSync(); view.stop(); await wait(); assert.equal(calls, 2)
})

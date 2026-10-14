import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, address, hash } from './harness.mjs'
const { relayPost, requestFaucet, faucetStatus, RelayError } = await load('features/publishing/relay.ts')
const { relayStatus } = await load('lib/relay-status.ts')
const { publish, fetchContent, getStatus } = await load('lib/store.ts')
beforeEach(install)
after(teardown)

for (const bodyStarted of [false, true]) {
  test(`host requests time out ${bodyStarted ? 'during the body' : 'before headers'} without claiming a send was refused`, async (t) => {
    const timeout = AbortSignal.timeout
    t.after(() => { AbortSignal.timeout = timeout })
    let controller, duration
    AbortSignal.timeout = (ms) => { duration = ms; controller = new AbortController(); return controller.signal }
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.signal, controller.signal)
      if (!bodyStarted) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
      return new Response(new ReadableStream({ start(stream) {
        init.signal.addEventListener('abort', () => stream.error(init.signal.reason))
      } }))
    }
    const cases = [
      [() => relayPost(1, { author: address('aa') }), 60000, 'unknown'],
      [() => requestFaucet(1, address('aa')), 60000, 'unknown'],
      [() => publish(new Uint8Array([1]), 1, { messageId: 1n }), 60000, 'reject'],
      [() => fetchContent(hash('aa')), 60000, 'content'],
      [() => getStatus(), 20000, 'reject'],
      // A relayer that does not answer is asked again, never taken for none.
      [() => relayStatus(), 20000, 'reject'],
      [() => faucetStatus(1, address('aa')), 20000, 'reject'],
    ]
    for (const [run, ms, result] of cases) {
      const promise = run()
      const checked = result === 'unknown' ? assert.rejects(promise, (e) => e instanceof RelayError && e.outcome === 'unknown')
        : result === 'reject' ? assert.rejects(promise) : promise
      assert.equal(duration, ms)
      controller.abort(new DOMException('deadline', 'TimeoutError'))
      const answer = await checked
      if (result === 'content') assert.equal(answer.reason, 'error')
    }
  })
}

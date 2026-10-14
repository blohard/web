import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, bigBody, teardown } from '../../../scripts/harness.mjs'
const { responseBytes, ResponseTooLarge } = await load('shared/response-bytes.ts')
const { responseJson, errorMessage } = await load('shared/response-json.ts')
after(teardown)

test('bounded bodies refuse declared sizes before reading and cancel dishonest streams', async () => {
  for (const declared of [1000, undefined, 1]) {
    const body = bigBody(1000)
    const response = new Response(body.stream, { headers: declared ? { 'content-length': String(declared) } : {} })
    await assert.rejects(responseBytes(response, 100), ResponseTooLarge)
    assert.equal(body.state.cancelled, true)
    if (declared === 1000) assert.equal(body.state.pulled, 0)
    assert.equal(response.body.locked, false)
  }
})

test('bounded bodies preserve bytes and release their reader on completion or network failure', async () => {
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close() },
  }))
  assert.deepEqual(await responseBytes(response, 3), new Uint8Array([1, 2, 3]))
  assert.equal(response.body.locked, false)
  assert.equal(await responseBytes(new Response(null), 3), null)
  const failure = new Error('network failed')
  const broken = new Response(new ReadableStream({ pull(controller) { controller.error(failure) } }))
  await assert.rejects(responseBytes(broken, 3), (error) => error === failure)
  assert.equal(broken.body.locked, false)
})

test('JSON decoding shares the byte bound and leaves interpretation to the caller', async () => {
  const answer = { error: 'busy', outcome: 'refused' }
  const response = new Response(JSON.stringify(answer), { status: 503, statusText: 'unavailable' })
  const decoded = await responseJson(response)
  assert.deepEqual(decoded, answer)
  assert.equal(response.bodyUsed, true)
  assert.equal(errorMessage(response, decoded), 'busy')
  assert.equal(errorMessage(response, { error: { detail: 'not a message' } }), 'unavailable')
  await assert.rejects(responseJson(new Response('<html>proxy failure</html>')), SyntaxError)
  const body = bigBody(1000)
  await assert.rejects(responseJson(new Response(body.stream), 100), ResponseTooLarge)
  assert.equal(body.state.cancelled, true)
})

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, response } from '../../../../scripts/harness.mjs'
const { publishWithRetry, hashOf } = await load('lib/store.ts')
beforeEach(install)
after(teardown)
const bytes = new TextEncoder().encode('version/1 text/plain\nhello')

test('a refused upload waits for Retry-After and retries identical bytes and proof', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, bytes: new Uint8Array(init.body) })
    if (calls.length > 1) return response({ hash: hashOf(bytes), stored: true })
    const refused = response({ error: 'visitor_read_limit' }, 429)
    refused.headers.set('retry-after', '2')
    return refused
  }
  const result = publishWithRetry(bytes, 84532, { messageId: 1n })
  result.catch(() => {})
  await new Promise(setImmediate)
  t.mock.timers.tick(1999)
  await new Promise(setImmediate)
  assert.equal(calls.length, 1)
  t.mock.timers.tick(1)
  assert.equal((await result).stored, true)
  assert.deepEqual(calls[1], calls[0])
})

test('persistent refusal has bounded retries and malformed backoff uses two seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    const refused = response({ error: 'visitor_read_limit' }, 429)
    refused.headers.set('retry-after', 'invalid')
    return refused
  }
  const result = assert.rejects(publishWithRetry(bytes, 84532, { messageId: 1n }), /visitor_read_limit/)
  await new Promise(setImmediate)
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(calls, attempt)
    t.mock.timers.tick(2000)
    await new Promise(setImmediate)
  }
  await result
  assert.equal(calls, 4)
})

test('invalid proofs are not retried', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return response({ error: 'invalid proof' }, 403) }
  await assert.rejects(publishWithRetry(bytes, 84532, { messageId: 1n }), /invalid proof/)
  assert.equal(calls, 1)
})

test('a busy host is asked again with growing delays, and a lasting one ends the retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return calls < 3 ? response({ error: 'the host is busy; try again shortly' }, 503) : response({ hash: hashOf(bytes), stored: true })
  }
  const result = publishWithRetry(bytes, 84532, { messageId: 1n })
  result.catch(() => {})
  for (const [delay, before] of [[1000, 1], [2000, 2]]) {
    await new Promise(setImmediate)
    assert.equal(calls, before)
    t.mock.timers.tick(delay)
  }
  assert.equal((await result).stored, true)
  assert.equal(calls, 3)

  calls = 0
  globalThis.fetch = async () => { calls++; return response({ error: 'the host is busy; try again shortly' }, 503) }
  const lasting = assert.rejects(publishWithRetry(bytes, 84532, { messageId: 1n }), /busy/)
  for (const delay of [1000, 2000, 3000]) {
    await new Promise(setImmediate)
    t.mock.timers.tick(delay)
  }
  await lasting
  assert.equal(calls, 4, 'three retries, then the upload waits for recovery')
})

test('a busy host that names its wait is asked again only after it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls > 1) return response({ hash: hashOf(bytes), stored: true })
    const refused = response({ error: 'the host is busy; try again shortly' }, 503)
    refused.headers.set('retry-after', '10')
    return refused
  }
  const result = publishWithRetry(bytes, 84532, { messageId: 1n })
  result.catch(() => {})
  await new Promise(setImmediate)
  t.mock.timers.tick(9999)
  await new Promise(setImmediate)
  assert.equal(calls, 1, 'not after the one second a silent 503 waits')
  t.mock.timers.tick(1)
  assert.equal((await result).stored, true)
  assert.equal(calls, 2)
})

test('an upload is checked against the hash the post names, not a fresh hash of the bytes sent', async () => {
  // The host stores what it received and reports that hash. Bytes changed since the
  // post named them (a damaged recovery copy) fail loudly, whatever the host says.
  globalThis.fetch = async (_, init) => response({ hash: hashOf(new Uint8Array(init.body)), stored: true })
  assert.equal((await publishWithRetry(bytes, 84532, { messageId: 1n }, hashOf(bytes))).stored, true)
  const named = hashOf(new TextEncoder().encode('version/1 text/plain\nthe post as named'))
  await assert.rejects(publishWithRetry(bytes, 84532, { messageId: 1n }, named), new RegExp(`expected ${named}`))
})

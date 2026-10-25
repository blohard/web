// Bodies are fetched at most once per hash every five minutes; a miss or a
// takedown is asked for again.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { keccak256 } from 'viem'
import { load, mock, install, teardown, hash, deferred } from './harness.mjs'

const { loadBody } = await load('lib/content.ts')
beforeEach(install)
after(teardown)
const contentReads = () => mock.calls.filter((c) => c.method === 'content').length

test('a body that arrived is kept; one the host lacked is asked for again until it arrives', async () => {
  const bytes = new TextEncoder().encode('version/1 text/plain\nhello there\n')
  const digest = keccak256(bytes)
  const anchor = { chainId: mock.chain.id, messageId: 1n }
  const missing = hash('ab')
  assert.equal((await loadBody(missing, anchor)).kind, 'missing')
  assert.equal((await loadBody(missing, anchor)).kind, 'missing')
  assert.equal(contentReads(), 2, 'a miss is not remembered')
  mock.bodies.set(digest.toLowerCase(), bytes)
  const first = await loadBody(digest, anchor)
  assert.equal(first.kind, 'text')
  assert.equal(first.text.trim(), 'hello there')
  const again = await loadBody(digest, anchor)
  assert.equal(again, first, 'the same interpreted body, not fetched or parsed again')
  assert.equal(contentReads(), 3)
  mock.bodies.set(missing.toLowerCase(), bytes)
  assert.equal((await loadBody(missing, anchor)).kind, 'mismatch', 'bytes that do not hash to the name are refused, and not kept either')
  assert.equal(contentReads(), 4)
})

test('a taken-down body says so, is not kept, and loads again once restored', async () => {
  const bytes = new TextEncoder().encode('version/1 text/plain\nreported words\n')
  const digest = keccak256(bytes)
  const anchor = { chainId: mock.chain.id, messageId: 1n }
  mock.bodies.set(digest.toLowerCase(), bytes)
  mock.takenDown.add(digest.toLowerCase())
  assert.equal((await loadBody(digest, anchor)).kind, 'taken-down')
  assert.equal((await loadBody(digest, anchor)).kind, 'taken-down', 'asked again, and still refused')
  assert.equal(contentReads(), 2)
  mock.takenDown.delete(digest.toLowerCase())
  assert.equal((await loadBody(digest, anchor)).kind, 'text', 'restored on the next ask')
})

test('a kept body is asked for again after five minutes, so a takedown reaches later reads', async () => {
  const bytes = new TextEncoder().encode('version/1 text/plain\nwords that go\n')
  const digest = keccak256(bytes)
  const anchor = { chainId: mock.chain.id, messageId: 1n }
  mock.bodies.set(digest.toLowerCase(), bytes)
  const now = Date.now
  try {
    let clock = now()
    Date.now = () => clock
    assert.equal((await loadBody(digest, anchor)).kind, 'text')
    clock += 4 * 60_000
    assert.equal((await loadBody(digest, anchor)).kind, 'text')
    assert.equal(contentReads(), 1, 'still fresh')
    mock.takenDown.add(digest.toLowerCase())
    clock += 2 * 60_000
    assert.equal((await loadBody(digest, anchor)).kind, 'taken-down')
    assert.equal(contentReads(), 2)
  } finally { Date.now = now }
})


test('body eviction bounds retained answers without losing an outstanding read', async () => {
  const anchor = { chainId: mock.chain.id, messageId: 1n }
  const add = i => {
    const bytes = new TextEncoder().encode(`version/1 text/plain\nbounded body ${i}`)
    const digest = keccak256(bytes); mock.bodies.set(digest, bytes); return digest
  }
  const started = deferred(), release = deferred(), pendingHash = add('pending')
  mock.onContent = async url => { if (url.includes(pendingHash)) { started.resolve(); await release.promise } }
  const pending = loadBody(pendingHash, anchor)
  await started.promise
  try {
    const oldest = add(0)
    const retained = await loadBody(oldest, anchor)
    for (let i = 1; i <= 512; i++) await loadBody(add(i), anchor)
    assert.equal(loadBody(pendingHash, anchor), pending, 'eviction must not lose an in-flight share')
    const reads = contentReads()
    assert.equal((await loadBody(oldest, anchor)).kind, 'text')
    assert.equal(contentReads(), reads + 1, 'the oldest completed body was evicted')
    assert.equal(retained.text, 'bounded body 0', 'existing cards retain their body')
  } finally { release.resolve(); await pending }
})

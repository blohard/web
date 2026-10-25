// Untrusted avatar bytes are bounded before display, including cached types.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, address, bigBody } from './harness.mjs'
const { Avatars } = await load('lib/avatars.ts')
const { tx, STORES } = await load('lib/db.ts')
let avatars
beforeEach(() => { install(); avatars = new Avatars() })
after(teardown)

test('a changed avatar URL has its own flight and an old completion cannot replace it', async () => {
  const who = address('a7'), old = 'https://pics.invalid/previous', current = 'https://pics.invalid/current'
  let release, started
  const waiting = new Promise((r) => { started = r })
  const calls = [], referrers = []
  globalThis.fetch = async (url, init) => {
    calls.push(url); referrers.push(init?.referrerPolicy)
    if (url === old) { started(); await new Promise((r) => { release = r }) }
    return new Response(url, { headers: { 'content-type': 'image/png' } })
  }
  const pending = avatars.read(who, old); await waiting
  const latest = await avatars.read(who, current)
  assert.equal(await latest.text(), current)
  release()
  const previous = await pending
  assert.notEqual(previous, latest)
  assert.equal(await avatars.read(who, current), latest)
  assert.deepEqual(calls, [old, current])
  assert.deepEqual(referrers, ['no-referrer', 'no-referrer'], 'the owner\'s server is not told where the reader came from')
})

test('an avatar over the size limit is refused without being downloaded, and shows the identicon', async () => {
  const bodies = {}
  globalThis.fetch = async (url) => {
    const b = bodies[url]
    return new Response(b.stream, { headers: { 'content-type': 'image/png', ...(b.length ? { 'content-length': String(b.length) } : {}) } })
  }
  // An honest length: refused before a byte is read.
  const honest = bigBody(2 << 20); bodies['https://pics.invalid/honest'] = { stream: honest.stream, length: 2 << 20 }
  assert.equal(await avatars.read(address('a1'), 'https://pics.invalid/honest'), false)
  assert.equal(honest.state.pulled, 0)
  // No length: read until the limit, then cancelled, well short of the whole body.
  const sneaky = bigBody(2 << 20); bodies['https://pics.invalid/sneaky'] = { stream: sneaky.stream }
  assert.equal(await avatars.read(address('a2'), 'https://pics.invalid/sneaky'), false)
  assert.ok(sneaky.state.pulled <= (1 << 20) + (1 << 16), `read ${sneaky.state.pulled} bytes`)
  assert.equal(sneaky.state.cancelled, true)
  // A small picture is kept.
  const small = bigBody(1000); bodies['https://pics.invalid/small'] = { stream: small.stream, length: 1000 }
  assert.equal((await avatars.read(address('a3'), 'https://pics.invalid/small')).size, 1000)
})

test('an SVG avatar is refused, fresh or cached', async () => {
  globalThis.fetch = async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } })
  assert.equal(await avatars.read(address('a4'), 'https://pics.invalid/vector.svg'), false)
  // A cached SVG from before the rule is not shown either.
  const who = address('a5')
  await tx(STORES.avatars, 'readwrite', (s) => s.put({ address: who, url: 'https://pics.invalid/old.svg', blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }), fetchedAt: Date.now() }))
  assert.equal(await avatars.read(who, 'https://pics.invalid/old.svg'), false)
  // Nor one whose cached type carries a parameter, as earlier code could store it.
  const charset = address('a6')
  await tx(STORES.avatars, 'readwrite', (s) => s.put({ address: charset, url: 'https://pics.invalid/old2.svg', blob: new Blob(['<svg/>'], { type: 'image/svg+xml;charset=utf-8' }), fetchedAt: Date.now() }))
  assert.equal(await avatars.read(charset, 'https://pics.invalid/old2.svg'), false)
})

test('a failed avatar is asked about again after an hour, not kept for the life of the tab', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 400_000_000 })
  const who = address('b5'), url = 'https://pics.invalid/flaky'
  let calls = 0, down = true
  globalThis.fetch = async () => {
    calls++
    if (down) throw new TypeError('network blip')
    return new Response('png', { headers: { 'content-type': 'image/png' } })
  }
  assert.equal(await avatars.read(who, url), null)
  assert.equal(calls, 1)
  down = false
  t.mock.timers.tick(60 * 60_000 - 1)
  assert.equal(await avatars.read(who, url), null)
  await new Promise(setImmediate)
  assert.equal(calls, 1, 'kept for the hour')
  t.mock.timers.tick(1)
  assert.ok(await avatars.read(who, url) instanceof Blob)
  assert.equal(calls, 2)
})

test('the cache keeps a week of reading: expired entries are dropped the first time it is used', async () => {
  const day = 24 * 60 * 60_000
  const stale = address('b1'), fresh = address('b2'), freshUrl = 'https://pics.invalid/fresh.png'
  const png = () => new Blob(['png'], { type: 'image/png' })
  await tx(STORES.avatars, 'readwrite', (s) => {
    s.put({ address: stale, url: 'https://pics.invalid/stale.png', blob: png(), fetchedAt: Date.now() - 8 * day })
    s.put({ address: fresh, url: freshUrl, blob: png(), fetchedAt: Date.now() - 6 * day })
  })
  const calls = []
  globalThis.fetch = async (url) => { calls.push(url); return new Response('png', { headers: { 'content-type': 'image/png' } }) }
  const cache = new Avatars()
  assert.ok(await cache.read(fresh, freshUrl) instanceof Blob, 'the fresh entry is served from disk')
  assert.deepEqual(calls, [], 'without a fetch')
  const kept = await tx(STORES.avatars, 'readonly', (s) => s.getAllKeys())
  assert.deepEqual(kept, [fresh], 'the expired entry is gone')
})

test('mounted readers share one download and receive the same blob without creating URLs', async (t) => {
  t.mock.method(URL, 'createObjectURL', () => { throw Error('the cache must not own object URLs') })
  let calls = 0, release
  const wait = new Promise(resolve => { release = resolve })
  globalThis.fetch = async () => { calls++; await wait; return new Response('png', { headers: { 'content-type': 'image/png' } }) }
  const who = address('b7'), url = 'https://pics.invalid/shared'
  const first = avatars.read(who, url), second = avatars.read(who.toUpperCase(), url)
  assert.equal(first, second, 'same pending read')
  release()
  const blob = await first
  assert.ok(blob instanceof Blob)
  assert.equal(await second, blob)
  assert.equal(await avatars.read(who, url), blob)
  assert.equal(calls, 1)
})

test('a disk hit keeps its original age in memory and expires after seven days', async (t) => {
  const day = 24 * 60 * 60_000, now = 20 * day
  t.mock.timers.enable({ apis: ['Date'], now })
  const who = address('b8'), url = 'https://pics.invalid/aging'
  await tx(STORES.avatars, 'readwrite', s => s.put({ address: who, url, blob: new Blob(['old'], { type: 'image/png' }), fetchedAt: now - 6 * day }))
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('new', { headers: { 'content-type': 'image/png' } }) }
  const old = await avatars.read(who, url)
  assert.equal(await old.text(), 'old')
  t.mock.timers.tick(day - 1)
  assert.equal(await avatars.read(who, url), old)
  assert.equal(calls, 0)
  t.mock.timers.tick(1)
  assert.equal(await (await avatars.read(who, url)).text(), 'new')
  assert.equal(calls, 1)
})

test('refused images retry after an hour just like failures', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 400_000_000 })
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('svg', { headers: { 'content-type': 'image/svg+xml' } }) }
  const who = address('b9'), url = 'https://pics.invalid/refused'
  assert.equal(await avatars.read(who, url), false)
  t.mock.timers.tick(60 * 60_000 - 1)
  assert.equal(await avatars.read(who, url), false)
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.equal(await avatars.read(who, url), false)
  assert.equal(calls, 2)
})

const account = i => `0x${i.toString(16).padStart(40, '0')}`
test('the memory entry cap evicts least-recently-read answers, including failures', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw Error('offline') }
  const url = 'https://pics.invalid/offline'
  for (let i = 1; i <= 256; i++) assert.equal(await avatars.read(account(i), url), null)
  await avatars.read(account(1), url) // Make the oldest entry recent.
  await avatars.read(account(257), url)
  assert.equal(calls, 257)
  await avatars.read(account(1), url)
  assert.equal(calls, 257, 'the recent answer survived')
  await avatars.read(account(2), url)
  assert.equal(calls, 258, 'the least-recent answer was evicted')
})

test('the memory byte cap evicts blobs without discarding disk copies or retained blobs', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(new Uint8Array(1 << 20), { headers: { 'content-type': 'image/png' } }) }
  const url = 'https://pics.invalid/large'
  const retained = await avatars.read(account(1), url)
  const cold = await avatars.read(account(2), url)
  for (let i = 3; i <= 32; i++) await avatars.read(account(i), url)
  assert.equal(await avatars.read(account(1), url), retained, 'exactly 32 MiB fits')
  await avatars.read(account(33), url)
  assert.equal(await avatars.read(account(1), url), retained, 'recent blob survives')
  assert.notEqual(await avatars.read(account(2), url), cold, 'oldest blob was evicted and cloned from disk')
  assert.equal(calls, 33, 'eviction costs a disk read, not another network request')
  assert.equal((await cold.arrayBuffer()).byteLength, 1 << 20, 'an existing reader still owns its blob')
})

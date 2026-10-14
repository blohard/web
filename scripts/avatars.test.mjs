// Untrusted avatar bytes are bounded before display, including cached types.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, address, bigBody, settled } from './harness.mjs'
const { avatars, Avatars } = await load('lib/avatars.svelte.ts')
const { tx, STORES } = await load('lib/db.ts')
beforeEach(install)
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
  avatars.get(who, old); await waiting
  const latest = await settled(who, current)
  assert.match(latest, /^blob:/)
  release()
  const previous = await settled(who, old)
  assert.notEqual(previous, latest)
  assert.equal(avatars.get(who, current), latest)
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
  assert.equal(avatars.get(address('a1'), 'https://pics.invalid/honest'), undefined)
  assert.equal(await settled(address('a1'), 'https://pics.invalid/honest'), false)
  assert.equal(honest.state.pulled, 0)
  // No length: read until the limit, then cancelled, well short of the whole body.
  const sneaky = bigBody(2 << 20); bodies['https://pics.invalid/sneaky'] = { stream: sneaky.stream }
  avatars.get(address('a2'), 'https://pics.invalid/sneaky')
  assert.equal(await settled(address('a2'), 'https://pics.invalid/sneaky'), false)
  assert.ok(sneaky.state.pulled <= (1 << 20) + (1 << 16), `read ${sneaky.state.pulled} bytes`)
  assert.equal(sneaky.state.cancelled, true)
  // A small picture is kept.
  const small = bigBody(1000); bodies['https://pics.invalid/small'] = { stream: small.stream, length: 1000 }
  avatars.get(address('a3'), 'https://pics.invalid/small')
  assert.match(await settled(address('a3'), 'https://pics.invalid/small'), /^blob:/)
})

test('an SVG avatar is refused, fresh or cached', async () => {
  globalThis.fetch = async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } })
  avatars.get(address('a4'), 'https://pics.invalid/vector.svg')
  assert.equal(await settled(address('a4'), 'https://pics.invalid/vector.svg'), false)
  // A cached SVG from before the rule is not shown either.
  const who = address('a5')
  await tx(STORES.avatars, 'readwrite', (s) => s.put({ address: who, url: 'https://pics.invalid/old.svg', blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }), fetchedAt: Date.now() }))
  avatars.get(who, 'https://pics.invalid/old.svg')
  assert.equal(await settled(who, 'https://pics.invalid/old.svg'), false)
  // Nor one whose cached type carries a parameter, as earlier code could store it.
  const charset = address('a6')
  await tx(STORES.avatars, 'readwrite', (s) => s.put({ address: charset, url: 'https://pics.invalid/old2.svg', blob: new Blob(['<svg/>'], { type: 'image/svg+xml;charset=utf-8' }), fetchedAt: Date.now() }))
  avatars.get(charset, 'https://pics.invalid/old2.svg')
  assert.equal(await settled(charset, 'https://pics.invalid/old2.svg'), false)
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
  assert.equal(await settled(who, url), null)
  assert.equal(calls, 1)
  down = false
  t.mock.timers.tick(60 * 60_000 - 1)
  assert.equal(avatars.get(who, url), null)
  await new Promise(setImmediate)
  assert.equal(calls, 1, 'kept for the hour')
  t.mock.timers.tick(1)
  assert.equal(avatars.get(who, url), null, 'the last answer shows while asking again')
  for (let i = 0; i < 20 && calls < 2; i++) await new Promise(setImmediate)
  assert.equal(calls, 2)
  for (let i = 0; i < 50 && !avatars.get(who, url); i++) await new Promise(setImmediate)
  assert.match(avatars.get(who, url), /^blob:/)
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
  for (let i = 0; i < 200 && cache.get(fresh, freshUrl) === undefined; i++) await new Promise((r) => setTimeout(r, 5))
  assert.match(cache.get(fresh, freshUrl), /^blob:/, 'the fresh entry is served from the cache')
  assert.deepEqual(calls, [], 'without a fetch')
  const kept = await tx(STORES.avatars, 'readonly', (s) => s.getAllKeys())
  assert.deepEqual(kept, [fresh], 'the expired entry is gone')
})

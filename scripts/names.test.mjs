import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, address, response, deferred } from './harness.mjs'

const { checkedName, names, profileUrl, pruneNames } = await load('lib/names.svelte.ts')
const { host } = await load('lib/host.svelte.ts')
beforeEach(() => {
  install(); names.entries = {}; names.pausedUntil = 0; host.status = { gateway: { names: true } }
  // A save another test left waiting must not carry into this one.
  clearTimeout(names.saving); names.saving = null; names.unsaved = {}
})
after(teardown)

// The host enforces ENS's normalized spelling (host/src/names.rs); the page checks the answer's shape.
test('a name is displayed only as a well-formed answer from the host', () => {
  const entry = { name: 'alice.eth', source: 'ens', avatar: 'https://images.example/a.png' }
  assert.deepEqual(checkedName(entry), entry)
  for (const name of ['a'.repeat(256), 42, undefined]) {
    assert.throws(() => checkedName({ ...entry, name }))
  }
  assert.throws(() => checkedName({ ...entry, source: 'basenames' }))
  assert.throws(() => checkedName({ ...entry, source: 'unknown' }))
  assert.equal(checkedName({ ...entry, avatar: 'javascript:alert(1)' }).avatar, null)
  for (const avatar of ['https://user:pw@images.example/a.png', 'https://images.example:8443/a.png', 'http://images.example/a.png']) {
    assert.equal(checkedName({ ...entry, avatar }).avatar, null, avatar)
  }
  assert.equal(profileUrl({ name: 'alice.base.eth', source: 'basenames' }), 'https://www.base.org/name/alice')
})

test('cards sharing an address use one domain lookup, with no RPC fallback', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return response({ name: 'alice.eth', source: 'ens', avatar: null })
  }
  const who = address('aa')
  names.lookup(who); names.lookup(who)
  await new Promise(setImmediate)
  assert.equal(names.display(who), 'alice.eth')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `/api/names/${who}`)
  assert.equal(calls[0].init.method, 'GET')
})

test('unavailable name lookup stays an address and never contacts a public RPC', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return response({ error: 'name_unavailable' }, 500) }
  names.lookup(address('bb'))
  await new Promise(setImmediate)
  assert.equal(names.lookup(address('bb')).name, null)
  assert.equal(calls, 1)
  host.status = { gateway: { names: false } }
  names.lookup(address('cc'))
  await new Promise(setImmediate)
  assert.equal(calls, 1)
})


test('persisted names discard expired entries and bound count and serialized bytes', () => {
  const now = Date.now(), entries = {}
  for (let i=0; i<3000; i++) entries[`0x${i.toString(16).padStart(40, '0')}`] = {name:'alice.eth',source:'ens',avatar:`https://example.org/${'a'.repeat(2000)}`,checkedAt:now-i}
  entries[address('ff')] = {name:null,source:null,avatar:null,checkedAt:now-2*60*60_000}
  const kept = pruneNames(entries, now)
  assert.ok(Object.keys(kept).length <= 512)
  assert.ok(JSON.stringify(kept).length*2 <= 1<<20)
  assert.equal(kept[address('ff')], undefined)
  assert.equal(kept['0x'+ '0'.repeat(40)].name, 'alice.eth')
})

test('disk cache pruning does not evict names still displayed on a large page', async (t) => {
  let stored = '{}'
  const original = globalThis.localStorage
  globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value } }
  t.after(() => { if (original === undefined) delete globalThis.localStorage; else globalThis.localStorage = original })
  const now = Date.now()
  const entries = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [
    `0x${i.toString(16).padStart(40, '0')}`, { name: 'alice.eth', source: 'ens', avatar: null, checkedAt: now - i },
  ]))
  names.entries = entries
  stored = JSON.stringify(entries)
  globalThis.fetch = async () => response({ name: 'bob.eth', source: 'ens', avatar: null })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  names.lookup(address('ee'))
  for (let i = 0; i < 5; i++) await new Promise(setImmediate)
  t.mock.timers.tick(1_000) // the batched save
  assert.equal(Object.keys(JSON.parse(stored)).length, 512)
  assert.equal(Object.keys(names.entries).length, 601)
})


test('a cold page queues names with only two active lookups', async () => {
  let active = 0, maximum = 0, calls = 0
  globalThis.fetch = async () => {
    active++; calls++; maximum = Math.max(maximum, active)
    await new Promise(setImmediate)
    active--
    return response({ name: null, source: null, avatar: null })
  }
  const addresses = Array.from({ length: 40 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'))
  await Promise.all(addresses.map(a => names.hint(a)))
  assert.equal(calls, 40)
  assert.equal(maximum, 2)
})

test('a temporary name refusal waits and retries without caching it as absence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let calls = 0
  globalThis.fetch = async () => ++calls === 1 ? response({ error: 'visitor_read_limit' }, 429)
    : response({ name: 'alice.eth', source: 'ens', avatar: null })
  const result = names.hint(address('ee'))
  await new Promise(setImmediate)
  assert.equal(calls, 1)
  t.mock.timers.tick(2000)
  assert.equal(await result, 'alice.eth')
  assert.equal(calls, 2)
})

test('temporary refusals retry after 2, 5, 10 and 20 seconds, keeping a known name, then cool down', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000_000 })
  const who = address('ac')
  names.entries[who] = { name: 'alice.eth', source: 'ens', avatar: null, checkedAt: Date.now() - 86_400_000 }
  const asked = []
  globalThis.fetch = async () => { asked.push(Date.now()); return response({ error: 'host_busy' }, 503) }
  const result = names.hint(who)
  result.catch(() => {})
  const step = async ms => { t.mock.timers.tick(ms); for (let i = 0; i < 5; i++) await new Promise(setImmediate) }
  await step(0)
  for (const wait of [2000, 5000, 10_000, 20_000]) {
    const before = asked.length
    await step(wait - 1)
    assert.equal(asked.length, before, `not before ${wait} ms`)
    assert.equal(names.display(who), 'alice.eth', 'the known name stays while retrying')
    await step(1)
    assert.equal(asked.length, before + 1)
  }
  await assert.rejects(result, /could not look up your name/)
  assert.deepEqual(asked.map(at => at - asked[0]), [0, 2000, 7000, 17_000, 37_000])
  assert.equal(names.display(who), 'alice.eth')
  // The failure is kept for five minutes, for display.
  await step(299_999)
  assert.equal(names.display(who), 'alice.eth')
  assert.equal(asked.length, 5)
})

test('a longer Retry-After is waited for, and a confirmed absence is never retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let calls = 0
  globalThis.fetch = async () => {
    if (++calls > 1) return response({ name: null, source: null, avatar: null })
    const refused = response({ error: 'visitor_read_limit' }, 429)
    refused.headers.set('retry-after', '8')
    return refused
  }
  const result = names.hint(address('ad'))
  const step = async ms => { t.mock.timers.tick(ms); for (let i = 0; i < 5; i++) await new Promise(setImmediate) }
  await step(0)
  await step(7999)
  assert.equal(calls, 1, 'the host asked for eight seconds')
  await step(1)
  assert.equal(await result, undefined)
  assert.equal(calls, 2)
  await step(60_000)
  assert.equal(calls, 2, 'no name is an answer, not a failure')
})

test('a busy answer that is not JSON still sets the wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let calls = 0
  // What a proxy in front of the host may send while it is busy.
  globalThis.fetch = async () => ++calls === 1
    ? new Response('<html><body>busy</body></html>', { status: 503, headers: { 'content-type': 'text/html', 'retry-after': '10' } })
    : response({ name: 'alice.eth', source: 'ens', avatar: null })
  const result = names.hint(address('ae'))
  const step = async ms => { t.mock.timers.tick(ms); for (let i = 0; i < 5; i++) await new Promise(setImmediate) }
  await step(0)
  await step(9999)
  assert.equal(calls, 1, 'the host asked for ten seconds')
  await step(1)
  assert.equal(await result, 'alice.eth')
  assert.equal(calls, 2)
})

test('failed rechecks retain the name and avatar for five minutes, while confirmed absence clears them', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000_000 })
  const who = address('ab')
  names.entries[who] = { name: 'alice.eth', source: 'ens', avatar: 'https://example.org/alice.png', checkedAt: Date.now() - 86_400_000 }
  let calls = 0
  globalThis.fetch = async () => { calls++; return response({ error: 'unavailable' }, 500) }
  await assert.rejects(names.hint(who))
  assert.equal(names.display(who), 'alice.eth')
  assert.equal(names.lookup(who).avatar, 'https://example.org/alice.png')
  await new Promise(setImmediate)
  assert.equal(calls, 1)
  t.mock.timers.tick(299_999)
  names.lookup(who)
  await new Promise(setImmediate)
  assert.equal(calls, 1, 'display keeps the failure for five minutes')
  assert.equal(names.display(who), 'alice.eth')
  t.mock.timers.tick(1)
  globalThis.fetch = async () => { calls++; return response({ name: null, source: null, avatar: null }) }
  assert.equal(await names.hint(who), undefined)
  assert.equal(names.lookup(who).name, null)
  assert.equal(names.lookup(who).avatar, null)
  assert.equal(calls, 2)
})


test('a full name queue fails explicitly, shares existing reads, and can be retried after draining', async () => {
  const held = deferred(), asked = []
  const addr = i => `0x${i.toString(16).padStart(40, '0')}`
  globalThis.fetch = async url => {
    asked.push(String(url))
    await held.promise
    return response({ name: 'alice.eth', source: 'ens', avatar: null })
  }
  const pending = Array.from({ length: 512 }, (_, i) => names.hint(addr(i + 1)))
  const duplicate = names.hint(addr(1))
  try {
    // Display reads may fail quietly, but sponsorship must not mistake capacity for absence.
    names.lookup(addr(9999))
    assert.equal(names.inflight.size, 512, 'refused lookups do not enter the bounded queue')
    await assert.rejects(names.hint(addr(9999)), /could not look up your name/)
    assert.equal(names.entries[addr(9999)], undefined)
  } finally {
    held.resolve()
    await Promise.all([...pending, duplicate])
  }
  assert.equal(asked.length, 512)
  assert.equal(await names.hint(addr(9999)), 'alice.eth')
  assert.equal(asked.length, 513)
})

test('busy names release request lanes during backoff so an unrelated name can load', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const asked = [], first = address('01'), second = address('02'), healthy = address('03')
  globalThis.fetch = async url => {
    asked.push(String(url))
    return String(url).endsWith(healthy)
      ? response({ name: 'ready.eth', source: 'ens', avatar: null })
      : response({ error: 'name_unavailable' }, 503)
  }
  const failed = Promise.allSettled([names.hint(first), names.hint(second)])
  let answer
  const good = names.hint(healthy).then(value => { answer = value })
  try {
    await new Promise(setImmediate)
    assert.equal(answer, 'ready.eth', 'the healthy lookup must finish without advancing retry timers')
    assert.equal(asked.length, 3)
  } finally {
    for (const wait of [2000, 5000, 10_000, 20_000]) {
      t.mock.timers.tick(wait)
      await new Promise(setImmediate)
    }
    await failed
    await good
  }
})


test('a visitor 429 pauses every name, including queued and newly requested names', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const asked = [], first = address('11'), second = address('12'), third = address('13')
  globalThis.fetch = async url => {
    asked.push(String(url))
    if (asked.length <= 2) {
      const busy = response({ error: 'visitor_name_limit' }, 429)
      busy.headers.set('retry-after', asked.length === 1 ? '10' : '5')
      return busy
    }
    return response({ name: 'alice.eth', source: 'ens', avatar: null })
  }
  const results = [names.hint(first), names.hint(second), names.hint(third)]
  await new Promise(setImmediate)
  assert.equal(asked.length, 2)
  results.push(names.hint(address('14')))
  t.mock.timers.tick(9999)
  await new Promise(setImmediate)
  assert.equal(asked.length, 2, 'queued names wait for the longest pause, too')
  t.mock.timers.tick(1)
  assert.deepEqual(await Promise.all(results), Array(4).fill('alice.eth'))
  assert.equal(asked.length, 6)
})

test('the free posting name check asks again past a cached display failure, but keeps a cached answer', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 200_000_000 })
  const real = globalThis.fetch
  let calls = 0, fail = true
  globalThis.fetch = async () => {
    calls++
    if (fail) throw new TypeError('network blip')
    return new Response(JSON.stringify({ name: 'alice.eth', source: 'ens', avatar: null }), { status: 200 })
  }
  const who = `0x${'ab'.repeat(20)}`
  try {
    names.lookup(who)
    for (let i = 0; i < 20; i++) await new Promise(setImmediate)
    assert.equal(calls, 1)
    assert.equal(names.entries[who].error, true, 'the display keeps its five-minute cooldown')
    fail = false
    t.mock.timers.tick(60_000)
    assert.equal(await names.hint(who), 'alice.eth', 'the check asks the host again')
    assert.equal(calls, 2)
    assert.equal(await names.hint(who), 'alice.eth')
    assert.equal(calls, 2, 'a found name is a cached answer')
  } finally { globalThis.fetch = real }
})

test('a partial answer, a name whose avatar read failed, is kept an hour rather than a day', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 300_000_000 })
  const real = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return response({ name: 'alice.eth', source: 'ens', avatar: null, partial: true }) }
  const who = `0x${'cd'.repeat(20)}`
  try {
    assert.equal(await names.hint(who), 'alice.eth')
    assert.equal(names.entries[who].partial, true)
    t.mock.timers.tick(60 * 60_000 - 1)
    names.lookup(who)
    await new Promise(setImmediate)
    assert.equal(calls, 1, 'kept for the hour')
    t.mock.timers.tick(1)
    names.lookup(who)
    for (let i = 0; i < 5; i++) await new Promise(setImmediate)
    assert.equal(calls, 2, 'asked again after it')
    assert.deepEqual(pruneNames({ [who]: { name: 'alice.eth', source: 'ens', avatar: null, partial: true, checkedAt: Date.now() - 60 * 60_000 } }), {})
  } finally { globalThis.fetch = real }
})

test('answers arriving together are saved to browser storage once, a moment later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 500_000_000 })
  const store = new Map(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let writes = 0
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { writes++; store.set(k, v) }, removeItem: (k) => store.delete(k),
  } })
  const real = globalThis.fetch
  globalThis.fetch = async (url) => response({ name: `n${String(url).slice(-2)}.eth`, source: 'ens', avatar: null })
  t.after(() => {
    globalThis.fetch = real
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage
  })
  const who = ['a1', 'a2', 'a3'].map((n) => `0x${n.repeat(20)}`)
  for (const a of who) await names.hint(a)
  assert.equal(writes, 0, 'nothing written per answer')
  t.mock.timers.tick(1_000)
  assert.equal(writes, 1, 'one write for the three')
  const saved = JSON.parse([...store.values()][0])
  for (const a of who) assert.equal(saved[a].name, `n${a.slice(-2)}.eth`)
})

test('a late save keeps a newer answer another tab stored, and another tab\'s older answer is not adopted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 600_000_000 })
  const store = new Map(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k),
  } })
  const real = globalThis.fetch
  globalThis.fetch = async () => response({ name: 'older.eth', source: 'ens', avatar: null })
  t.after(() => {
    globalThis.fetch = real
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage
  })
  const who = `0x${'c1'.repeat(20)}`
  await names.hint(who) // this tab's answer, waiting to be saved
  const key = 'blohard.names.v2'
  // Another tab looked it up later and saved first.
  store.set(key, JSON.stringify({ [who]: { name: 'newer.eth', source: 'ens', avatar: null, checkedAt: Date.now() + 500 } }))
  t.mock.timers.tick(1_000)
  assert.equal(JSON.parse(store.get(key))[who].name, 'newer.eth', 'the newer answer stays')
  names.entries[who] = { name: 'newest.eth', source: 'ens', avatar: null, checkedAt: Date.now() + 900 }
  names.adopt({ [who]: { name: 'newer.eth', source: 'ens', avatar: null, checkedAt: Date.now() + 500 } })
  assert.equal(names.entries[who].name, 'newest.eth', 'an older answer from another tab does not replace a newer one here')
})

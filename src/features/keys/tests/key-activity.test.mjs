import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, mock, address, hash, renderComponent } from '../../../../scripts/harness.mjs'
const { readKeyActivity, KeyActivityFeed } = await load('features/keys/key-activity.ts')
const { EveryoneActivity } = await load('features/streams/everyone-activity.ts')
const { muted } = await load('lib/muted.svelte.ts')
const market = address('77'), creator = address('22'), buyer = address('33')
const purchase = (log, block = '100') => ({ position: { block, log }, timestamp: 100, transaction: hash('44'),
  event: { kind: 'trade', creator, holder: buyer, buy: true, amount: 2, supply: 2 } })
const answer = (items, next = null) => ({ market, checkpoint: { block: '100', hash: hash('55') }, items, next })
beforeEach(install)
after(teardown)

test('public activity validates positions, markets, amounts and event kinds', async () => {
  globalThis.fetch = async url => {
    assert.match(url, /keyring\/activity\?limit=100$/)
    return Response.json(answer([purchase(3), { ...purchase(2), event: { kind: 'transfer', creator, from: buyer, to: address('55'), amount: 1 } }]))
  }
  const p = await readKeyActivity(mock.chain, market)
  assert.deepEqual(p.items.map(x => x.kind), ['purchase', 'transfer'])
  for (const bad of [
    answer([purchase(2), purchase(3)]), answer([purchase(2), purchase(2)]),
    answer([{ ...purchase(2), event: { ...purchase(2).event, buy: false } }]),
    answer([{ ...purchase(2), event: { ...purchase(2).event, amount: 0 } }]),
    answer([purchase(2, '101')]), answer([purchase(2)], { block: '100', log: 3 }),
    { ...answer([]), market: address('99') },
  ]) {
    globalThis.fetch = async () => Response.json(bad)
    await assert.rejects(readKeyActivity(mock.chain, market), /invalid key activity/)
  }
})

test('empty filtered pages still advance, and a repeated cursor is rejected', async () => {
  globalThis.fetch = async () => Response.json(answer([], { block: '100', log: 5 }))
  const p = await readKeyActivity(mock.chain, market)
  assert.equal(p.next.log, 5)
  await assert.rejects(readKeyActivity(mock.chain, market, p.next), /invalid key activity cursor/)
})

test('paging keeps its head, refresh brings new activity, and old polls cannot relight it', async () => {
  let latest = 205, fail = false
  globalThis.fetch = async url => {
    if (fail) throw Error('offline')
    const before = Number(new URL(url, 'https://test.invalid').searchParams.get('before_log') ?? latest + 1)
    const start = Math.min(latest, before - 1)
    const items = Array.from({ length: Math.min(100, start) }, (_, i) => purchase(start - i))
    return Response.json(answer(items, start > 100 ? { block: '100', log: start - 99 } : null))
  }
  const keys = new KeyActivityFeed(mock.chain, market)
  assert.equal((await keys.load(20, false)).items[0].log, 205)
  latest = 210
  const polled = await keys.peek()
  assert.equal(keys.changed(polled), true)
  const older = await keys.load(150, false)
  assert.equal(older.items.length, 200)
  assert.equal(older.items[0].log, 205)
  assert.equal(new Set(older.items.map(n => n.log)).size, 200)
  fail = true
  await assert.rejects(keys.load(20, true), /host unreachable/)
  assert.equal(keys.visible()[0].log, 205)
  fail = false
  assert.equal((await keys.load(20, true)).items[0].log, 210)
  assert.equal(keys.changed(polled), false)
})

test('mutes apply to all participants and an unavailable keyring keeps posts usable', async () => {
  globalThis.fetch = async () => Response.json(answer([purchase(2)]))
  const keys = new KeyActivityFeed(mock.chain, market)
  muted.toggle(creator)
  try { assert.equal((await keys.load(20, false)).items.length, 0) }
  finally { muted.toggle(creator) }
  assert.equal(keys.visible().length, 1)
  globalThis.fetch = async () => { throw Error('offline') }
  const activity = new EveryoneActivity(mock.chain, market)
  const page = { rows: [{ key: 1n, lead: { blockNumber: 100n, logIndex: 1 } }], limit: 20, complete: true }
  const result = await activity.load(Promise.resolve(page), false, false)
  assert.equal(result.entries[0].kind, 'post')
  assert.equal(result.keyError, true)
  assert.equal(result.complete, false)
})

test('Everyone merges by block and log, keeps conversation order, and preserves shown rows on refresh', async () => {
  let items = [purchase(4), purchase(2)]
  globalThis.fetch = async () => Response.json(answer(items))
  const page = { rows: [
    { key: 2n, lead: { blockNumber: 99n, logIndex: 1 }, activity: { blockNumber: 100n, logIndex: 3 } },
    { key: 1n, lead: { blockNumber: 100n, logIndex: 1 } },
  ], limit: 3, complete: true }
  const activity = new EveryoneActivity(mock.chain, market)
  const first = await activity.load(Promise.resolve(page), true, false)
  assert.deepEqual(first.entries.map(e => e.key), ['key/100/4', '2', 'key/100/2', '1'])
  items = [purchase(5), ...items]
  const second = await activity.load(Promise.resolve(page), true, true)
  assert.equal(second.limit, 4)
  assert.deepEqual(second.entries.slice(0, second.limit).map(e => e.key), ['key/100/5', 'key/100/4', '2', 'key/100/2'])
})

test('Everyone paging appends discoveries without moving or rebuilding displayed entries, and Back keeps their order', async () => {
  globalThis.fetch = async () => Response.json(answer([purchase(90), purchase(50), purchase(20)]))
  const post = log => ({ key: BigInt(log), lead: { blockNumber: 100n, logIndex: log } })
  const original = post(80)
  const activity = new EveryoneActivity(mock.chain, market)
  const first = await activity.load(Promise.resolve({ rows: [original, post(40)], limit: 3, complete: true }), true, false)
  assert.deepEqual(first.entries.slice(0, first.limit).map(e => e.key), ['key/100/90', '80', 'key/100/50'])

  const updated = { ...original, cards: [{ post: { id: 81n } }] }
  const page = { rows: [updated, post(40), post(70), post(10)], limit: 6, complete: true }
  const older = await activity.load(Promise.resolve(page), false, true, 'older')
  assert.deepEqual(older.entries.map(e => e.key), ['key/100/90', '80', 'key/100/50', '70', '40', 'key/100/20', '10'])
  assert.strictEqual(older.entries[1].row, original)
  assert.deepEqual(older.entries.slice(0, first.limit), first.entries.slice(0, first.limit))

  const resumed = await activity.load(Promise.resolve(page), false, false, 'resume')
  assert.deepEqual(resumed.entries.map(e => e.key), older.entries.map(e => e.key))
  assert.strictEqual(resumed.entries[1].row, updated)

  const refreshed = await activity.load(Promise.resolve(page), true, true)
  assert.deepEqual(refreshed.entries.map(e => e.key), ['key/100/90', '80', '70', 'key/100/50', '40', 'key/100/20', '10'])
})

test('Everyone resuming accepts an own post inserted at the head of the retained post page', async () => {
  globalThis.fetch = async () => Response.json(answer([purchase(90), purchase(50)]))
  const post = log => ({ key: BigInt(log), lead: { blockNumber: 100n, logIndex: log } })
  for (const limit of [1, 4]) {
    const activity = new EveryoneActivity(mock.chain, market)
    const page = { rows: [post(80), post(40)], limit, complete: true }
    await activity.load(Promise.resolve(page), false, false)
    const resumed = await activity.load(Promise.resolve({ ...page, rows: [post(95), ...page.rows] }), false, false, 'resume')
    assert.deepEqual(resumed.entries.map(e => e.key), ['95', 'key/100/90', '80', 'key/100/50', '40'])
  }
})

test('Everyone resuming accepts an own reply that updates a displayed row activity', async () => {
  globalThis.fetch = async () => Response.json(answer([purchase(90), purchase(50)]))
  const activity = new EveryoneActivity(mock.chain, market)
  const row = { key: 80n, lead: { blockNumber: 100n, logIndex: 80 } }
  const page = { rows: [row], limit: 3, complete: true }
  await activity.load(Promise.resolve(page), false, false)
  const updated = { ...row, activity: { blockNumber: 100n, logIndex: 95 } }
  const resumed = await activity.load(Promise.resolve({ ...page, rows: [updated] }), false, false, 'resume')
  assert.deepEqual(resumed.entries.map(e => e.key), ['80', 'key/100/90', 'key/100/50'])
  assert.strictEqual(resumed.entries[0].row, updated)
})

test('Everyone resuming retains order only for entries still eligible in the current page', async () => {
  globalThis.fetch = async () => Response.json(answer([purchase(90)]))
  const post = log => ({ key: BigInt(log), lead: { blockNumber: 100n, logIndex: log } })
  const activity = new EveryoneActivity(mock.chain, market)
  const first = { rows: [post(80), post(60)], limit: 3, complete: true }
  await activity.load(Promise.resolve(first), false, false)
  const older = { rows: [...first.rows, post(70)], limit: 4, complete: true }
  await activity.load(Promise.resolve(older), false, true, 'older')
  muted.toggle(creator)
  try {
    const page = { ...older, rows: [post(60), post(70)] }
    const resumed = await activity.load(Promise.resolve(page), false, false, 'resume')
    assert.deepEqual(resumed.entries.map(e => e.key), ['60', '70'])
  } finally { muted.toggle(creator) }
})

test('Everyone paging survives failed key reads and appends a successful retry below displayed entries', async () => {
  let fail = false, calls = 0
  globalThis.fetch = async url => {
    calls++
    if (fail) throw Error('offline')
    const before = new URL(url, 'https://test.invalid').searchParams.get('before_log')
    return Response.json(before ? answer([purchase(50)]) : answer([purchase(90)], { block: '100', log: 90 }))
  }
  const post = log => ({ key: BigInt(log), lead: { blockNumber: 100n, logIndex: log } })
  const activity = new EveryoneActivity(mock.chain, market)
  const first = await activity.load(Promise.resolve({ rows: [post(80)], limit: 1, complete: true }), false, false)
  assert.deepEqual(first.entries.slice(0, first.limit).map(e => e.key), ['key/100/90'])
  fail = true
  const page = { rows: [post(95), post(80), post(40)], limit: 4, complete: true }
  const failed = await activity.load(Promise.resolve(page), false, true, 'older')
  assert.equal(failed.keyError, true)
  assert.deepEqual(failed.entries.map(e => e.key), ['key/100/90', '95', '80', '40'])
  fail = false
  const retried = await activity.load(Promise.resolve(page), false, true, 'older')
  assert.equal(retried.keyError, false)
  assert.deepEqual(retried.entries.map(e => e.key), ['key/100/90', '95', '80', '40', 'key/100/50'])
  assert.equal(calls, 4)
})

test('activity rows link the participants, market and transaction without wallet actions', async () => {
  globalThis.fetch = async () => Response.json(answer([purchase(2)]))
  const [event] = (await readKeyActivity(mock.chain, market)).items
  const html = await renderComponent('features/keys/KeyActivityRow.svelte', { event, chain: { ...mock.chain, id: 84532 } })
  assert.match(html, /bought/)
  assert.match(html, /2 of/)
  assert.ok(html.includes(`/u/84532/${creator}/keys`))
  assert.match(html, /transaction/)
})

test('mixed pages stop at either unfinished scan, then reveal the missing range in order', async () => {
  let calls = 0
  globalThis.fetch = async url => {
    calls++
    const before = new URL(url, 'https://test.invalid').searchParams.get('before_log')
    if (!before) return Response.json(answer([purchase(50)], { block: '100', log: 40 }))
    return Response.json(answer([purchase(30)]))
  }
  const activity = new EveryoneActivity(mock.chain, market)
  const post = log => ({ key: BigInt(log), lead: { blockNumber: 100n, logIndex: log } })
  const first = await activity.load(Promise.resolve({ rows: [post(60)], limit: 1, complete: false, scannedThrough: { block: 100n, log: 60 } }), false, false)
  assert.deepEqual(first.entries.map(e => e.key), ['60'])
  const second = await activity.load(Promise.resolve({ rows: [post(60), post(45)], limit: 2, complete: false, scannedThrough: { block: 100n, log: 45 } }), false, true)
  assert.deepEqual(second.entries.map(e => e.key), ['60', 'key/100/50', '45'])
  const third = await activity.load(Promise.resolve({ rows: [post(60), post(45), post(20)], limit: 10, complete: true }), false, true)
  assert.deepEqual(third.entries.map(e => e.key), ['60', 'key/100/50', '45', 'key/100/30', '20'])
  assert.equal(calls, 2)
})

test('a failed activity refresh is retried even after the old snapshot was complete', async () => {
  let fail = false, latest = 1
  globalThis.fetch = async () => { if (fail) throw Error('offline'); return Response.json(answer([purchase(latest)])) }
  const activity = new EveryoneActivity(mock.chain, market)
  const page = { rows: [], limit: 20, complete: true }
  await activity.load(Promise.resolve(page), true, false)
  fail = true
  assert.equal((await activity.load(Promise.resolve(page), true, true)).keyError, true)
  fail = false; latest = 2
  const retry = await activity.load(Promise.resolve(page), false, true)
  assert.equal(retry.keyError, false)
  assert.equal(retry.entries[0].event.log, 2)
})


test('activation cards include an optional initial purchase and link to their own market', async () => {
  for (const amount of [0, 1, 3]) {
    globalThis.fetch = async () => Response.json(answer([{ ...purchase(2), event: { kind: 'activated', creator, amount } }]))
    const [event] = (await readKeyActivity(mock.chain, market)).items
    assert.equal(event.kind, 'activation')
    assert.equal(event.amount, amount)
    const html = await renderComponent('features/keys/KeyActivityRow.svelte', { event, chain: { ...mock.chain, id: 84532 } })
    const text = html.replace(/<[^>]*>/g, '')
    assert.match(text, /just activated account keys/)
    if (amount) assert.ok(text.includes(`activated account keys and bought ${amount} of their own keys!`))
    else assert.doesNotMatch(text, /bought|0 of/)
    assert.ok(html.includes(`/u/84532/${creator}/keys`))
    const keys = new KeyActivityFeed(mock.chain, market)
    muted.toggle(creator)
    try { assert.equal((await keys.load(20, false)).items.length, 0) }
    finally { muted.toggle(creator) }
    assert.equal(keys.visible().length, 1)
  }
  for (const amount of [undefined, -1, 0.5, 0x100000000]) {
    globalThis.fetch = async () => Response.json(answer([{ ...purchase(2), event: { kind: 'activated', creator, amount } }]))
    await assert.rejects(readKeyActivity(mock.chain, market), /invalid key activity/)
  }
})

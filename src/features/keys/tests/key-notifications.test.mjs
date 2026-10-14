import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, mock, address, hash, renderComponent } from '../../../../scripts/harness.mjs'
import { answerIndex } from '../../../../scripts/index-fixture.mjs'
const { readKeyNotifications, KeyNotifications, keyNoticeId } = await load('features/keys/key-notifications.svelte.ts')
const { NotificationActivity } = await load('features/notifications/notification-activity.ts')
const { muted } = await load('lib/muted.svelte.ts')
const { commitment } = await load('lib/api.ts')
const creator = address('22'), trader = address('33'), market = address('77')
const item = (log = 10, who = trader) => ({ kind: 'trade', trader: who, buy: true, amount: 3, timestamp: 100,
  transaction: hash('44'), position: { block: '100', log } })
const gift = (log = 10, from = trader, keys = trader, amount = 1) => ({ kind: 'received', creator: keys, from, amount, timestamp: 100,
  transaction: hash('45'), position: { block: '100', log } })
const response = (items = [item()], extra = {}) => ({ market, active: true, checkpoint: { block: '100', hash: hash('55') },
  items, next: null, truncated: false, ...extra })
beforeEach(install)
after(teardown)

test('trade responses validate creator, market, bounds, ordering and cursor', async () => {
  globalThis.fetch = async () => Response.json(response())
  const page = await readKeyNotifications(mock.chain, market, creator)
  assert.equal(page.items[0].amount, 3)
  assert.equal(page.items[0].block, 100n)
  for (const bad of [
    response([], { market: address('88') }), response([item()], { active: false }),
    response([item(), item()]), response([item(10, creator)]),
    ...[{ amount: 0 }, { amount: 2 ** 32 }, { amount: 1.5 }, { buy: 'true' }, { timestamp: -1 },
      { trader: 'bad' }, { transaction: '0x44' }, { position: { block: '101', log: 0 } }]
      .map(fields => response([{ ...item(), ...fields }])),
    response([item()], { next: item().position }), response([], { truncated: 'yes' }),
  ]) {
    globalThis.fetch = async () => Response.json(bad)
    await assert.rejects(readKeyNotifications(mock.chain, market, creator))
  }
})

test('paging holds its head until refresh and failed reads preserve the last result', async () => {
  let latest = 100, fail = false, calls = 0
  globalThis.fetch = async input => {
    calls++
    if (fail) throw Error('offline')
    const params = new URL(input, 'https://test.invalid').searchParams
    const before = Number(params.get('before_log') ?? latest + 1), limit = Number(params.get('limit'))
    const oldest = Math.max(0, latest - 99)
    const items = Array.from({ length: Math.min(limit, Math.max(0, before - oldest)) }, (_, i) => item(before - i - 1))
    return Response.json(response(items, { next: items.at(-1)?.position.log > oldest ? items.at(-1).position : null, truncated: oldest > 0 }))
  }
  const view = new KeyNotifications(mock.chain, market, creator), token = {}
  assert.equal((await view.load(20, token)).items[0].log, 100)
  latest = 105
  view.observe(await view.peek())
  assert.equal(view.changed, true)
  const beforePaging = calls
  const more = await view.load(120, token)
  assert.equal(calls, beforePaging, 'one page already contains all 100 retained trades')
  assert.equal(more.items.length, 100)
  assert.equal(more.truncated, true)
  assert.equal(more.items[0].log, 100, 'older paging cannot introduce a new head')
  assert.equal(new Set(more.items.map(keyNoticeId)).size, more.items.length)
  assert.equal(more.complete, true)
  fail = true
  await assert.rejects(view.load(120, {}), /host unreachable/)
  assert.equal(view.visible()[0].log, 100)
  fail = false
  assert.equal((await view.load(20, {})).items[0].log, 105)
  assert.equal(view.changed, false)
  view.observe(await view.peek())
  assert.equal(view.changed, false)
})

test('mutes hide key activity without discarding it', async () => {
  globalThis.fetch = async () => Response.json(response())
  const view = new KeyNotifications(mock.chain, market, creator), token = {}
  muted.toggle(trader)
  try { assert.equal((await view.load(20, token)).items.length, 0) }
  finally { muted.toggle(trader) }
  assert.equal(view.visible().length, 1)
})

test('accounts without keys of their own still hear about keys sent to them, and old polls cannot relight a refreshed view', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json(response([gift()], { active: false })) }
  const inactive = new KeyNotifications(mock.chain, market, creator)
  const loaded = await inactive.load(20, {})
  assert.equal(loaded.items[0].kind, 'key-received')
  assert.equal((await inactive.peek()).head, keyNoticeId(loaded.items[0]))
  assert.equal(calls, 2)
  globalThis.fetch = async () => Response.json(response())
  const active = new KeyNotifications(mock.chain, market, creator)
  await active.load(20, {})
  const old = await active.peek()
  await active.load(20, {})
  active.observe({ ...old, head: 'outdated poll' })
  assert.equal(active.changed, false)
})

test('post and key activity merge by chain position and a key failure leaves posts usable', async () => {
  const row = { id: '1', author: trader, parent: '0', parent_author: address('00'), timestamp: 100,
    content_hash: hash('cc'), transaction: hash('dd'), position: { block: '100', log: 5 },
    gate: address('00'), author_gate: address('00'), effective_gate: address('00'), replies: '0' }
  row.commitment = commitment({ author: trader, parentId: 0n, timestamp: 100, contentHash: hash('cc') })
  const state = { chain: mock.chain, rows: new Map([[1n, row]]), associations: new Map([[1n, { account: creator, reference: { kind: 'mention', account: creator } }]]),
    events: [], at: { generation: hash('ab'), sequence: '0', checkpoint: { block: '100', hash: hash('ac') } } }
  let fail = false, keyReads = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(input, 'https://test.invalid')
    if (url.pathname.endsWith('/trades')) {
      keyReads++
      if (fail) return Response.json({ error: 'keyring_syncing' }, { status: 503 })
      return Response.json(response())
    }
    return answerIndex(state, url, init)
  }
  const basic = new NotificationActivity([mock.chain], creator, null)
  assert.deepEqual((await basic.load(20, {})).items.map(n => n.kind), ['mention'])
  assert.equal(keyReads, 0)
  const view = new NotificationActivity([mock.chain], creator, [{ chain: mock.chain.id, market, start_block: 1 }])
  assert.deepEqual((await view.load(20, {})).items.map(n => n.kind), ['key-trade', 'mention'])
  fail = true
  const retained = await view.load(20, {})
  assert.equal(retained.keyError, true)
  assert.equal(retained.items.length, 2)
})

test('trade cards link to the trader, creator market and receipt', async () => {
  globalThis.fetch = async () => Response.json(response())
  const { items } = await readKeyNotifications(mock.chain, market, creator)
  const html = await renderComponent('features/keys/KeyTradeNotification.svelte', { notice: items[0], creator })
  assert.match(html, /bought 3 of your keys/)
  assert.ok(html.includes(`/u/${mock.chain.id}/${creator}/keys`))
  const sale = await renderComponent('features/keys/KeyTradeNotification.svelte', { notice: { ...items[0], buy: false, amount: 1 }, creator })
  assert.match(sale, /sold 1 of your keys/)
})


test('trade receipt links follow the notice chain and omit unsupported explorers', async () => {
  for (const [id, explorer] of [[84532, 'https://sepolia.basescan.org'], [8453, 'https://basescan.org'], [31337, null]]) {
    globalThis.fetch = async () => Response.json(response())
    const { items } = await readKeyNotifications({ ...mock.chain, id }, market, creator)
    const html = await renderComponent('features/keys/KeyTradeNotification.svelte', { notice: items[0], creator })
    if (explorer) assert.ok(html.includes(`href="${explorer}/tx/${hash('44')}"`))
    else assert.doesNotMatch(html, /\/tx\//)
  }
})

test('received keys validate their sender and creator, and mutes hide the sender', async () => {
  globalThis.fetch = async () => Response.json(response([gift(11, trader, address('66'), 2), item(10)]))
  const page = await readKeyNotifications(mock.chain, market, creator)
  assert.deepEqual(page.items.map((n) => n.kind), ['key-received', 'key-trade'])
  assert.equal(page.items[0].from, trader)
  assert.equal(page.items[0].creator, address('66'))
  assert.equal(page.items[0].amount, 2)
  assert.notEqual(keyNoticeId(page.items[0]), keyNoticeId({ ...page.items[1], block: 100n, log: 11 }), 'the two kinds never share an id')
  for (const bad of [
    response([gift(10, creator)]), response([{ ...gift(), from: 'bad' }]), response([{ ...gift(), creator: 'bad' }]),
    response([{ ...item(), kind: 'mystery' }]), response([{ ...gift(), amount: 0 }]),
  ]) {
    globalThis.fetch = async () => Response.json(bad)
    await assert.rejects(readKeyNotifications(mock.chain, market, creator))
  }
  globalThis.fetch = async () => Response.json(response([gift()], { active: false }))
  const view = new KeyNotifications(mock.chain, market, creator)
  await view.load(20, {})
  muted.toggle(trader)
  try { assert.deepEqual(view.visible(), []) } finally { muted.toggle(trader) }
})

test('received key cards name the sender, whose keys they are, and link to that market', async () => {
  globalThis.fetch = async () => Response.json(response([gift(12, trader, trader, 1), gift(11, trader, creator, 2), gift(10, trader, address('66'), 2)]))
  const { items } = await readKeyNotifications(mock.chain, market, creator)
  const theirs = await renderComponent('features/keys/KeyTradeNotification.svelte', { notice: items[0], creator })
  assert.match(theirs, /sent you 1 of their keys/)
  assert.ok(theirs.includes(`/u/${mock.chain.id}/${trader}/keys`))
  assert.match(theirs, /their key market/)
  const own = await renderComponent('features/keys/KeyTradeNotification.svelte', { notice: items[1], creator })
  assert.match(own, /sent you 2 of your own keys/)
  assert.match(own, /your key market/)
  const other = await renderComponent('features/keys/KeyTradeNotification.svelte', { notice: items[2], creator })
  assert.match(other, /sent you 2 keys to/)
  assert.ok(other.includes(`/u/${mock.chain.id}/${address('66')}/keys`))
})

test('a newer key trade keeps every post the page showed, across the combined list', async () => {
  const rows = new Map(), associations = new Map()
  for (let id = 1; id <= 21; id++) {
    const row = { id: String(id), author: trader, parent: '0', parent_author: address('00'), timestamp: 200 + id,
      content_hash: hash('cc'), transaction: hash('dd'), position: { block: String(200 + id), log: 0 },
      gate: address('00'), author_gate: address('00'), effective_gate: address('00'), replies: '0' }
    row.commitment = commitment({ author: trader, parentId: 0n, timestamp: row.timestamp, contentHash: hash('cc') })
    rows.set(BigInt(id), row)
    associations.set(BigInt(id), { account: creator, reference: { kind: 'mention', account: creator } })
  }
  const state = { chain: mock.chain, rows, associations, events: [], at: { generation: hash('ab'), sequence: '0', checkpoint: { block: '300', hash: hash('ac') } } }
  let trades = [item()]
  globalThis.fetch = async (input, init) => {
    const url = new URL(input, 'https://test.invalid')
    if (url.pathname.endsWith('/trades')) return Response.json(response(trades, { checkpoint: { block: '1000', hash: hash('55') } }))
    return answerIndex(state, url, init)
  }
  const view = new NotificationActivity([mock.chain], creator, [{ chain: mock.chain.id, market, start_block: 1 }])
  const first = await view.load(20, {})
  assert.deepEqual(first.items.map(n => n.kind), Array(20).fill('mention'), 'twenty newer posts fill the page')
  trades = [{ ...item(1), timestamp: 1000, position: { block: '900', log: 1 } }, item()]
  const next = await view.load(20, {})
  assert.equal(next.items[0].kind, 'key-trade')
  assert.equal(next.items.length, 21, 'the post the trade displaced stays')
  assert.deepEqual(next.items.slice(1).map(n => n.post.id), first.items.map(n => n.post.id))
})

test('notifications retain independent activity from both markets at one address', async () => {
  const chains = [8453, 84532].map(id => ({ ...mock.chain, id }))
  const states = new Map(chains.map(chain => [chain.id, { chain, rows: new Map(), associations: new Map(),
    events: [], at: { generation: hash('ab'), sequence: '0', checkpoint: { block: '100', hash: hash('ac') } } }]))
  const reads = [], fail = new Set()
  globalThis.fetch = async (input, init) => {
    const url = new URL(input, 'https://test.invalid'), id = Number(url.pathname.split('/')[3])
    if (url.pathname.endsWith('/trades')) {
      reads.push(id)
      return fail.has(id) ? Response.json({ error: 'keyring_syncing' }, { status: 503 }) : Response.json(response())
    }
    return answerIndex(states.get(id), url, init)
  }
  const view = new NotificationActivity(chains, creator, chains.map(c => ({ chain: c.id, market, start_block: 1 })))
  const first = await view.load(20, {})
  assert.deepEqual(first.items.map(n => n.chain.id), [8453, 84532])
  assert.equal(new Set(first.items.map(keyNoticeId)).size, 2)
  assert.deepEqual(reads.sort(), [8453, 84532])
  fail.add(8453)
  const retained = await view.load(20, {})
  assert.equal(retained.sourcesRead, false)
  assert.equal(retained.keyError, true)
  assert.deepEqual(retained.items.map(n => n.chain.id), [8453, 84532])
})

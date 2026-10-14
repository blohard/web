// The host supplies reasons and bounded pages. This reader owns account,
// mute and chain isolation, with no body downloads during notification scans.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { zeroAddress } from 'viem'
import { load, mock, install, teardown, address, hash, response } from '../../../../scripts/harness.mjs'
import { answerIndex } from '../../../../scripts/index-fixture.mjs'
import { seeded } from '../../../../scripts/seeded.mjs'
const { muted } = await load('lib/muted.svelte.ts')
const { commitment } = await load('lib/api.ts')
const { MAX_REFERENCES, textReferences } = await load('lib/reference-syntax.ts')
const { linkify } = await load('lib/mentions.ts')
const TOMBSTONE = '0x0000000000000000000000000000000000000001'
const REMOVED = '0x0000000000000000000000000000000000000002'
const me = address('22'), other = address('77'), loud = address('88')
let states, calls, fail
const { NotificationDot } = await load('features/notifications/notification-dot.svelte.ts')
const { NotificationActivity } = await load('features/notifications/notification-activity.ts')
// The page as the reader sees it, without key activity: how many rows show, and
// which stay as newer ones arrive, is the page's (features/notifications/notification-activity.ts).
const findNotifications = (chains, who, limit = 20) => new NotificationActivity(chains, who, null).load(limit, {})
const { newestNotification } = await load('features/notifications/notifications.ts')

beforeEach(() => {
  install()
  states = new Map(); calls = []; fail = () => false
  addChain(mock.chain)
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://client.invalid')
    const state = states.get(Number(url.pathname.split('/')[3]))
    assert.ok(state, `unexpected non-index request: ${url}`)
    const body = init?.body ? JSON.parse(init.body) : {}
    calls.push({ url, body })
    if (fail(url, body)) return response({ error: 'index_unavailable' }, 503)
    return answerIndex(state, url, init)
  }
})
after(teardown)
function addChain(chain) {
  const state = { chain, rows: new Map(), associations: new Map(), events: [], at: { generation: hash('ab'), sequence: '0', checkpoint: { block: '1000', hash: hash('ac') } } }
  states.set(chain.id, state)
  return state
}
function associate(state, id, account = me, author = other, reason = { kind: 'mention', account }) {
  const row = { id: String(id), author, parent: '0', parent_author: zeroAddress, timestamp: 1700000000 + id,
    content_hash: hash('cc'), transaction: hash('dd'), position: { block: String(id), log: 0 },
    gate: zeroAddress, author_gate: zeroAddress, effective_gate: zeroAddress, replies: '0' }
  row.commitment = commitment({ author, parentId: 0n, timestamp: row.timestamp, contentHash: row.content_hash })
  state.rows.set(BigInt(id), row)
  state.associations.set(BigInt(id), { account, reference: reason })
  const sequence = String(BigInt(state.at.sequence) + 1n)
  state.at = { ...state.at, sequence }
  state.events.push({ sequence, event: { kind: 'references', id: String(id) } })
}
const found = (page) => page.items.map((r) => Number(r.post.id))

test('picked mentions, pasted references and quote chips share the occurrence cap', () => {
  const quote = `post://${mock.chain.id}/1?commit=${hash('cc')}`
  const composed = `${linkify(Array(7).fill('@alice').join(' '), { alice: me })}\n${quote}`
  assert.equal(textReferences(composed, MAX_REFERENCES + 1).length, 8)
  assert.equal(textReferences(`${composed}\n${quote}`, MAX_REFERENCES + 1).length, 9)
  assert.equal(textReferences(`${composed}\n${quote}`).length, 8)
  assert.deepEqual(textReferences('plain @alice and https://example.com'), [])
})

test('own and muted references are filtered without fetching any content', async () => {
  const state = states.get(mock.chain.id)
  associate(state, 1, me, me); associate(state, 2, me, loud); associate(state, 3)
  muted.toggle(loud)
  try {
    assert.deepEqual(found(await findNotifications([mock.chain], me)), [3])
    assert.deepEqual(calls.map((c) => c.url.pathname.split('/').at(-1)), ['notifications'])
  } finally { muted.toggle(loud) }
  assert.deepEqual(found(await findNotifications([mock.chain], me)), [3, 2], 'unmuting reuses held associations')
  assert.equal(calls.filter((c) => c.url.pathname.endsWith('/notifications')).length, 1)
})

test('different readers keep separate reference cursors and results', async () => {
  const state = states.get(mock.chain.id)
  associate(state, 1); associate(state, 2, loud)
  const [mine, theirs] = await Promise.all([findNotifications([mock.chain], me), findNotifications([mock.chain], loud)])
  assert.deepEqual(found(mine), [1]); assert.deepEqual(found(theirs), [2])
  assert.deepEqual(new Set(calls.map((c) => c.body.account)), new Set([me, loud]))
})

for (const gate of [TOMBSTONE, '0x0000000000000000000000000000000000000002']) test(`ending a reference (${gate}) updates held results without rescanning bodies`, async () => {
  const state = states.get(mock.chain.id)
  associate(state, 1)
  assert.deepEqual(found(await findNotifications([mock.chain], me)), [1])
  state.rows.set(1n, { ...state.rows.get(1n), gate, effective_gate: gate })
  const sequence = String(BigInt(state.at.sequence) + 1n)
  state.at = { ...state.at, sequence }
  state.events.push({ sequence, event: { kind: 'chain', event: { kind: 'reply_gate', id: '1', old: zeroAddress, new: gate, position: { block: '1000', log: 0 } } } })
  assert.deepEqual(found(await findNotifications([mock.chain], me)), [])
  assert.equal(calls.at(-1).url.pathname.endsWith('/changes'), true)
})

test('one failed chain retains earlier results while another accepts a late association', async () => {
  const second = { ...mock.chain, id: mock.chain.id + 1000 }
  const a = states.get(mock.chain.id), b = addChain(second)
  associate(a, 1); associate(b, 2)
  assert.deepEqual(found(await findNotifications([mock.chain, second], me)), [2, 1])
  associate(b, 3)
  fail = (url) => url.pathname.includes(`/${mock.chain.id}/`)
  const partial = await findNotifications([mock.chain, second], me)
  assert.deepEqual(found(partial), [3, 2, 1])
  assert.equal(partial.complete, false)
  fail = () => true
  await assert.rejects(findNotifications([mock.chain, second], me), /index unavailable/)
  fail = () => false
  assert.deepEqual(found(await findNotifications([mock.chain, second], me)), [3, 2, 1])
})

test('an indexed cross-chain quote carries its original pin without resolving the target again', async () => {
  const target = { chain: '999', id: '37', commit: hash('ef') }
  associate(states.get(mock.chain.id), 2, me, other, { kind: 'quote', target })
  const page = await findNotifications([mock.chain], me)
  assert.deepEqual(page.items[0].quoted, { chainId: 999, id: 37n, commit: target.commit })
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.pathname.endsWith('/notifications'))
})

test('the same chain id with a different Board starts a new reference view', async () => {
  associate(states.get(mock.chain.id), 1)
  assert.deepEqual(found(await findNotifications([mock.chain], me)), [1])
  const replacement = { ...mock.chain, contract: address('99') }
  const fresh = addChain(replacement)
  associate(fresh, 2)
  assert.deepEqual(found(await findNotifications([replacement], me)), [2])
  assert.equal(calls.at(-1).body.cursor, null)
})


test('indexed blocks filter mentions and quotes before paging, with chain and reader isolation', async () => {
  const { notificationList } = await load('features/account/blocking.ts')
  const state = states.get(mock.chain.id), list = notificationList(mock.chain, me)
  const change = (present) => {
    const sequence = String(BigInt(state.at.sequence) + 1n)
    state.at = { ...state.at, sequence }
    state.events.push({ sequence, event: { kind: 'chain', event: { kind: 'membership', list, member: loud, present, position: { block: '1000', log: 0 } } } })
  }
  associate(state, 1)
  for (let id = 2; id <= 30; id++) associate(state, id, me, loud,
    id % 2 ? { kind: 'mention', account: me } : { kind: 'quote', target: { chain: '999', id: '1', commit: hash('ef') } })
  change(true)
  assert.deepEqual(found(await findNotifications([mock.chain], me)), [1])
  assert.equal(calls.filter((c) => c.url.pathname.endsWith('/notifications')).length, 1, 'blocked authors do not consume page slots')
  assert.deepEqual(calls.find((c) => c.url.pathname.endsWith('/notifications')).body.exclude_list, list)
  associate(state, 31, other, loud)
  assert.deepEqual(found(await findNotifications([mock.chain], other)), [31], 'the owner is part of the list key')
  const second = { ...mock.chain, id: mock.chain.id + 1000 }
  associate(addChain(second), 32, me, loud)
  assert.deepEqual(found(await findNotifications([mock.chain, second], me)), [32, 1], 'source-chain blocklists are independent')
  change(false)
  assert.deepEqual(found(await findNotifications([mock.chain], me)), Array.from({ length: 20 }, (_, n) => 30 - n), 'unblock re-pages historical associations')
  change(true)
  assert.deepEqual(found(await findNotifications([mock.chain], me)), [1], 'block removes retained results')
  associate(state, 33, me, loud)
  assert.deepEqual(found(await findNotifications([mock.chain], me)), [1], 'new associations also exclude blocked authors')
})

function reply(state, id, mention = false) {
  associate(state, id)
  if (!mention) state.associations.delete(BigInt(id))
  const r = state.rows.get(BigInt(id))
  r.parent = '1'; r.parent_author = me
  r.commitment = commitment({ author: r.author, parentId: 1n, timestamp: r.timestamp, contentHash: r.content_hash })
  state.events.at(-1).event = { kind: 'chain', event: { kind: 'posted', message: structuredClone(r) } }
}

test('replies and references interleave once, including a late mention on a reply', async () => {
  const s = states.get(mock.chain.id)
  reply(s, 2); associate(s, 3); reply(s, 4, true); reply(s, 5)
  const first = await findNotifications([mock.chain], me)
  assert.deepEqual(found(first), [5, 4, 3, 2])
  assert.deepEqual(first.items.map((r) => r.kind), ['reply', 'mention', 'mention', 'reply'])
  s.associations.set(5n, { account: me, reference: { kind: 'mention', account: me } })
  const sequence = String(BigInt(s.at.sequence) + 1n)
  s.at = { ...s.at, sequence }
  s.events.push({ sequence, event: { kind: 'references', id: '5' } })
  reply(s, 6)
  const next = await findNotifications([mock.chain], me)
  assert.deepEqual(found(next), [6, 5, 4, 3, 2])
  assert.equal(next.items[1].kind, 'mention')
  assert.ok(calls.at(-1).body.scope.feed)
})

test('one twenty-row page interleaves chains and refresh retains displayed notifications', async () => {
  const second = { ...mock.chain, id: mock.chain.id + 1000 }
  const a = states.get(mock.chain.id), b = addChain(second)
  for (let id = 2; id <= 31; id++) { reply(a, id); associate(b, id) }
  const first = await findNotifications([mock.chain, second], me)
  assert.equal(first.items.length, 20)
  assert.equal(new Set(first.items.map((r) => `${r.chain.id}/${r.post.id}`)).size, 20)
  assert.deepEqual(found(first).slice(0, 4), [31, 31, 30, 30])
  associate(b, 32)
  const refreshed = await findNotifications([mock.chain, second], me)
  assert.equal(refreshed.items.length, 21)
  assert.equal(refreshed.items[0].post.id, 32n)
  const older = await findNotifications([mock.chain, second], me, refreshed.limit + 20)
  assert.equal(older.items.length, 41)
  assert.equal(older.complete, false)
})

for (const size of [100, 2000]) test(`notification request budget: ${size} historical items`, async () => {
  const state = states.get(mock.chain.id)
  state.at.checkpoint.block = String(size + 1)
  for (let id = 2; id <= size + 1; id++) reply(state, id, id % 2 === 0)
  const requests = () => calls.map((c) => c.url.pathname.split('/').at(-1))
  let page = await findNotifications([mock.chain], me)
  assert.equal(page.items.length, 20)
  assert.deepEqual(requests(), ['notifications'], 'one merged page; no bodies or per-row state reads')
  calls = []
  page = await findNotifications([mock.chain], me, 60)
  assert.equal(page.items.length, 60)
  assert.deepEqual(requests(), ['changes', 'notifications', 'notifications'])
  calls = []
  page = await findNotifications([mock.chain], me, 60)
  assert.deepEqual(requests(), ['changes'], 'idle refresh does not walk historical pages')
  const before = found(page), id = size + 2
  state.at = { ...state.at, checkpoint: { ...state.at.checkpoint, block: String(id) } }
  reply(state, id)
  calls = []
  page = await findNotifications([mock.chain], me, 60)
  assert.deepEqual(found(page), [id, ...before])
  assert.deepEqual(requests(), ['changes'])
  state.associations.set(BigInt(id), { account: me, reference: { kind: 'mention', account: me } })
  const sequence = String(BigInt(state.at.sequence) + 1n)
  state.at = { ...state.at, sequence }
  state.events.push({ sequence, event: { kind: 'references', id: String(id) } })
  calls = []
  page = await findNotifications([mock.chain], me, page.limit)
  assert.equal(page.items[0].kind, 'mention')
  assert.deepEqual(found(page), [id, ...before])
  assert.deepEqual(requests(), ['changes'], 'late body arrives through the index; no body scan or duplicated row')
})

for (let seed = 1; seed <= 16; seed++) test(`notification paging model seed ${seed}`, async () => {
  const next = seeded(seed), s = states.get(mock.chain.id), model = new Map(), trace = []
  let highest = 1, page, shown = []
  const emit = (event) => {
    const sequence = String(BigInt(s.at.sequence) + 1n)
    s.at = { ...s.at, sequence }
    s.events.push({ sequence, event })
  }
  const add = () => {
    const id = ++highest, kind = next(3), writer = [other, loud, me][next(3)]
    // Unrelated posts acquire their reference later, possibly behind the
    // historical cursor. Replies can acquire a mention without duplicating.
    reply(s, id, kind === 1)
    const row = s.rows.get(BigInt(id))
    row.author = writer
    if (kind !== 0) { row.parent = '0'; row.parent_author = zeroAddress }
    row.commitment = commitment({ author: writer, parentId: BigInt(row.parent), timestamp: row.timestamp, contentHash: row.content_hash })
    s.events.at(-1).event = { kind: 'chain', event: { kind: 'posted', message: structuredClone(row) } }
    model.set(id, { author: writer, reason: kind === 0 ? 'reply' : kind === 1 ? 'mention' : null, ended: false })
    trace.push(`post ${id} kind ${kind} author ${writer}`)
  }
  const eligible = () => [...model].filter(([, r]) => r.reason && !r.ended && r.author !== me && r.author !== loud)
    .sort(([a], [b]) => b - a)
  const check = () => {
    const actual = found(page), expected = new Map(eligible())
    assert.equal(new Set(actual).size, actual.length, 'no duplicate reply/mention')
    assert.deepEqual(actual, [...actual].sort((a, b) => b - a), 'newest first')
    for (const item of page.items) {
      assert.ok(expected.has(Number(item.post.id)), 'only eligible notifications')
      assert.equal(item.kind, expected.get(Number(item.post.id)).reason, 'late body updates the reason')
    }
    for (const id of shown) if (expected.has(id)) assert.ok(actual.includes(id), `refresh retained ${id}`)
    if (page.complete) assert.deepEqual(actual, [...expected.keys()], 'complete means no eligible row skipped')
    shown = actual
  }
  muted.toggle(loud)
  try {
    for (let n = 0; n < 180; n++) add()
    page = await findNotifications([mock.chain], me); check()
    for (let step = 0; step < 40; step++) {
      const action = next(4), id = 2 + next(highest - 1), r = model.get(id)
      trace.push(`step ${step}: action ${action}, id ${id}`)
      if (action === 0) for (let n = next(65) + 1; n > 0; n--) add()
      if (action === 1) {
        r.reason = next(2) ? 'mention' : 'quote'
        const reference = r.reason === 'mention' ? { kind: 'mention', account: me }
          : { kind: 'quote', target: { chain: '999', id: '9', commit: hash('ef') } }
        s.associations.set(BigInt(id), { account: me, reference })
        trace.push(`late ${r.reason} on ${id}`)
        emit({ kind: 'references', id: String(id) })
      }
      if (action === 2 && !r.ended) {
        r.ended = true
        const row = s.rows.get(BigInt(id))
        const gate = row.parent !== '0' && r.author !== me && next(2) ? REMOVED : TOMBSTONE
        Object.assign(row, { gate, effective_gate: gate })
        emit({ kind: 'chain', event: { kind: 'reply_gate', id: String(id), old: zeroAddress, new: gate, position: { block: '1000', log: step } } })
      }
      const limit = page.limit + (action === 3 ? 20 : 0)
      // Fail at a variable request, including after earlier change pages land.
      const failAfter = next(4), outage = next(3) === 0
      let requests = 0
      fail = () => outage && requests++ >= failAfter
      try { page = await findNotifications([mock.chain], me, limit); check() }
      catch (error) { assert.match(error.message, /index unavailable/) }
      finally { fail = () => false }
      page = await findNotifications([mock.chain], me, limit); check()
    }
    // Drain without faults and compare the whole result to the plain map,
    // independent of the fixture's paging and change-cursor implementation.
    for (let n = 0; !page.complete && n < 20; n++) {
      page = await findNotifications([mock.chain], me, page.limit + 20); check()
    }
    assert.equal(page.complete, true)
    assert.deepEqual(found(page), eligible().map(([id]) => id))
  } catch (error) {
    error.message += `\nseed ${seed}\n${trace.join('\n')}`
    throw error
  } finally { muted.toggle(loud) }
})

test('the indicator pages past muted and own activity just like the notifications page', async () => {
  const s = states.get(mock.chain.id)
  associate(s, 1)
  for (let id = 2; id <= 21; id++) associate(s, id, me, loud)
  muted.toggle(loud)
  try {
    assert.equal((await newestNotification(mock.chain, me)).timestamp, 1700000001)
    assert.equal(calls.length, 2)
    assert.deepEqual(found(await findNotifications([mock.chain], me)), [1])
  } finally { muted.toggle(loud) }
})

test('the indicator historical scan is bounded even when every row is muted', async () => {
  const s = states.get(mock.chain.id)
  for (let id = 1; id <= 200; id++) associate(s, id, me, loud)
  muted.toggle(loud)
  try {
    assert.equal((await newestNotification(mock.chain, me)).timestamp, null)
    assert.equal(calls.length, 8)
  } finally { muted.toggle(loud) }
})

test('indicator checks exclude blocked accounts at the host and retry failed reads', async () => {
  const dot = new NotificationDot(), s = states.get(mock.chain.id)
  const { notificationList } = await load('features/account/blocking.ts')
  const list = notificationList(mock.chain, me)
  associate(s, 7, me, loud)
  const sequence = String(BigInt(s.at.sequence) + 1n)
  s.at = { ...s.at, sequence }
  s.events.push({ sequence, event: { kind: 'chain', event: { kind: 'membership', list, member: loud, present: true, position: { block: '1000', log: 0 } } } })
  await dot.check([mock.chain], me, undefined)
  assert.equal(dot.shown(me), false)
  associate(s, 8)
  fail = () => true
  await dot.check([mock.chain], me, undefined)
  assert.equal(dot.shown(me), false)
  fail = () => false
  await dot.check([mock.chain], me, undefined)
  assert.equal(dot.shown(me), true, 'no additional activity is needed to retry')
  fail = () => true
  await dot.check([mock.chain], me, undefined)
  assert.equal(dot.shown(me), true, 'an outage preserves the known indicator')
})

test('concurrent checks share their request and account switches keep independent state', async () => {
  const dot = new NotificationDot(), s = states.get(mock.chain.id)
  associate(s, 2)
  const fetch = globalThis.fetch
  let release
  const waiting = new Promise(resolve => { release = resolve })
  globalThis.fetch = async (...args) => { await waiting; return fetch(...args) }
  const a = dot.check([mock.chain], me, undefined), b = dot.check([mock.chain], me, undefined)
  assert.equal(a, b)
  release()
  await a
  assert.equal(calls.length, 1)
  assert.equal(dot.shown(me), true)
  assert.equal(dot.shown(other), false)
  assert.equal(dot.shown(null), false)
  await dot.check([mock.chain], other, undefined)
  assert.equal(dot.shown(other), false)
})

test('acknowledgment clears hidden old activity but leaves activity heard after the load began', () => {
  const dot = new NotificationDot()
  dot.heard(me, 300)
  const visit = dot.begin(me)
  dot.heard(me, 400)
  dot.saw(visit, 200, true)
  assert.equal(dot.shown(me), true, '400 was never part of this visit')
  dot.saw(dot.begin(me), undefined, true)
  assert.equal(dot.shown(me), false, 'a successful empty view clears previously heard activity')
})

test('a slow key read cannot acknowledge newer posts missing from its displayed snapshot', async () => {
  const dot = new NotificationDot(), s = states.get(mock.chain.id)
  associate(s, 10)
  const activity = new NotificationActivity([mock.chain], me, [{ chain: mock.chain.id, market: address('77') }])
  let finishKeys
  activity.keys[0].load = () => new Promise(resolve => { finishKeys = resolve })
  const visit = dot.begin(me), pending = activity.load(20, {})
  await new Promise(setImmediate)
  associate(s, 20)
  await dot.check([mock.chain], me, undefined)
  finishKeys({ items: [], complete: true, truncated: false })
  const list = await pending
  assert.deepEqual(list.items.map(n => Number(n.post.id)), [10])
  dot.saw(visit, list.items[0]?.timestamp, list.sourcesRead)
  assert.equal(dot.shown(me), true)
  activity.keys[0].load = async () => ({ items: [], complete: true, truncated: false })
  const retry = dot.begin(me), refreshed = await activity.load(20, {})
  dot.saw(retry, refreshed.items[0]?.timestamp, refreshed.sourcesRead)
  assert.equal(dot.shown(me), false)
})

for (const unread of [1700000005, 1700000020]) test(`a failed key read acknowledges nothing, including a trade at ${unread}`, async () => {
  const dot = new NotificationDot(), s = states.get(mock.chain.id)
  associate(s, 10)
  const activity = new NotificationActivity([mock.chain], me, [{ chain: mock.chain.id, market: address('77') }])
  activity.keys[0].load = async () => { throw Error('key inbox unavailable') }
  dot.heard(me, unread)
  const visit = dot.begin(me), list = await activity.load(20, {})
  assert.equal(list.keyError, true)
  assert.equal(list.sourcesRead, false)
  dot.saw(visit, list.items[0]?.timestamp, list.sourcesRead)
  assert.equal(dot.shown(me), true)
  activity.keys[0].load = async () => ({ items: [], complete: true, truncated: false })
  const retry = dot.begin(me), next = await activity.load(20, {})
  dot.saw(retry, next.items[0]?.timestamp, next.sourcesRead)
  assert.equal(dot.shown(me), false)
})

test('a failed post chain acknowledges nothing when another chain succeeds', async () => {
  const dot = new NotificationDot(), second = { ...mock.chain, id: mock.chain.id + 1000 }
  associate(states.get(mock.chain.id), 10)
  associate(addChain(second), 40)
  await dot.check([mock.chain, second], me, undefined)
  const visit = dot.begin(me)
  fail = url => url.pathname.includes(`/${second.id}/`)
  const activity = new NotificationActivity([mock.chain, second], me, undefined)
  const list = await activity.load(20, {})
  assert.equal(list.keyError, false)
  assert.equal(list.sourcesRead, false)
  dot.saw(visit, list.items[0]?.timestamp, list.sourcesRead)
  assert.equal(dot.shown(me), true)
  fail = () => false
  const retry = dot.begin(me), next = await activity.load(20, {})
  dot.saw(retry, next.items[0]?.timestamp, next.sourcesRead)
  assert.equal(dot.shown(me), false)
})

test('more history to page does not mean a source failed', async () => {
  const dot = new NotificationDot(), s = states.get(mock.chain.id)
  for (let id = 1; id <= 30; id++) associate(s, id)
  await dot.check([mock.chain], me, undefined)
  const visit = dot.begin(me)
  const list = await new NotificationActivity([mock.chain], me, undefined).load(20, {})
  assert.equal(list.complete, false)
  assert.equal(list.sourcesRead, true)
  dot.saw(visit, list.items[0]?.timestamp, list.sourcesRead)
  assert.equal(dot.shown(me), false)
})

test('seen progress merges other tabs and ignores malformed stored values', () => {
  const dot = new NotificationDot(), saved = new Map()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } })
  const key = `blohard.notifications-seen.${me}`
  try {
    dot.saw(dot.begin(me), 100, true)
    saved.set(key, '200')
    dot.saw(dot.begin(me), 150, true)
    assert.equal(saved.get(key), '200')
    for (const invalid of ['"oops"', '{}', '-50', '1e40', 'null', 'bad json']) {
      saved.set(key, invalid)
      const fresh = new NotificationDot()
      fresh.heard(me, 100)
      assert.equal(fresh.shown(me), true)
    }
    saved.set(key, '300')
    const reload = new NotificationDot()
    reload.heard(me, 299)
    assert.equal(reload.shown(me), false)
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
  }
})

test('a failed cue confirmation retries on the next shared poll even with no new activity', async () => {
  const { QuietChanges, listening } = await load('features/streams/quiet-changes.ts')
  const dot = new NotificationDot(), s = states.get(mock.chain.id)
  await dot.check([mock.chain], me, undefined)
  const base = s.at, quiet = new QuietChanges(), listener = dot.listen(mock.chain, me)
  associate(s, 1)
  fail = url => url.pathname.endsWith('/notifications')
  const poll = async () => {
    await quiet.peek(mock.chain, base, listening({ gates: false }, listener), () => false, listener.heard)
    await new Promise(setImmediate)
  }
  await poll()
  assert.equal(dot.shown(me), false)
  fail = () => false
  calls.length = 0
  await poll()
  assert.equal(dot.shown(me), true)
  assert.deepEqual(calls.map(c => c.url.pathname.split('/').at(-1)), ['changes', 'notifications'])
  calls.length = 0
  await poll()
  assert.deepEqual(calls.map(c => c.url.pathname.split('/').at(-1)), ['changes'])
})

test('a blocked cue is confirmed only once, not on every shared poll', async () => {
  const { QuietChanges, listening } = await load('features/streams/quiet-changes.ts')
  const { notificationList } = await load('features/account/blocking.ts')
  const dot = new NotificationDot(), s = states.get(mock.chain.id)
  await dot.check([mock.chain], me, undefined)
  const base = s.at, quiet = new QuietChanges(), listener = dot.listen(mock.chain, me)
  associate(s, 5, me, loud)
  const list = notificationList(mock.chain, me), sequence = String(BigInt(s.at.sequence) + 1n)
  s.at = { ...s.at, sequence }
  s.events.push({ sequence, event: { kind: 'chain', event: { kind: 'membership', list, member: loud, present: true, position: { block: '1000', log: 0 } } } })
  for (let i = 0; i < 3; i++) {
    calls.length = 0
    await quiet.peek(mock.chain, base, listening({ gates: false }, listener), () => false, listener.heard)
    await new Promise(setImmediate)
    assert.equal(dot.shown(me), false)
    assert.equal(calls.filter(c => c.url.pathname.endsWith('/notifications')).length, i === 0 ? 1 : 0)
  }
})

test('the sidebar keeps cross-tab acknowledgments and checks notifications while hidden and on return', async () => {
  const dot = new NotificationDot(), saved = new Map(), listeners = new Set()
  const visibility = new Set(), focus = new Set(), timers = new Map()
  const originals = ['localStorage', 'window', 'document', 'setInterval', 'clearInterval'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)])
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener: (kind, f) => { assert.ok(['storage', 'focus'].includes(kind)); (kind === 'focus' ? focus : listeners).add(f) },
    removeEventListener: (kind, f) => { assert.ok(['storage', 'focus'].includes(kind)); (kind === 'focus' ? focus : listeners).delete(f) },
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    visibilityState: 'hidden', addEventListener: (_, fn) => visibility.add(fn), removeEventListener: (_, fn) => visibility.delete(fn),
  } })
  Object.defineProperty(globalThis, 'setInterval', { configurable: true, value: (run, ms) => { assert.equal(ms, 120_000); timers.set(run, run); return run } })
  Object.defineProperty(globalThis, 'clearInterval', { configurable: true, value: id => timers.delete(id) })
  try {
    associate(states.get(mock.chain.id), 1)
    const stop = dot.watch([mock.chain], me, undefined)
    await dot.check([mock.chain], me, undefined)
    assert.equal(calls.length, 1)
    assert.equal(dot.shown(me), true)
    const key = `blohard.notifications-seen.${me}`
    saved.set(key, '1700000002')
    for (const f of listeners) f({ key })
    assert.equal(dot.shown(me), false)
    saved.set(key, '1')
    for (const f of listeners) f({ key })
    assert.equal(saved.get(key), '1700000002', 'overlapping stale writes cannot regress seen progress')
    await new Promise(setImmediate)
    associate(states.get(mock.chain.id), 3)
    for (const run of timers.values()) run()
    await dot.check([mock.chain], me, undefined)
    await new Promise(setImmediate)
    assert.equal(calls.length, 2, 'hidden tabs check the indexed inbox every two minutes')
    assert.equal(dot.shown(me), true, 'new activity lights the favicon dot while hidden')
    document.visibilityState = 'visible'
    for (const returned of visibility) returned()
    await dot.check([mock.chain], me, undefined)
    await new Promise(setImmediate)
    assert.equal(calls.length, 3, 'return checks immediately')
    dot.saw(dot.begin(me), 1700000003, true)
    associate(states.get(mock.chain.id), 4)
    for (const returned of focus) returned()
    assert.equal(calls.length, 4, 'a visible window checks immediately on focus alone')
    for (const returned of focus) returned()
    for (const returned of visibility) returned()
    assert.equal(calls.length, 4, 'focus and visibility share the outstanding request')
    await new Promise(setImmediate)
    assert.equal(dot.shown(me), true, 'the focus check discovers the new notification')
    document.visibilityState = 'hidden'
    for (const returned of focus) returned()
    assert.equal(calls.length, 4, 'focus does not trigger another read while hidden')
    stop()
    assert.equal(focus.size, 0)
    assert.equal(visibility.size, 0)
    assert.equal(timers.size, 0)
    assert.equal(listeners.size, 0)
    const back = dot.watch([mock.chain], me, undefined)
    await new Promise(setImmediate)
    assert.equal(calls.length, 4, 'remounting does not repeat the app-load check')
    back()
  } finally {
    for (const [k, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor)
      else delete globalThis[k]
    }
  }
})

test('the load-time keys check finds an unread notice beyond twenty muted entries in one read', async () => {
  const dot = new NotificationDot(), market = address('99'), fetch = globalThis.fetch
  let keys = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://client.invalid')
    if (!url.pathname.includes('/keyring/')) return fetch(input, init)
    keys++
    assert.equal(url.searchParams.get('limit'), '100')
    return response({ market, active: true, truncated: false, checkpoint: { block: '100' }, next: null,
      items: Array.from({ length: 21 }, (_, i) => ({ kind: 'received', creator: other, from: i === 20 ? other : loud,
        amount: 1, timestamp: 1700000100 - i, transaction: hash('ee'), position: { block: String(100 - i), log: 0 } })) })
  }
  muted.toggle(loud)
  try {
    await dot.check([mock.chain], me, [{ chain: mock.chain.id, market }])
    assert.equal(keys, 1)
    assert.equal(dot.shown(me), true)
  } finally { muted.toggle(loud) }
})

test('the unread dot checks every indexed market on a served chain', async () => {
  const dot = new NotificationDot(), market = address('99'), fetch = globalThis.fetch
  const second = { ...mock.chain, id: mock.chain.id + 1 }
  states.set(second.id, { ...states.get(mock.chain.id), chain: second })
  const reads = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://client.invalid')
    if (!url.pathname.includes('/keyring/')) return fetch(input, init)
    const id = Number(url.pathname.split('/')[3]); reads.push(id)
    return response({ market, active: true, truncated: false, checkpoint: { block: '100' }, next: null,
      items: id === second.id ? [{ kind: 'received', creator: other, from: other, amount: 1, timestamp: 1700000100,
        transaction: hash('ee'), position: { block: '100', log: 0 } }] : [] })
  }
  assert.equal(await dot.check([mock.chain, second], me, [mock.chain, second].map(c => ({ chain: c.id, market }))), true)
  assert.deepEqual(reads.sort((a,b) => a-b), [mock.chain.id, second.id])
  assert.equal(dot.shown(me), true)
})

test('notifications after a backlog past the refresh budget load afresh', async () => {
  const s = states.get(mock.chain.id)
  associate(s, 1)
  assert.deepEqual(found(await findNotifications([mock.chain], me)), [1])
  for (let id = 2; id <= 230; id++) associate(s, id)
  const real = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const answer = await real(input, init)
    if (!String(input).endsWith('/changes') || !answer.ok) return answer
    const body = JSON.parse(init.body), data = await answer.clone().json()
    const through = String(BigInt(body.after) + 1n)
    return response({ ...data, changes: data.changes.filter((c) => BigInt(c.sequence) <= BigInt(through)), through, more: BigInt(through) < BigInt(data.until.sequence) })
  }
  try {
    assert.deepEqual(found(await findNotifications([mock.chain], me)).slice(0, 2), [230, 229])
  } finally { globalThis.fetch = real }
})

test('the page keeps every notification it showed when a newer one arrives', async () => {
  const second = { ...mock.chain, id: mock.chain.id + 1000 }
  const a = states.get(mock.chain.id), b = addChain(second)
  for (let id = 2; id <= 31; id++) { reply(a, id); associate(b, id) }
  const page = new NotificationActivity([mock.chain, second], me, null)
  const first = await page.load(20, {})
  assert.equal(first.items.length, 20)
  associate(b, 32)
  const next = await page.load(20, {})
  assert.equal(next.items.length, 21, 'the displaced oldest row stays')
  assert.equal(next.items[0].post.id, 32n)
  assert.deepEqual(next.items.slice(1).map(r => `${r.chain.id}/${r.post.id}`), first.items.map(r => `${r.chain.id}/${r.post.id}`))
})

test('a source failing on refresh keeps the rows it already showed', async () => {
  const second = { ...mock.chain, id: mock.chain.id + 1000 }
  const a = states.get(mock.chain.id), b = addChain(second)
  for (let id = 2; id <= 11; id++) { reply(a, id); associate(b, id) }
  const page = new NotificationActivity([mock.chain, second], me, null)
  const first = await page.load(20, {})
  assert.equal(first.items.length, 20)
  fail = (url) => Number(url.pathname.split('/')[3]) === second.id
  reply(a, 12)
  const next = await page.load(20, {})
  assert.equal(next.sourcesRead, false)
  assert.equal(next.items.length, 21, 'the failed chain\'s rows stay, and the new one is added')
  assert.equal(next.items[0].post.id, 12n)
})

test('reopening the page keeps the rows the reader had shown, more included', async () => {
  const a = states.get(mock.chain.id)
  for (let id = 2; id <= 61; id++) reply(a, id)
  const page = new NotificationActivity([mock.chain], me, null)
  await page.load(20, {})
  const more = await page.load(40, {})
  assert.equal(more.items.length, 40)
  const reopened = await new NotificationActivity([mock.chain], me, null).load(20, {})
  assert.equal(reopened.items.length, 40, 'a fresh page for the same reader keeps what was shown')
  assert.equal(reopened.limit, 40)
  const stranger = await new NotificationActivity([mock.chain], other, null).load(20, {})
  assert.ok(stranger.items.length <= 20, 'another reader starts afresh')
})

test('a load check that fails is tried again a few times, and stops with its watch', async () => {
  const saved = { window: globalThis.window, document: globalThis.document, setInterval, clearInterval }
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}
  const jobs = []
  const dot = new NotificationDot((run, ms) => {
    const job = { run, ms }
    jobs.push(job)
    return () => { jobs.splice(jobs.indexOf(job), 1) }
  })
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }
  try {
    associate(states.get(mock.chain.id), 8)
    fail = () => true
    const stop = dot.watch([mock.chain], me, undefined)
    await settle()
    assert.equal(dot.shown(me), false)
    assert.deepEqual(jobs.map((j) => j.ms), [30_000])
    jobs.shift().run(); await settle()
    assert.deepEqual(jobs.map((j) => j.ms), [60_000], 'the waits grow')
    fail = () => false
    jobs.shift().run(); await settle()
    assert.equal(dot.shown(me), true, 'found once the host answers')
    assert.equal(jobs.length, 0)
    stop()
    const again = dot.watch([mock.chain], me, undefined)
    await settle()
    assert.equal(jobs.length, 0, 'a checked account is not checked again')
    again()
    fail = () => true
    const stopOther = dot.watch([mock.chain], other, undefined)
    await settle()
    assert.equal(jobs.length, 1)
    stopOther()
    assert.equal(jobs.length, 0, 'stopping the watch cancels its retry')
  } finally { Object.assign(globalThis, saved) }
})

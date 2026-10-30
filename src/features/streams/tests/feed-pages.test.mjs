// Host cursors replace block walks. The client still counts visible groups,
// bounds each look and retains completed pages when a later page fails.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { curate, load, mock, install, teardown, address, hash, author, feedPost, feedHistory, ids, at, response } from '../../../../scripts/host-harness.mjs'
const { TOMBSTONE } = await load('lib/board.ts')
const { loadFeed, olderFeed, resumeFeed, feedCue } = await load('features/streams/feed.ts')
const { muted } = await load('lib/muted.svelte.ts')
beforeEach(install)
after(teardown)
const leads = (page) => ids(page.rows.map((r) => r.lead))
const pages = () => mock.calls.filter((c) => c.method === 'feed')

test('a first look reads twenty rows and reports the oldest actual posting time', async () => {
  feedHistory([at(100, 1), ...Array.from({ length: 25 }, (_, i) => at(300_000 + i, 100 + i))])
  const page = await loadFeed(mock.chain, { kind: 'timeline' })
  assert.equal(page.rows.length, 20)
  assert.equal(page.limit, 20)
  assert.equal(page.reach.getTime(), Number(mock.timestampOf(300_005n)) * 1000)
  assert.equal(page.complete, false)
  assert.deepEqual(pages().map((c) => [c.limit, c.cursor]), [[20, null]])
})

test('an empty old chain is one complete index page, independent of its block height', async () => {
  mock.head = 20_000_000n
  const page = await loadFeed(mock.chain, { kind: 'timeline' })
  assert.equal(page.complete, true)
  assert.equal(page.rows.length, 0)
  assert.equal(page.reach, null)
  assert.equal(pages().length, 1)
})

test('a look through hidden candidates stops after eight pages and continues only on request', async () => {
  const loud = address('aa')
  feedHistory(Array.from({ length: 400 }, (_, i) => feedPost(i + 1, 0, loud)))
  muted.toggle(loud)
  try {
    const filter = { kind: 'timeline' }
    const first = await loadFeed(mock.chain, filter)
    assert.equal(pages().length, 8)
    assert.equal(first.rows.length, 0)
    assert.equal(first.complete, false)
    mock.calls = []
    await olderFeed(mock.chain, filter)
    assert.equal(pages().length, 8)
    assert.equal(pages()[0].cursor.before, '241', 'continues below the last completed page')
  } finally { muted.toggle(loud) }
})

for (const hidden of ['mute', 'membership', 'deletion']) test(`${hidden} exclusions do not satisfy the visible page target`, async () => {
  const loud = address('88')
  const quiet = Array.from({ length: 5 }, (_, i) => feedPost(i + 1))
  const noise = Array.from({ length: 25 }, (_, i) => feedPost(i + 100, 0, loud))
  feedHistory([...quiet, ...noise])
  if (hidden === 'mute') muted.toggle(loud)
  if (hidden === 'membership') {
    curate([])
    mock.blocked = false
    curate([author])
  }
  if (hidden === 'deletion') for (const post of noise) mock.gates.set(post.id, TOMBSTONE)
  try {
    const page = await loadFeed(mock.chain, { kind: 'timeline', viewer: author, curatedOnly: hidden === 'membership' })
    assert.deepEqual(leads(page), [5, 4, 3, 2, 1])
    assert.equal(page.complete, true)
    assert.equal(pages().length, hidden === 'mute' ? 2 : 1, 'the host omits deletions and non-members; mutes are applied here')
    assert.ok(mock.calls.every((c) => !c.method.startsWith('eth_')))
  } finally { if (hidden === 'mute') muted.toggle(loud) }
})

test('an author-page reply waits for its parent page, then pairs once', async () => {
  const someone = address('33')
  const replies = Array.from({ length: 25 }, (_, i) => feedPost(i + 2, 1))
  feedHistory([feedPost(1, 0, someone), ...replies])
  const page = await loadFeed(mock.chain, { kind: 'author', address: someone, viewer: author })
  assert.deepEqual(leads(page), [26])
  assert.equal(page.rows[0].root.post.id, 1n)
  assert.equal(page.complete, true)
  assert.equal(pages().length, 2)
})

test('a recent reply to the reader’s old post is selected without loading the old feed range', async () => {
  const stranger = address('88'), followed = address('99')
  feedHistory([feedPost(1), ...Array.from({ length: 20 }, (_, i) => feedPost(100 + i, 0, followed)), feedPost(120, 1, stranger)])
  for (const filter of [{ kind: 'timeline', viewer: author }, { kind: 'following', includeRepliesToViewer: true, authors: [followed], viewer: author }]) {
    mock.calls = []
    const page = await loadFeed(mock.chain, filter)
    assert.ok(leads(page).includes(120))
    assert.equal(page.rows.length, 20)
    assert.equal(pages().length, 1)
    assert.ok(pages()[0].filter.any.some((c) => c.parent_authors?.includes(author)))
  }
})

test('a failed first page is retried with no cursor', async () => {
  feedHistory(Array.from({ length: 25 }, (_, i) => feedPost(i + 1)))
  mock.failRead = () => true
  await assert.rejects(loadFeed(mock.chain, { kind: 'timeline' }), /index unavailable/)
  mock.failRead = null
  assert.equal((await loadFeed(mock.chain, { kind: 'timeline' })).rows.length, 20)
  assert.deepEqual(pages().map((c) => c.cursor), [null, null])
})

test('a failed later page retains its prefix and resumes after it', async () => {
  const loud = address('88')
  feedHistory([...Array.from({ length: 25 }, (_, i) => feedPost(i + 1)), ...Array.from({ length: 20 }, (_, i) => feedPost(i + 100, 0, loud))])
  muted.toggle(loud)
  try {
    mock.failRead = (url, ask) => url.endsWith('/feed') && ask.cursor !== null
    await assert.rejects(loadFeed(mock.chain, { kind: 'timeline' }), /index unavailable/)
    mock.failRead = null; mock.calls = []
    const page = await loadFeed(mock.chain, { kind: 'timeline' })
    assert.equal(page.rows.length, 20)
    assert.equal(pages()[0].cursor.before, '100')
  } finally { muted.toggle(loud) }
})

for (const deleted of [false, true]) test(`paging twenty-five branches with ${deleted ? 'deleted' : 'live'} connecting replies`, async () => {
  const branches = Array.from({ length: 25 }, (_, i) => [feedPost(200 + 2 * i, 100, address('88')), feedPost(201 + 2 * i, 200 + 2 * i)]).flat()
  feedHistory([feedPost(1), feedPost(100), ...branches])
  if (deleted) for (let i = 0; i < 25; i++) mock.gates.set(BigInt(200 + 2 * i), TOMBSTONE)
  const filter = { kind: 'timeline', viewer: author }
  const page = await loadFeed(mock.chain, filter)
  if (deleted) {
    assert.equal(page.rows.length, 20, 'disconnected branches count as separate rows')
    assert.equal(page.complete, false)
    const more = await olderFeed(mock.chain, filter, 40)
    assert.ok(leads(more).includes(1))
    assert.equal(more.complete, true)
  } else {
    assert.ok(leads(page).includes(1), 'connected branches count as one row, leaving room for older posts')
    assert.equal(page.complete, true)
  }
})

test('the reader’s reply to an author’s reply stays on the replies tab', async () => {
  const someone = address('33')
  feedHistory([feedPost(1, 0, someone), feedPost(2, 1), feedPost(3, 2, someone), feedPost(4, 3)])
  const posts = await loadFeed(mock.chain, { kind: 'author', address: someone, viewer: author })
  assert.deepEqual(leads(posts), [2])
  const replies = await loadFeed(mock.chain, { kind: 'author-replies', address: someone, viewer: author })
  assert.deepEqual(leads(replies), [3])
  assert.equal(replies.rows[0].root.id, 1n)
  assert.deepEqual(ids(replies.rows[0].cards.map((c) => c.post)), [2, 3, 4])
})

// A list edit can reach the host before another browser's policy watcher.
test('paging across a policy edit keeps the page in place until refresh', async () => {
  curate([])
  feedHistory(Array.from({ length: 45 }, (_, i) => feedPost(i + 1)))
  const filter = { kind: 'timeline' }
  const first = await loadFeed(mock.chain, filter)
  mock.hostPolicy = { ...mock.hostPolicy, revision: '2', curated: [author] }
  feedHistory(Array.from({ length: 46 }, (_, i) => feedPost(i + 1)))
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/feed') && JSON.parse(init.body).cursor) return response({ error: 'reset_required' }, 409)
    return real(url, init)
  }
  try {
    await assert.rejects(olderFeed(mock.chain, filter), e => e.code === 'reset_required')
    assert.deepEqual(leads(await resumeFeed(mock.chain, filter)), leads(first), 'paging cannot act as a refresh')
    assert.equal(feedCue(mock.chain, filter), Infinity)
    mock.calls = []
    const refreshed = await loadFeed(mock.chain, filter)
    assert.equal(pages()[0].cursor, null, 'explicit refresh replaces the obsolete cursor')
    assert.equal(leads(refreshed)[0], 46)
    assert.equal(feedCue(mock.chain, filter), 0)
  } finally { globalThis.fetch = real }
})


test('profile reply paging appends older siblings without changing the displayed conversation', async () => {
  const stranger = address('44')
  const replies = Array.from({ length: 35 }, (_, i) => feedPost(100 + i, 1, author, stranger))
  feedHistory([feedPost(1, 0, stranger), ...replies])
  const filter = { kind: 'author-replies', address: author }
  const first = await loadFeed(mock.chain, filter, { limit: 1 })
  assert.equal(first.rows.length, 1)
  assert.equal(first.rows[0].cards.length, 20)
  assert.equal(first.complete, false)
  const next = await olderFeed(mock.chain, filter, 2)
  assert.equal(next.rows[0], first.rows[0], 'paging keeps the displayed row itself')
  const all = await olderFeed(mock.chain, filter, 40)
  const displayed = all.rows.flatMap(row => [...(row.root.omitted ? [] : [row.root.id]), ...row.cards.map(card => card.post.id)])
  assert.deepEqual(displayed.slice(0, 21), [1n, ...replies.slice(15).map(post => post.id)])
  assert.deepEqual([...displayed].sort((a, b) => Number(a - b)), [1n, ...replies.map(post => post.id)])
  assert.equal(all.complete, true)
  assert.deepEqual((await resumeFeed(mock.chain, filter, 40)).rows, all.rows, 'Back preserves the appended rows')
  const refreshed = await loadFeed(mock.chain, filter, { limit: 40 })
  assert.equal(refreshed.rows.length, 1, 'explicit refresh can combine the conversation')
  assert.deepEqual(ids(refreshed.rows[0].cards.map(card => card.post)), ids(replies))
})

// Local confirmations update retained streams, never a stream being read.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { curate, load, mock, install, teardown, address, author, feedPost, feedHistory, ids, hash } from '../../../../scripts/host-harness.mjs'
const feed = await load('features/streams/feed.ts')
const { readRoot, replySlice } = await load('features/streams/replies.ts')
const { expansionOf, RowExpansion } = await load('features/streams/stream-expansion')
const { refreshCue } = await load('shared/refresh-cue.svelte.ts')
const { wallet } = await load('lib/wallet.svelte.ts')
beforeEach(install)
after(teardown)
const filter = () => ({ kind: 'timeline', viewer: author })
const drawn = page => [...new Set(page.rows.flatMap(r => [r.root.id, ...r.cards.map(c => c.post.id)]))].map(Number).sort((a,b) => a-b)
const counted = async p => { const page = await p; await page.countsReady; return page }
// The component owns the UI cue; the model reports only to its mounted view.
function mountFeed(chain, filter, options) {
  const cue = refreshCue.cueCount()
  const leave = feed.mountFeed(chain, filter, cue.set, options)
  return () => { leave(); cue.stop() }
}


test('an off-screen stream merges only the local reply, without advancing its snapshot', async () => {
  const f = filter(), history = [feedPost(1)]
  feedHistory(history)
  await counted(feed.loadFeed(mock.chain, f))
  history.push(feedPost(2, 1), feedPost(3, 0, address('33')))
  feedHistory(history)
  assert.equal(await feed.peekFeed(mock.chain, f), 2)
  mock.calls = []
  await feed.acceptPublication(mock.chain, 2n, 1n)
  const resumed = await counted(feed.resumeFeed(mock.chain, f))
  assert.deepEqual(drawn(resumed), [1, 2])
  assert.equal(resumed.counts.get(1n), 1)
  assert.equal(feed.feedCue(mock.chain, f), 1)
  assert.equal(await feed.peekFeed(mock.chain, f), 1)
  assert.equal(mock.calls.filter(c => c.method === 'feed').length, 0)
  const refreshed = await counted(feed.loadFeed(mock.chain, f))
  assert.deepEqual(drawn(refreshed), [1, 2, 3])
  assert.equal(refreshed.counts.get(1n), 1)
})

test('own confirmation leaves a mounted stream in place without a refresh cue', async t => {
  const previous = wallet.account
  wallet.account = author
  t.after(() => { wallet.account = previous })
  const f = filter()
  feedHistory([feedPost(1)])
  const before = await counted(feed.loadFeed(mock.chain, f))
  const leave = mountFeed(mock.chain, f)
  try {
    feedHistory([feedPost(1), feedPost(2, 1)])
    await feed.acceptPublication(mock.chain, 2n, 1n)
    assert.deepEqual(drawn(await counted(feed.resumeFeed(mock.chain, f))), [1])
    assert.equal(before.counts.get(1n), 0)
    assert.equal(await feed.peekFeed(mock.chain, f), 0)
    assert.equal(refreshCue.count, 0)
    assert.deepEqual(drawn(await counted(feed.loadFeed(mock.chain, f))), [1, 2])
  } finally { leave() }
})

test('a refresh with only the merged reply has the same head and no duplicate', async () => {
  const f = filter()
  feedHistory([feedPost(1), feedPost(2)])
  await counted(feed.loadFeed(mock.chain, f))
  feedHistory([feedPost(1), feedPost(2), feedPost(3, 1)])
  await feed.acceptPublication(mock.chain, 3n, 1n)
  const resumed = await counted(feed.resumeFeed(mock.chain, f))
  const refreshed = await counted(feed.loadFeed(mock.chain, f))
  assert.equal(refreshed.rows[0].key, resumed.rows[0].key)
  // Refresh recalculates age cutoffs; the displayed conversation stays the same.
  const presentation = page => page.rows.map(({ previewAfter, ...row }) => row)
  assert.deepEqual(presentation(refreshed), presentation(resumed))
  assert.equal(await feed.peekFeed(mock.chain, f), 0)
})

test('local replies respect keyring selection and profile tabs', async () => {
  const other = address('33'), selected = { kind: 'following', includeRepliesToViewer: false, authors: [other], viewer: author }
  const profile = { kind: 'author', address: other, viewer: author }
  const replies = { kind: 'author-replies', address: other, viewer: author }
  feedHistory([feedPost(1, 0, other)])
  for (const f of [selected, profile, replies]) await counted(feed.loadFeed(mock.chain, f))
  feedHistory([feedPost(1, 0, other), feedPost(2, 1, author, other)])
  await feed.acceptPublication(mock.chain, 2n, 1n)
  assert.deepEqual(drawn(await counted(feed.resumeFeed(mock.chain, selected))), [1])
  assert.deepEqual(drawn(await counted(feed.resumeFeed(mock.chain, profile))), [1, 2])
  assert.deepEqual(drawn(await counted(feed.resumeFeed(mock.chain, replies))), [])
})

test('a publication does not enter a different chain, Board or index generation', async () => {
  const f = filter(), chain = mock.chain
  feedHistory([feedPost(1)])
  await counted(feed.loadFeed(chain, f))
  for (const target of [{ ...chain, id: chain.id + 1000 }, { ...chain, contract: address('99') }]) {
    await feed.acceptPublication(target, 2n, 1n)
    assert.deepEqual(drawn(await counted(feed.resumeFeed(chain, f))), [1])
  }
  mock.generation = hash('bb')
  feedHistory([feedPost(1), feedPost(2, 1)])
  await assert.doesNotReject(feed.acceptPublication(chain, 2n, 1n))
  assert.deepEqual(drawn(await counted(feed.resumeFeed(chain, f))), [1])
})

for (const size of [2, 20, 25]) test(`a retained branch with ${size} replies merges only if fully shown`, async () => {
  const f = filter(), history = [feedPost(1), ...Array.from({ length: size }, (_, i) => feedPost(i + 2, 1))]
  feedHistory(history)
  await counted(feed.loadFeed(mock.chain, f))
  new RowExpansion(expansionOf(feed.feedKey(mock.chain, f)), 1n).press(1n)
  const root = await readRoot(mock.chain, 1n)
  await replySlice(mock.chain, root.replies, 1n, 20)
  const mine = size + 2, unrelated = size + 3
  feedHistory([...history, feedPost(mine, 1), feedPost(unrelated, 1, address('33'))])
  await feed.acceptPublication(mock.chain, BigInt(mine), 1n)
  const reopened = await readRoot(mock.chain, 1n, true)
  const first = await replySlice(mock.chain, reopened.replies, 1n, 20)
  assert.equal(first.total, size + 2)
  assert.equal(ids(first.list).includes(mine), size <= 20)
  assert.equal(ids(first.list).includes(unrelated), false, 'returning never pulls unrelated new replies')
  const more = await replySlice(mock.chain, reopened.replies, 1n, 60)
  assert.equal(ids(more.list).filter(id => id === mine).length, 1)
})


test('a visible profile gets a cue without moving, and keeps it on return', async () => {
  const f = { kind: 'author', address: author }
  feedHistory([feedPost(1)])
  await counted(feed.loadFeed(mock.chain, f))
  let leave = mountFeed(mock.chain, f)
  try {
    feedHistory([feedPost(1), feedPost(2)])
    await feed.acceptPublication(mock.chain, 2n, 0n)
    assert.equal(refreshCue.count, 1)
    assert.deepEqual(drawn(await counted(feed.resumeFeed(mock.chain, f))), [1])
    leave()
    leave = mountFeed(mock.chain, f, { resume: true })
    assert.equal(refreshCue.count, 1)
  } finally { leave() }
})

test('failed point reads leave the normal refresh path available', async () => {
  const f = filter()
  feedHistory([feedPost(1)])
  await counted(feed.loadFeed(mock.chain, f))
  feedHistory([feedPost(1), feedPost(2, 1)])
  mock.failRead = url => url.includes('/message/')
  await feed.acceptPublication(mock.chain, 2n, 1n)
  mock.failRead = null
  assert.deepEqual(drawn(await counted(feed.resumeFeed(mock.chain, f))), [1])
  assert.equal(await feed.peekFeed(mock.chain, f), 1)
})

test('opening a stream while the publication read waits cannot move it', async () => {
  const f = filter()
  feedHistory([feedPost(1)])
  await counted(feed.loadFeed(mock.chain, f))
  feedHistory([feedPost(1), feedPost(2, 1)])
  const fetch = globalThis.fetch
  let release, started
  const hold = new Promise(r => { release = r }), waiting = new Promise(r => { started = r })
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/message/')) { started(); await hold }
    return fetch(url, init)
  }
  const applying = feed.acceptPublication(mock.chain, 2n, 1n)
  await waiting
  const leave = mountFeed(mock.chain, f)
  try {
    release(); await applying
    assert.deepEqual(drawn(await counted(feed.resumeFeed(mock.chain, f))), [1])
    assert.equal(await feed.peekFeed(mock.chain, f), 1)
  } finally { leave(); globalThis.fetch = fetch }
})

test('a cue read overtaken by the existing in-stream refresh cannot restore a stale count', async () => {
  const f = filter()
  feedHistory([feedPost(1)])
  await counted(feed.loadFeed(mock.chain, f))
  const leave = mountFeed(mock.chain, f), fetch = globalThis.fetch
  let release, started, held = false
  const hold = new Promise(r => { release = r }), waiting = new Promise(r => { started = r })
  feedHistory([feedPost(1), feedPost(2, 1)])
  globalThis.fetch = async (url, init) => {
    const response = await fetch(url, init)
    if (!held && String(url).endsWith('/changes')) { held = true; started(); await hold }
    return response
  }
  try {
    const applying = feed.acceptPublication(mock.chain, 2n, 1n)
    await waiting
    await feed.peekFeed(mock.chain, f)
    assert.equal(refreshCue.count, 1)
    await counted(feed.loadFeed(mock.chain, f))
    assert.equal(refreshCue.count, 0, 'the existing local refresh clears its cue')
    release(); await applying
    assert.equal(refreshCue.count, 0, 'a late cue must not restore a count from the previous snapshot')
  } finally { release(); leave(); globalThis.fetch = fetch }
})

for (const lateBeforeCleanup of [true, false]) test(`leaving Home for a thread preserves the thread cue, with the old poll finishing ${lateBeforeCleanup ? 'before' : 'after'} cleanup`, async t => {
  const f = filter()
  feedHistory([feedPost(1)])
  await counted(feed.loadFeed(mock.chain, f))
  const leave = mountFeed(mock.chain, f), fetch = globalThis.fetch
  let release, started
  const hold = new Promise(r => { release = r }), waiting = new Promise(r => { started = r })
  feedHistory([feedPost(1), feedPost(2, 1)])
  globalThis.fetch = async (url, init) => {
    const response = await fetch(url, init)
    if (String(url).endsWith('/changes')) { started(); await hold }
    return response
  }
  t.after(() => { release(); leave(); globalThis.fetch = fetch })
  const poll = feed.peekFeed(mock.chain, f)
  await waiting
  const thread = refreshCue.cueCount(4)
  t.after(thread.stop)
  if (lateBeforeCleanup) { release(); await poll; assert.equal(refreshCue.count, 4) }
  leave()
  assert.equal(refreshCue.count, 4)
  if (!lateBeforeCleanup) { release(); await poll; assert.equal(refreshCue.count, 4) }
})

test('an old mount of the same stream cannot unregister its replacement', async () => {
  const f = filter()
  feedHistory([feedPost(1)])
  await counted(feed.loadFeed(mock.chain, f))
  const leaveOld = mountFeed(mock.chain, f), leaveNew = mountFeed(mock.chain, f)
  try {
    leaveOld()
    feedHistory([feedPost(1), feedPost(2, 1)])
    await feed.acceptPublication(mock.chain, 2n, 1n)
    assert.equal(refreshCue.count, 1, 'the replacement owns the local publication cue')
    assert.deepEqual(drawn(await counted(feed.resumeFeed(mock.chain, f))), [1], 'it is still visible, so the publication cannot move its rows')
  } finally { leaveOld(); leaveNew() }
})

test('a failed feed poll preserves its mounted cue', async () => {
  const f = filter()
  feedHistory([feedPost(1)])
  await counted(feed.loadFeed(mock.chain, f))
  const leave = mountFeed(mock.chain, f)
  try {
    feedHistory([feedPost(1), feedPost(2)])
    await feed.peekFeed(mock.chain, f)
    assert.equal(refreshCue.count, 1)
    mock.failRead = url => url.endsWith('/changes')
    await assert.rejects(feed.peekFeed(mock.chain, f))
    assert.equal(refreshCue.count, 1)
  } finally { mock.failRead = null; leave() }
})

for (const [resume, title] of [[false, 'a fresh visit does not flash'], [true, 'resuming restores']]) test(`${title} the retained refresh cue`, async t => {
  const f = filter()
  feedHistory([feedPost(1)])
  await counted(feed.loadFeed(mock.chain, f))
  feedHistory([feedPost(1), feedPost(2)])
  assert.equal(await feed.peekFeed(mock.chain, f), 1)
  const counts = []
  const leave = feed.mountFeed(mock.chain, f, count => counts.push(count), { resume })
  t.after(leave)
  assert.deepEqual(counts, [resume ? 1 : 0], 'only a retained snapshot restores its old cue')
  if (!resume) {
    await counted(feed.loadFeed(mock.chain, f, { preserveVisibleRows: false }))
    assert.ok(counts.every(count => count === 0), 'the fresh load already includes that post')
  }
})


for (const kind of ['timeline', 'curated', 'following', 'profile']) test(`${kind} refresh ignores own activity from another tab and still loads it on refresh`, async t => {
  const previous = wallet.account, other = address('33')
  t.after(() => { wallet.account = previous })
  wallet.account = null
  curate([author, other])
  const f = kind === 'profile' ? { kind: 'author', address: author }
    : kind === 'following' ? { kind: 'following', authors: [author, other], viewer: author, includeRepliesToViewer: true }
    : { kind: 'timeline', viewer: author, curatedOnly: kind === 'curated' }
  const posts = [feedPost(1)]
  feedHistory(posts)
  await counted(feed.loadFeed(mock.chain, f))
  if (kind === 'timeline') {
    const row = new RowExpansion(expansionOf(feed.feedKey(mock.chain, f)), 1n)
    row.press(1n); row.shown.add(1n)
    const root = await readRoot(mock.chain, 1n)
    await replySlice(mock.chain, root.replies, 1n, 20)
  }
  posts.push(feedPost(2), feedPost(3, 1))
  feedHistory(posts)
  assert.equal(await feed.peekFeed(mock.chain, f), kind === 'profile' ? 1 : 2)
  wallet.account = author
  assert.equal(await feed.peekFeed(mock.chain, f), 0, 'an already queued own post stops counting too')
  posts.push(feedPost(4, 0, other), feedPost(5, 1, other, author))
  feedHistory(posts)
  assert.equal(await feed.peekFeed(mock.chain, f), kind === 'profile' ? 0 : 2, 'other authors still cue normally')
  const refreshed = await counted(feed.loadFeed(mock.chain, f))
  assert.ok(drawn(refreshed).includes(2), 'the cue filter never excludes own posts from the feed')
  if (kind !== 'profile') assert.ok(drawn(refreshed).includes(3), 'new own replies bypass automatic folding too')
})

for (const resume of [false, true]) test(`a poll waits for an in-flight ${resume ? 'resume' : 'first load'} without moving the snapshot`, async t => {
  const f = filter()
  feedHistory([feedPost(1)])
  if (resume) await counted(feed.loadFeed(mock.chain, f))
  const leave = mountFeed(mock.chain, f, { resume })
  t.after(leave)
  if (resume) feedHistory([feedPost(1), feedPost(2)])
  const loading = resume ? feed.resumeFeed(mock.chain, f) : feed.loadFeed(mock.chain, f)
  const polling = feed.peekFeed(mock.chain, f)
  assert.equal(await polling, resume ? 1 : 0)
  assert.equal(refreshCue.count, resume ? 1 : 0)
  assert.deepEqual(drawn(await counted(loading)), [1])
})

test('a poll waiting for a load cannot overwrite a different stream cue', async t => {
  const f = filter()
  feedHistory([feedPost(1)])
  await counted(feed.loadFeed(mock.chain, f))
  const leave = mountFeed(mock.chain, f)
  t.after(leave)
  feedHistory([feedPost(1), feedPost(2)])
  const loading = feed.resumeFeed(mock.chain, f)
  const polling = feed.peekFeed(mock.chain, f)
  leave()
  const other = { kind: 'author', address: address('44') }
  const leaveOther = mountFeed(mock.chain, other)
  t.after(leaveOther)
  assert.equal(await polling, 1)
  await loading
  assert.equal(refreshCue.count, 0)
})

for (const kind of ['timeline', 'curated', 'following']) test(`${kind} posting does not cue replies that its fresh branch already shows`, async t => {
  const previous = wallet.account, other = address('33')
  wallet.account = author
  t.after(() => { wallet.account = previous })
  if (kind === 'curated') curate([author, other])
  const f = kind === 'following'
    ? { kind: 'following', authors: [author, other], viewer: author, includeRepliesToViewer: true }
    : { kind: 'timeline', viewer: author, curatedOnly: kind === 'curated' }
  const posts = [feedPost(1)]
  feedHistory(posts)
  await counted(feed.loadFeed(mock.chain, f))
  const leave = mountFeed(mock.chain, f)
  t.after(leave)
  const row = new RowExpansion(expansionOf(feed.feedKey(mock.chain, f)), 1n)
  row.landed(1n, 3n)
  row.shown.add(1n)
  posts.push(feedPost(2, 1, other, author), feedPost(3, 1))
  feedHistory(posts)
  assert.equal(await feed.peekFeed(mock.chain, f), 1, 'the other reply is new before the list loads')
  const root = await readRoot(mock.chain, 1n)
  const shown = await replySlice(mock.chain, root.replies, 1n, 20)
  assert.deepEqual(ids(shown.list), [2, 3])
  await feed.acceptPublication(mock.chain, 3n, 1n)
  assert.equal(await feed.peekFeed(mock.chain, f), 0, 'the other reply is already in the open list')
  assert.equal(refreshCue.count, 0)
  posts.push(feedPost(4, 1, other, author))
  feedHistory(posts)
  assert.equal(await feed.peekFeed(mock.chain, f), 1, 'a later reply still cues normally')
})

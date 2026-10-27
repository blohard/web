// Thread-specific rendering rules. Cursor, refresh and overlap races are
// covered with scripted host responses in api.test.mjs.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, author, address, feedPost, feedHistory, gateChanged, ids, deferred } from '../../../../scripts/host-harness.mjs'
const { readThread, readRoot, readEarlier, replySlice, acceptReply, peekReplies, copyReplySessions } = await load('features/streams/replies.ts')
const { readMessage } = await load('lib/messages.ts')
const { TOMBSTONE, REMOVED } = await load('lib/board.ts')
const sessions = new Map()
beforeEach(() => { sessions.clear(); install() })
after(teardown)

test('grouping a deep conversation uses no recursive stack and preserves ancestor order', async () => {
  const { withInlined } = await load('features/streams/conversation.ts')
  const replies = Array.from({ length: 15000 }, (_, i) => feedPost(i + 2, i + 1))
  const { chains } = withInlined([], replies)
  assert.equal(chains.get(2n).length, 14999)
  assert.equal(chains.get(2n)[0].id, 3n)
  assert.equal(chains.get(2n).at(-1).id, 15001n)
})

test('deleted direct replies leave lists and counts while surviving descendants retain context', async () => {
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 2), feedPost(4, 1)])
  mock.gates.set(2n, TOMBSTONE)
  const root = await readThread(sessions, mock.chain, 1n)
  assert.equal(root.replies.counts.get(1n), 1)
  const direct = await replySlice(mock.chain, root.replies, 1n, 20)
  assert.deepEqual(ids(direct.list), [4])
  assert.equal(direct.total, 1)
  assert.equal(direct.more, false)
  assert.deepEqual(mock.calls.filter((c) => c.method === 'replies').map((c) => c.parent), ['1'])
  const child = await readThread(sessions, mock.chain, 3n)
  assert.equal(child.parent.id, 2n)
  assert.equal(child.parent.gate, TOMBSTONE, 'a direct visit to the surviving reply retains deleted parent context')
})

test('moderator removals hide the branch from its parent but preserve direct access', async () => {
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 2)])
  mock.gates.set(2n, REMOVED)
  const root = await readRoot(sessions, mock.chain, 1n)
  const direct = await replySlice(mock.chain, root.replies, 1n, 20)
  assert.deepEqual(ids(direct.list), [])
  assert.equal(direct.total, 0)
  assert.equal(direct.more, false)
  const removed = await readThread(sessions, mock.chain, 2n)
  assert.equal(removed.gate, REMOVED)
  assert.deepEqual(ids((await replySlice(mock.chain, removed.replies, 2n, 20)).list), [3])
})

test('ended replies take no page slots and refresh drops them without scanning descendants', async () => {
  feedHistory([feedPost(1), ...Array.from({ length: 25 }, (_, i) => feedPost(i + 2, 1)), feedPost(27, 2)])
  mock.gates.set(2n, TOMBSTONE); mock.gates.set(3n, TOMBSTONE); mock.gates.set(4n, REMOVED)
  const root = await readThread(sessions, mock.chain, 1n)
  const first = await replySlice(mock.chain, root.replies, 1n, 20)
  assert.equal(first.total, 22)
  assert.equal(first.list.length, 20)
  assert.deepEqual(ids(first.list).slice(0, 3), [5, 6, 7])
  const more = await replySlice(mock.chain, root.replies, 1n, 40)
  assert.equal(more.list.length, 22)
  assert.equal(more.more, false)
  assert.deepEqual(more.list.slice(0, 20), first.list)
  gateChanged(5n, TOMBSTONE, 28n); gateChanged(6n, REMOVED, 28n)
  const updated = await readThread(sessions, mock.chain, 1n)
  const after = await replySlice(mock.chain, updated.replies, 1n, 40)
  assert.equal(after.total, 20)
  assert.equal(after.list.length, 20)
  assert.equal(after.more, false)
  assert.ok(!ids(after.list).includes(5))
  assert.ok(!ids(after.list).includes(6))
  assert.ok(mock.calls.filter((c) => c.method === 'replies').every((c) => c.parent === '1'))
  const child = await replySlice(mock.chain, after.children, 2n, 20)
  assert.deepEqual(ids(child.list), [27], 'a direct visit to the deleted post can still read its children')
})

test('deleting a thread root changes its classification without tearing down its replies', async () => {
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 2)])
  const first = await readThread(sessions, mock.chain, 2n)
  const branch = await replySlice(mock.chain, first.replies, 2n, 20)
  assert.deepEqual(ids(branch.list), [3])
  gateChanged(2n, TOMBSTONE, 4n)
  const next = await readThread(sessions, mock.chain, 2n)
  assert.equal(next.gate, TOMBSTONE)
  assert.equal(next.parent.id, 1n, 'live replies still need this context')
  assert.equal(next.replies.session, first.replies.session)
  assert.deepEqual(ids((await replySlice(mock.chain, next.replies, 2n, 20)).list), [3])
  gateChanged(3n, TOMBSTONE, 5n)
  const empty = await readThread(sessions, mock.chain, 2n)
  assert.equal(empty.parent.id, 1n, 'the addressed post keeps its own context')
  assert.equal(empty.replies.counts.get(2n), 0)
  assert.deepEqual(ids((await replySlice(mock.chain, empty.replies, 2n, 20)).list), [])
})

test('extending the visible prefix appends one page with counts and fetches no nested branches', async () => {
  feedHistory([feedPost(1), ...Array.from({ length: 45 }, (_, i) => feedPost(i + 2, 1))])
  const root = await readThread(sessions, mock.chain, 1n)
  const first = await replySlice(mock.chain, root.replies, 1n, 20)
  mock.calls = []
  const more = await replySlice(mock.chain, root.replies, 1n, 40)
  assert.deepEqual(more.list.slice(0, 20), first.list)
  assert.equal(more.children.counts.size, 41)
  assert.deepEqual(mock.calls.map((c) => c.method), ['replies'])
  assert.equal(mock.calls[0].cursor.after, '21')
  assert.equal(mock.calls[0].parent, '1')
})

test('deep branches load on demand, reopen from the session, and reveal a new reply in place', async () => {
  const history = Array.from({ length: 102 }, (_, i) => feedPost(i + 1, i))
  feedHistory(history)
  const root = await readThread(sessions, mock.chain, 1n)
  mock.calls = []
  let page = root.replies
  for (let parent = 1n; parent <= 100n; parent++) {
    const branch = await replySlice(mock.chain, page, parent, 20)
    assert.deepEqual(ids(branch.list), [Number(parent + 1n)])
    assert.equal(branch.children.counts.get(parent + 1n), 1, 'the next card can expand again')
    page = branch.children
  }
  assert.deepEqual(mock.calls.filter((c) => c.method === 'replies').map((c) => c.parent),
    Array.from({ length: 100 }, (_, i) => String(i + 1)), 'only explicitly opened branches are fetched')

  mock.calls = []
  const reopened = await replySlice(mock.chain, page, 50n, 20)
  assert.deepEqual(ids(reopened.list), [51])
  assert.equal(mock.calls.length, 0, 'reopening does not fetch the branch again')

  feedHistory([...history, feedPost(103, 100)])
  const refreshed = await readThread(sessions, mock.chain, 1n)
  assert.equal(refreshed.replies.session, root.replies.session)
  const landed = await replySlice(mock.chain, refreshed.replies, 100n, 20, 103n)
  assert.deepEqual(ids(landed.list), [101, 103])
  assert.equal(landed.children.counts.get(101n), 1, 'the existing deeper branch remains available')
  assert.deepEqual(ids((await replySlice(mock.chain, landed.children, 50n, 20)).list), [51])
})

test('revealing a new reply reads it directly and leaves the older cursor in place', async () => {
  feedHistory([feedPost(1), ...Array.from({length:2000}, (_, i) => feedPost(i+2,1))])
  const root = await readRoot(sessions, mock.chain,1n)
  mock.calls=[]
  const page = await replySlice(mock.chain,root.replies,1n,20,2001n)
  assert.deepEqual(ids(page.list), [...Array.from({length:20},(_,i)=>i+2),2001])
  assert.equal(page.tailStart,2001n)
  assert.equal(page.more,true)
  assert.equal(mock.calls.filter((c)=>c.method==='replies').length,0,'the first page came with the branch')
  assert.equal(mock.calls.filter((c)=>c.method==='message').length,1)
  const older=await replySlice(mock.chain,page.children,1n,40)
  assert.deepEqual(ids(older.list),[...Array.from({length:40},(_,i)=>i+2),2001])
  assert.equal(older.loaded,40)
})

test('a thread refresh answers from the changes it read, without reading the root again', async () => {
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 2)])
  const first = await readThread(sessions, mock.chain, 2n)
  await replySlice(mock.chain, first.replies, 2n, 20)
  gateChanged(2n, TOMBSTONE, 4n)
  mock.calls = []
  const next = await readThread(sessions, mock.chain, 2n)
  assert.equal(next.record.id, 2n)
  assert.equal(next.gate, TOMBSTONE, 'the change log brought the root up to date')
  assert.equal(next.parent.id, 1n)
  assert.ok(mock.calls.some((c) => c.method === 'changes'))
  assert.equal(mock.calls.filter((c) => c.method === 'message').length, 0, 'no second read of the root')
  await assert.rejects(readThread(sessions, mock.chain, 2n, `0x${'ff'.repeat(32)}`), 'a pin the session does not hold is read, and refused, as before')
})

test('a branch opened in place reads its root with its first reply page, then pages on from there', async () => {
  feedHistory([feedPost(1), ...Array.from({ length: 30 }, (_, i) => feedPost(i + 2, 1))])
  mock.calls = []
  const root = await readRoot(sessions, mock.chain, 1n)
  assert.equal(root.record.id, 1n)
  assert.equal(root.replies.counts.get(1n), 30)
  assert.deepEqual(mock.calls.map((c) => c.method).filter((m) => m !== 'changes'), ['replies'], 'one read: the page carries its parent')
  mock.calls = []
  const first = await replySlice(mock.chain, root.replies, 1n, 20)
  assert.deepEqual(ids(first.list), Array.from({ length: 20 }, (_, i) => i + 2))
  assert.equal(mock.calls.length, 0, 'the list starts from the page already read')
  const more = await replySlice(mock.chain, root.replies, 1n, 40)
  assert.equal(more.list.length, 30)
  assert.equal(mock.calls.filter((c) => c.method === 'replies').length, 1, 'the next page follows the cursor')
})


for (const size of [2, 20, 25]) test(`local count updates preserve the requested window of a ${size}-reply branch until show more`, async () => {
  const history = [feedPost(1), ...Array.from({ length: size }, (_, i) => feedPost(i + 2, 1))]
  feedHistory(history)
  const root = await readRoot(sessions, mock.chain, 1n)
  const initial = await replySlice(mock.chain, root.replies, 1n, 20)
  assert.equal(initial.more, size > 20)

  const mine = size + 2, other = size + 3
  feedHistory([...history, feedPost(mine, 1), feedPost(other, 1)])
  const answer = await readMessage(mock.chain, BigInt(mine), 1)
  await acceptReply(sessions, mock.chain, [1n], answer.at, answer.record, answer.ancestors[0])
  mock.calls = []

  const resumed = await readRoot(sessions, mock.chain, 1n, true)
  const kept = await replySlice(mock.chain, resumed.replies, 1n, 20)
  const expected = ids(initial.list)
  if (size <= 20) expected.push(mine)
  assert.deepEqual(ids(kept.list), expected, 'only a fully loaded branch appends the local reply')
  assert.equal(kept.total, size + 2, 'the parent count includes both new replies')
  assert.equal(kept.more, true, 'the unseen gap remains reachable')
  assert.deepEqual(mock.calls, [], 'resuming does not fetch the gap or refresh the branch')

  const expanded = await replySlice(mock.chain, resumed.replies, 1n, 40)
  assert.deepEqual(ids(expanded.list), Array.from({ length: size + 2 }, (_, i) => i + 2))
  assert.equal(expanded.more, false)
  assert.ok(mock.calls.some(c => c.method === 'changes'), 'show more refreshes the gap after the saved pages')
  if (size > 20) assert.ok(mock.calls.some(c => c.method === 'replies'), 'partial branches also finish their saved paging')
})

test('earlier thread context keeps reply counts in its session through reopening and refresh', async () => {
  const history = [feedPost(1), feedPost(2, 1), feedPost(3, 1), feedPost(4, 2), feedPost(6, 2)]
  feedHistory(history)
  const first = await readThread(sessions, mock.chain, 6n)
  assert.equal(first.replies.counts.get(2n), 2)
  mock.calls = []
  const earlier = await readEarlier(mock.chain, first.replies, 1n, 4)
  assert.deepEqual(ids(earlier), [1])
  assert.equal(first.replies.counts.get(1n), 2)
  assert.deepEqual(mock.calls.map(c => c.method), ['message'], 'one bounded ancestor read, no reply pages')
  assert.equal(new URL(mock.calls[0].url, 'https://client.invalid').searchParams.get('ancestors'), '3')
  const reopened = await readThread(sessions, mock.chain, 6n)
  assert.equal(reopened.replies.counts.get(1n), 2)
  feedHistory([...history, feedPost(7, 1)])
  mock.calls = []
  const refreshed = await readThread(sessions, mock.chain, 6n)
  assert.equal(refreshed.replies.counts.get(1n), 3, 'refresh includes older context without another ancestor read')
  assert.ok(mock.calls.every(c => c.method === 'changes'))
})

test('visible replies beyond the first page survive expansion and later paging without duplicates', async () => {
  feedHistory([feedPost(1), ...Array.from({ length: 45 }, (_, i) => feedPost(i + 2, 1))])
  const root = await readRoot(sessions, mock.chain, 1n)
  const keep = [40n, 44n]
  const first = await replySlice(mock.chain, root.replies, 1n, 20, undefined, keep)
  assert.deepEqual(ids(first.list), [...Array.from({ length: 20 }, (_, i) => i + 2), 40, 44])
  assert.equal(first.tailStart, 40n)
  assert.equal(first.more, true)
  const more = await replySlice(mock.chain, root.replies, 1n, 40, undefined, keep)
  assert.deepEqual(ids(more.list), [...Array.from({ length: 40 }, (_, i) => i + 2), 44])
  const all = await replySlice(mock.chain, root.replies, 1n, 60, undefined, keep)
  assert.deepEqual(ids(all.list), Array.from({ length: 45 }, (_, i) => i + 2))
  assert.equal(all.more, false)
})


test('dismissed preview pins leave the shared reply session without fetching the gap', async () => {
  feedHistory([feedPost(1), ...Array.from({ length: 25 }, (_, i) => feedPost(i + 2, 1))])
  const root = await readRoot(sessions, mock.chain, 1n)
  const kept = await replySlice(mock.chain, root.replies, 1n, 20, undefined, [26n])
  const prefix = Array.from({ length: 20 }, (_, i) => i + 2)
  assert.deepEqual(ids(kept.list), [...prefix, 26])
  mock.calls = []
  const reopened = await replySlice(mock.chain, root.replies, 1n, 20)
  assert.deepEqual(ids(reopened.list), prefix, 'a cached preview record is not a persistent pin')
  assert.equal(reopened.tailStart, null)
  assert.equal(reopened.more, true)
  assert.deepEqual(mock.calls, [], 'dismissing the preview does not read more replies')
  const more = await replySlice(mock.chain, root.replies, 1n, 40)
  assert.deepEqual(ids(more.list), Array.from({ length: 25 }, (_, i) => i + 2))
})


test('own replies never cue a thread refresh, but remain available on refresh', async t => {
  const { wallet } = await load('lib/wallet.svelte.ts')
  const previous = wallet.account
  wallet.account = author
  t.after(() => { wallet.account = previous })
  const posts = [feedPost(1)]
  feedHistory(posts)
  const root = await readRoot(sessions, mock.chain, 1n)
  await replySlice(mock.chain, root.replies, 1n, 20)
  posts.push(feedPost(2, 1))
  feedHistory(posts)
  assert.equal(await peekReplies(mock.chain, root.replies, [1n]), 0)
  posts.push(feedPost(3, 1, address('33'), author))
  feedHistory(posts)
  assert.equal(await peekReplies(mock.chain, root.replies, [1n]), 1)
  const refreshed = await readRoot(sessions, mock.chain, 1n)
  assert.deepEqual(ids((await replySlice(mock.chain, refreshed.replies, 1n, 20)).list), [2, 3])
})


test('copied sessions keep their loaded pages, counts and pins without rereading them', async () => {
  const history = [feedPost(1), ...Array.from({ length: 45 }, (_, i) => feedPost(i + 2, 1))]
  feedHistory(history)
  const original = await readThread(sessions, mock.chain, 1n)
  const first = await replySlice(mock.chain, original.replies, 1n, 20, 46n)
  const copied = copyReplySessions(sessions)
  mock.calls = []
  const next = await readThread(copied, mock.chain, 1n, undefined, true)
  assert.deepEqual(ids((await replySlice(mock.chain, next.replies, 1n, 20)).list), ids(first.list))
  assert.deepEqual(mock.calls, [], 'copying and returning reuse the loaded snapshot')

  await replySlice(mock.chain, original.replies, 1n, 40, 45n)
  feedHistory([...history, feedPost(47, 1)])
  const updated = await readThread(sessions, mock.chain, 1n)
  assert.equal(updated.replies.counts.get(1n), 46)
  mock.calls = []
  const resumed = await readThread(copied, mock.chain, 1n, undefined, true)
  assert.equal(resumed.replies.counts.get(1n), 45, 'a refresh cannot overwrite the copied records')
  assert.deepEqual(ids((await replySlice(mock.chain, resumed.replies, 1n, 20)).list), ids(first.list), 'paging and new pins stay in the original visit')
  assert.deepEqual(mock.calls, [])
  const more = await replySlice(mock.chain, resumed.replies, 1n, 40)
  assert.deepEqual(ids(more.list), [...Array.from({ length: 40 }, (_, i) => i + 2), 46])
  assert.deepEqual(mock.calls.map(c => [c.method, c.cursor?.after]), [['replies', '21']], 'the copy follows its own saved cursor')
})

test('copying during paging starts fresh queues and ignores the original late answer', { timeout: 3000 }, async t => {
  feedHistory([feedPost(1), ...Array.from({ length: 30 }, (_, i) => feedPost(i + 2, 1))])
  const original = await readThread(sessions, mock.chain, 1n)
  await replySlice(mock.chain, original.replies, 1n, 20)
  const fetch = globalThis.fetch, started = deferred(), release = deferred()
  t.after(() => { release.resolve(); globalThis.fetch = fetch })
  globalThis.fetch = async (input, init) => {
    const answer = await fetch(input, init)
    if (String(input).endsWith('/replies')) {
      started.resolve()
      await release.promise
    }
    return answer
  }
  const paging = replySlice(mock.chain, original.replies, 1n, 40)
  await started.promise
  const copied = copyReplySessions(sessions)
  const next = await readThread(copied, mock.chain, 1n, undefined, true)
  assert.equal((await replySlice(mock.chain, next.replies, 1n, 20)).list.length, 20, 'the copied branch does not wait for the old queue')
  release.resolve()
  assert.equal((await paging).list.length, 30)
  assert.equal((await replySlice(mock.chain, next.replies, 1n, 20)).list.length, 20, 'a late page cannot enlarge the copy')
})

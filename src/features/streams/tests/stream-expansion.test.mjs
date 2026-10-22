// Conversations opened in place under stream cards, driven the way
// the card's count and the foot control drive them, and what the stream's
// refresh cue counts for them: new replies inside an open, complete branch
// whose list is on screen, once each, in the same poll as the stream.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { curate, load, mock, install, teardown, address, author, feedPost, feedHistory } from '../../../../scripts/host-harness.mjs'
const { loadFeed, peekFeed, feedKey } = await load('features/streams/feed.ts')
const { readRoot, replySlice } = await load('features/streams/replies.ts')
const { collapsedParents, expansionOf, resetExpansion, openRoots, RowExpansion } = await load('features/streams/stream-expansion.ts')
beforeEach(install)
after(teardown)
const stranger = address('55'), other = address('66')

/** Open a card's branch as a press on its count does, then let the mounted list read its page. */
async function openBranch(chain, rowx, root, limit = 20) {
  if (!rowx.isOpen(root)) rowx.press(root)
  rowx.shown.add(root)
  const { replies } = await readRoot(chain, root)
  return { replies, slice: await replySlice(chain, replies, root, limit) }
}

test('a new reply inside an open, complete branch cues the stream once, even when it also qualifies', async () => {
  const filter = { kind: 'timeline', viewer: author }
  const roots = [feedPost(1, 0, stranger), feedPost(2, 0, author)]
  feedHistory(roots)
  await loadFeed(mock.chain, filter)
  // Closed conversations: a stranger's reply to a stranger's post is nothing to the timeline.
  feedHistory([...roots, feedPost(3, 1, other)])
  assert.equal(await peekFeed(mock.chain, filter), 0)
  assert.deepEqual([...openRoots(feedKey(mock.chain, filter))], [])

  // Both roots opened while they had no replies: two complete, empty branches on screen.
  feedHistory(roots)
  const expansion = expansionOf(feedKey(mock.chain, filter))
  const one = new RowExpansion(expansion, 1n), two = new RowExpansion(expansion, 2n)
  await openBranch(mock.chain, one, 1n); await openBranch(mock.chain, two, 2n)
  assert.deepEqual([...openRoots(feedKey(mock.chain, filter))].sort(), [1n, 2n])
  mock.calls = []
  feedHistory([...roots, feedPost(3, 1, other)])
  assert.equal(await peekFeed(mock.chain, filter), 1, 'the stranger reply counts through the open branch')
  assert.equal(mock.calls.filter((c) => c.method === 'changes').length, 1, 'one poll covers the stream and its open branches')
  // A reply to the reader's post qualifies for the timeline and sits in an open branch: counted once.
  feedHistory([...roots, feedPost(3, 1, other), feedPost(4, 2, other)])
  assert.equal(await peekFeed(mock.chain, filter), 2)
  // Folding a branch unmounts its list and stops counting its replies.
  one.press(1n); one.shown.delete(1n)
  assert.equal(one.isOpen(1n), false)
  assert.equal(await peekFeed(mock.chain, filter), 1)
})

test('a partially loaded branch is not cued until the reader has loaded all of it', async () => {
  const filter = { kind: 'timeline', viewer: author }
  const posts = [feedPost(1, 0, stranger), ...Array.from({ length: 25 }, (_, i) => feedPost(i + 2, 1, other))]
  feedHistory(posts)
  await loadFeed(mock.chain, filter)
  const rowx = new RowExpansion(expansionOf(feedKey(mock.chain, filter)), 1n)
  const { slice: twenty } = await openBranch(mock.chain, rowx, 1n, 20)
  assert.equal(twenty.loaded, 20)
  assert.equal(twenty.more, true)
  feedHistory([...posts, feedPost(27, 1, other)])
  assert.equal(await peekFeed(mock.chain, filter), 0, 'a refresh would update the count, not append, so nothing to cue')
  const { slice: all } = await openBranch(mock.chain, rowx, 1n, 50)
  assert.equal(all.more, false)
  feedHistory([...posts, feedPost(27, 1, other), feedPost(28, 1, other)])
  assert.equal(await peekFeed(mock.chain, filter), 1, 'complete now: the next new reply is what a refresh appends')
})

test('a nested branch the reader folded stays in its session but no longer cues', async () => {
  const filter = { kind: 'timeline', viewer: author }
  const posts = [feedPost(1, 0, stranger), feedPost(2, 1, other)]
  feedHistory(posts)
  await loadFeed(mock.chain, filter)
  const rowx = new RowExpansion(expansionOf(feedKey(mock.chain, filter)), 1n)
  const { replies } = await openBranch(mock.chain, rowx, 1n)
  // The reader opens reply 2's children inside the branch: its list mounts and reads.
  rowx.shown.add(2n)
  await replySlice(mock.chain, replies, 2n, 20)
  feedHistory([...posts, feedPost(3, 2, other)])
  assert.equal(await peekFeed(mock.chain, filter), 1, 'a reply to the open nested branch is cued')
  // Folding the nested list unmounts it; the branch stays cached, but nothing on screen would show the reply.
  rowx.shown.delete(2n)
  assert.equal(await peekFeed(mock.chain, filter), 0)
  rowx.shown.add(2n)
  assert.equal(await peekFeed(mock.chain, filter), 1)
})

test('the card count and the foot control share one press: folding forgets a revealed reply, a new mount never replays it', () => {
  const expansion = expansionOf('rows/press')
  const rowx = new RowExpansion(expansion, 3n)
  // A feed may never list the reader's reply (a keyring view lists only its accounts), so the branch shows it.
  rowx.landed(9n, 42n)
  assert.equal(rowx.isOpen(9n), true, 'a reply under a folded card opens its branch')
  assert.equal(rowx.reveal(9n), 42n)
  rowx.landed(9n, 44n)
  assert.equal(rowx.isOpen(9n), true, 'another reply leaves the open branch open')
  assert.equal(rowx.reveal(9n), 44n)
  rowx.press(9n)
  rowx.press(9n)
  assert.equal(rowx.isOpen(9n), true)
  assert.equal(rowx.reveal(9n), undefined)
  rowx.landed(9n, 42n)
  rowx.press(9n) // the same call from the card's count and from the foot of the list
  assert.equal(rowx.isOpen(9n), false)
  rowx.press(9n)
  assert.equal(rowx.reveal(9n), undefined, 'reopening does not scroll to the old reply again')
  rowx.landed(9n, 43n)
  const back = new RowExpansion(expansion, 3n)
  assert.equal(back.isOpen(9n), true, 'a fresh mount finds the branch open')
  assert.equal(back.reveal(9n), undefined, 'and replays no reveal')
})

test('two rows showing one post open on their own and keep their own paging and nesting choices', () => {
  const expansion = expansionOf('rows/views')
  const a = new RowExpansion(expansion, 7n), b = new RowExpansion(expansion, 8n)
  a.press(1n)
  assert.equal(b.isOpen(1n), false, 'the other row stays folded')
  assert.deepEqual([...openRoots('rows/views')], [1n], 'the cue still knows the one post')
  a.views().set(1n, { limit: 40, open: { 5: true } })
  assert.equal(b.views().get(1n), undefined, 'paging and nesting are the row\'s own')
  b.views().set(1n, { limit: 20, open: {} })
  const preview = [feedPost(2, 1)]
  a.retain(preview); b.retain(preview)
  a.listShown(1n)
  assert.deepEqual(a.remaining(), [])
  assert.deepEqual(b.remaining(), preview, 'adoption belongs to the row, even for the same parent')
  assert.deepEqual(new RowExpansion(expansion, 7n).retained(1n), preview, 'Back preserves the list pin')
  assert.deepEqual(new RowExpansion(expansion, 8n).remaining(), preview, 'Back preserves the separate preview')
  // Back mounts new handles for the same rows and finds each row's choices.
  assert.deepEqual(new RowExpansion(expansion, 7n).views().get(1n), { limit: 40, open: { 5: true } })
  assert.deepEqual(new RowExpansion(expansion, 8n).views().get(1n), { limit: 20, open: {} })
})

test('hiding a preview survives remounts, reopening and posting restore the branch', () => {
  const expansion = expansionOf('rows/hidden-preview')
  const rowx = new RowExpansion(expansion, 1n)
  assert.equal(rowx.isHidden(1n), false, 'new rows show their preview')
  rowx.hide(1n)
  assert.equal(rowx.isHidden(1n), true)
  assert.equal(rowx.isOpen(1n), false)
  assert.equal(new RowExpansion(expansion, 1n).isHidden(1n), true, 'navigation preserves the choice')
  assert.equal(new RowExpansion(expansion, 2n).isHidden(1n), false, 'another row is independent')
  rowx.press(1n)
  assert.equal(rowx.isHidden(1n), false)
  assert.equal(rowx.isOpen(1n), true, 'the reply count reopens the full list')
  rowx.press(1n)
  assert.equal(rowx.isHidden(1n), true, 'hiding a full list does not restore its preview')
  assert.deepEqual([...openRoots('rows/hidden-preview')], [])
  rowx.landed(1n, 3n)
  assert.equal(rowx.isHidden(1n), false)
  assert.equal(rowx.isOpen(1n), true)
  assert.equal(rowx.reveal(1n), 3n)
  rowx.hide(1n)
  assert.equal(rowx.reveal(1n), undefined)
})

test('retaining a preview records only its own parents and does not open or read branches', () => {
  const posts = [feedPost(37, 36), feedPost(39, 38), feedPost(41, 40)]
  mock.calls = []
  const rowx = new RowExpansion(expansionOf('rows/deep-preview'), 1n)
  rowx.press(1n)
  rowx.retain(posts)
  rowx.retain(posts)
  assert.deepEqual(rowx.remaining(), posts)
  for (const parent of [36n, 38n, 40n]) {
    assert.equal(rowx.isOpen(parent), false)
    assert.deepEqual(rowx.retained(parent), posts.filter(p => p.parentId === parent))
  }
  assert.deepEqual(mock.calls, [])
  rowx.hide(1n, true)
  const restored = new RowExpansion(expansionOf('rows/deep-preview'), 1n)
  assert.deepEqual(restored.remaining(), [], 'collapse dismisses the kept preview across remounts')
  for (const parent of [36n, 38n, 40n]) assert.deepEqual(restored.retained(parent), [])
})

test('preview adoption and collapse stay within the clicked branch across Back', () => {
  const expansion = expansionOf('rows/preview-branches')
  const rowx = new RowExpansion(expansion, 1n)
  const posts = [feedPost(2, 1), feedPost(3, 2), feedPost(4, 1), feedPost(5, 3)]
  rowx.retain(posts)
  rowx.press(2n)
  assert.deepEqual(rowx.preview(posts).map(p => p.id), [2n, 3n, 4n, 5n], 'loading keeps the preview')
  rowx.listShown(2n)
  assert.deepEqual(rowx.preview(posts).map(p => p.id), [2n, 4n, 5n], 'only the ready direct list takes its card')
  assert.deepEqual(rowx.remaining().map(p => p.id), [2n, 4n, 5n])
  // Saving a list's paging on unmount cannot overwrite preview placement or pins.
  rowx.views().set(2n, { limit: 40, open: {} })
  const resumed = new RowExpansion(expansion, 1n)
  assert.deepEqual(resumed.remaining().map(p => p.id), [2n, 4n, 5n])
  assert.deepEqual(resumed.retained(2n).map(p => p.id), [3n])
  rowx.hide(2n)
  assert.deepEqual(rowx.preview(posts).map(p => p.id), [2n, 4n])
  assert.deepEqual(rowx.retained(1n).map(p => p.id), [2n, 4n], 'other preview branches stay retained')
  const back = new RowExpansion(expansion, 1n)
  back.press(2n)
  assert.deepEqual(back.preview(posts).map(p => p.id), [2n, 4n], 'reopening after Back cannot resurrect the dismissed preview')
})

test('a list remains registered during a preview handoff until its last copy leaves', () => {
  const rowx = new RowExpansion(expansionOf('rows/handoff'), 1n)
  const preview = rowx.watch(2n)
  const loaded = rowx.watch(2n)
  preview()
  assert.equal(rowx.shown.has(2n), true)
  assert.equal(rowx.isMounted(2n), true)
  loaded()
  assert.equal(rowx.shown.has(2n), false)
  assert.equal(rowx.isMounted(2n), false)
})


test('collapsed curated previews do not cue hidden replies, but notifications still hear them', async () => {
  curate([author])
  const filter = { kind: 'timeline', curatedOnly: true, viewer: author }
  const posts = [feedPost(1), feedPost(2, 1), feedPost(3, 2)]
  feedHistory(posts)
  const page = await loadFeed(mock.chain, filter)
  assert.equal(page.rows.length, 1)
  const rowx = new RowExpansion(expansionOf(feedKey(mock.chain, filter)), page.rows[0].key)
  rowx.hide(1n, true)
  posts.push(feedPost(4, 1), feedPost(5, 3))
  feedHistory(posts)
  let heard = 0
  mock.calls.length = 0
  assert.equal(await peekFeed(mock.chain, filter, { account: author, heard: answer => { heard += answer.records.length } }), 0)
  assert.ok(heard > 0, 'notification discovery is independent of collapsed previews')
  assert.deepEqual(mock.calls.map(c => c.method), ['changes'], 'no ancestor or message reads')
  posts.push(feedPost(6))
  feedHistory(posts)
  assert.equal(await peekFeed(mock.chain, filter), 1, 'a new top-level post still cues')
})

test('collapsing a nested preview drops its pending cue without hiding sibling activity', async () => {
  curate([author])
  const filter = { kind: 'timeline', curatedOnly: true }
  const posts = [feedPost(1), feedPost(2, 1), feedPost(3, 2)]
  feedHistory(posts)
  const page = await loadFeed(mock.chain, filter)
  const rowx = new RowExpansion(expansionOf(feedKey(mock.chain, filter)), page.rows[0].key)
  posts.push(feedPost(4, 3))
  feedHistory(posts)
  assert.equal(await peekFeed(mock.chain, filter), 1)
  rowx.hide(2n)
  assert.equal(await peekFeed(mock.chain, filter), 0, 'an already queued reply is now hidden beneath 2')
  posts.push(feedPost(5, 1))
  feedHistory(posts)
  assert.equal(await peekFeed(mock.chain, filter), 1, 'the sibling remains visible on refresh')
})


test('a collapse in one row does not silence replies visible in another row', () => {
  const key = 'cue/independent-rows', expansion = expansionOf(key)
  const row = (key) => ({ key, root: { id: 1n }, cards: [{ post: feedPost(2, 1) }] })
  const rows = [row(2n), row(3n)]
  const first = new RowExpansion(expansion, 2n), second = new RowExpansion(expansion, 3n)
  first.hide(1n, true)
  assert.deepEqual([...collapsedParents(key, rows)], [], 'the other copy still shows replies')
  second.hide(1n, true)
  assert.deepEqual([...collapsedParents(key, rows)], [1n, 2n])
  assert.equal(collapsedParents(key, rows).has(99n), false, 'unknown ancestry is never guessed')
  second.press(1n)
  assert.deepEqual([...collapsedParents(key, rows)], [], 'reopening restores eligibility')
})


test('explicit refresh resets only its stream, including nested choices and retained previews', () => {
  const key = 'rows/refresh', otherKey = 'rows/other-stream'
  const old = new RowExpansion(expansionOf(key), 1n)
  old.landed(1n, 3n)
  old.hide(2n)
  old.retain([feedPost(3, 1, stranger)])
  old.views().set(1n, { limit: 60, open: { 3: true } })
  const unmountOld = old.watch(1n)
  const other = new RowExpansion(expansionOf(otherKey), 1n)
  other.press(1n)

  resetExpansion(key)
  const fresh = new RowExpansion(expansionOf(key), 1n)
  assert.deepEqual([...openRoots(key)], [])
  assert.equal(fresh.isHidden(2n), false)
  assert.equal(fresh.reveal(1n), undefined)
  assert.equal(fresh.views().size, 0)
  assert.deepEqual(fresh.remaining(), [])
  assert.equal(fresh.isMounted(1n), false)
  assert.equal(other.isOpen(1n), true)
  const unmountFresh = fresh.watch(1n)
  unmountOld()
  assert.equal(fresh.isMounted(1n), true, 'old lists cannot unregister the refreshed stream')
  unmountFresh()
})

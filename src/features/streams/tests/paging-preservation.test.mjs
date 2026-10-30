import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, author, address, feedPost, feedHistory, curate, gateChanged } from '../../../../scripts/host-harness.mjs'

const { loadFeed, olderFeed, resumeFeed } = await load('features/streams/feed.ts')
const { muted } = await load('lib/muted.svelte.ts')
const { gates } = await load('lib/gates.svelte.ts')
const { TOMBSTONE } = await load('lib/board.ts')
beforeEach(install)
after(teardown)

for (const stream of ['following', 'curated', 'everyone']) test(`${stream} Back preserves both paged branches after their shared ancestor is loaded`, async () => {
  curate([author])
  const filter = stream === 'following'
    ? { kind: 'following', authors: [author], includeRepliesToViewer: false }
    : { kind: 'timeline', curatedOnly: stream === 'curated', viewer: author }
  // The first page shows two branches. Paging later finds their shared parent,
  // whose newest branch would put the older one outside the preview cutoff.
  feedHistory([
    feedPost(1), feedPost(2, 1), feedPost(3, 2), feedPost(11, 2),
    ...Array.from({ length: 44 }, (_, i) => i + 20).filter(id => id !== 46).map(id => feedPost(id)),
    feedPost(46, 3), feedPost(64, 11),
  ])
  const first = await loadFeed(mock.chain, filter)
  assert.deepEqual(first.rows.find(row => row.root.id === 3n).cards.map(card => card.post.id), [46n])
  const more = await olderFeed(mock.chain, filter, 60)
  assert.deepEqual(more.rows.slice(0, first.limit), first.rows.slice(0, first.limit))
  mock.calls = []
  const returned = await resumeFeed(mock.chain, filter)
  assert.deepEqual(returned.rows, more.rows, 'Back retains displayed branches even when a fresh preview would omit them')
  assert.equal(mock.calls.length, 0, 'Back reuses the paged snapshot')
})

test('Everyone Back removes newly muted rows and leaves while retaining needed reply context', async () => {
  const loud = address('88'), filter = { kind: 'timeline', viewer: author }
  feedHistory([
    feedPost(1), feedPost(2, 1, loud), feedPost(3, 2), feedPost(4, 1, loud), feedPost(5, 0, loud),
    ...Array.from({ length: 25 }, (_, i) => feedPost(i + 10)),
  ])
  const first = await loadFeed(mock.chain, filter)
  const more = await olderFeed(mock.chain, filter, 40)
  assert.ok(more.rows.length > first.limit, 'the older page extends the displayed snapshot')
  assert.ok(more.rows.some(row => row.root.id === 5n), 'the standalone muted post was displayed')
  assert.deepEqual(more.rows.find(row => row.root.id === 1n).cards.map(card => card.post.id), [2n, 3n, 4n])

  muted.toggle(loud)
  try {
    mock.calls = []
    const returned = await resumeFeed(mock.chain, filter)
    assert.deepEqual(returned.rows.map(row => row.key), more.rows.filter(row => row.root.id !== 5n).map(row => row.key),
      'Back removes the standalone muted post and keeps the remaining row order')
    const conversation = returned.rows.find(row => row.root.id === 1n)
    assert.deepEqual(conversation.cards.map(card => card.post.id), [2n, 3n],
      'the muted leaf leaves, but the muted parent stays as context for the unmuted reply')
    assert.equal(conversation.cards[0].drawn, 1)
    assert.equal(mock.calls.length, 0, 'Back applies the mute to the paged snapshot without host reads')
  } finally { muted.toggle(loud) }
})

for (const source of ['local receipt', 'accepted index changes']) test(`Everyone Back applies deletions from ${source} to paged rows and their context`, async () => {
  const filter = { kind: 'timeline', viewer: author }
  feedHistory([
    feedPost(1), feedPost(2, 1), feedPost(3, 2), feedPost(4, 1), feedPost(5),
    ...Array.from({ length: 25 }, (_, i) => feedPost(i + 10)),
  ])
  const first = await loadFeed(mock.chain, filter)
  const more = await olderFeed(mock.chain, filter, 40)
  assert.ok(more.rows.length > first.limit, 'the older page extends the displayed snapshot')
  assert.ok(more.rows.some(row => row.root.id === 5n), 'the standalone deleted post was displayed')
  assert.deepEqual(more.rows.find(row => row.root.id === 1n).cards.map(card => card.post.id), [2n, 3n, 4n])

  const remove = async (ids, block) => {
    for (const id of ids) {
      if (source === 'local receipt') gates.settleMessage(mock.chain, id, TOMBSTONE, { block, index: Number(id) })
      else gateChanged(id, TOMBSTONE, block)
    }
    if (source === 'accepted index changes') await gates.advanceToHead(mock.chain)
    for (const id of ids) assert.equal(gates.message(mock.chain, id), TOMBSTONE, 'the shared ledger knows the deletion before Back')
  }
  await remove([1n, 2n, 4n, 5n], 35n)
  mock.calls = []
  const returned = await resumeFeed(mock.chain, filter)
  assert.deepEqual(returned.rows.map(row => row.key), more.rows.filter(row => row.root.id !== 5n).map(row => row.key),
    'Back removes the deleted standalone row and keeps the remaining row order')
  const conversation = returned.rows.find(row => row.root.id === 1n)
  assert.equal(conversation.root.omitted, false, 'the deleted root still connects the surviving reply to its displayed context')
  assert.deepEqual(conversation.cards.map(card => card.post.id), [2n, 3n],
    'the deleted leaf leaves, but the deleted parent stays above its surviving reply')
  assert.equal(conversation.root.drawn, 0, 'deleted context does not count as a live reply')
  assert.equal(conversation.cards[0].drawn, 1)
  assert.equal(mock.calls.length, 0, 'Back uses the known deletion without refreshing the feed')

  await remove([3n], 36n)
  mock.calls = []
  const ended = await resumeFeed(mock.chain, filter)
  assert.deepEqual(ended.rows.map(row => row.key), more.rows.filter(row => row.root.id !== 5n && row.root.id !== 1n).map(row => row.key),
    'deleting the final survivor removes the whole ended context path')
  assert.equal(mock.calls.length, 0)
})

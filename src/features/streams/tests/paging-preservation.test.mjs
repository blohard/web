import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, author, feedPost, feedHistory, curate } from '../../../../scripts/host-harness.mjs'

const { loadFeed, olderFeed, resumeFeed } = await load('features/streams/feed.ts')
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

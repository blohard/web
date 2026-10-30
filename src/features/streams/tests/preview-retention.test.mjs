import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, feedPost, feedHistory, author } from '../../../../scripts/host-harness.mjs'

const { loadFeed, olderFeed, resumeFeed } = await load('features/streams/feed.ts')
beforeEach(install)
after(teardown)

const drawn = page => page.rows.slice(0, page.limit).flatMap(row => [row.root.id, ...row.cards.map(card => card.post.id)])

test('local reload retains only the displayed parts of a split conversation preview', async () => {
  // Three distant branches share a selection group but draw as separate rows.
  const history = [feedPost(1), feedPost(2, 1), feedPost(3, 2), feedPost(4, 1),
    feedPost(5, 4), feedPost(6, 1), feedPost(7, 6), feedPost(10, 3), feedPost(11, 5), feedPost(12, 7),
    ...Array.from({ length: 19 }, (_, i) => feedPost(100 + i))]
  const filter = { kind: 'following', includeRepliesToViewer: false, authors: [author] }
  feedHistory(history)
  await loadFeed(mock.chain, filter)
  await olderFeed(mock.chain, filter, 40)
  // Back to an earlier stream visit restores its shorter displayed prefix.
  const first = await resumeFeed(mock.chain, filter, 20)
  assert.ok(drawn(first).includes(12n))
  assert.ok(!drawn(first).includes(10n))
  assert.ok(!drawn(first).includes(11n))

  // A reply to the visible branch displaces 10 from the newest-three preview.
  feedHistory([...history, feedPost(120, 12)])
  await loadFeed(mock.chain, filter, { preservePreviews: true })
  const more = await olderFeed(mock.chain, filter, 40)
  assert.ok(drawn(more).includes(12n), 'the previously displayed preview stays')
  assert.ok(drawn(more).includes(120n), 'the new reply is shown')
  assert.ok(!drawn(more).includes(10n), 'an unseen preview is not preserved beyond the newest three')
})

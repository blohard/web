import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown, feedPost } from '../../../../scripts/harness.mjs'

const { conversationCards } = await load('features/streams/conversation.ts')
const { layoutPreview, replyControls } = await load('features/streams/conversation-layout.ts')
after(teardown)

const parent = { id: 1n, separator: false, loading: false, missing: false }
function fixture(posts) {
  return {
    items: conversationCards(parent.id, posts),
    states: new Map(posts.map(post => [post.id, {
      totalReplies: 0, open: false, hidden: false, ended: false, editorOpen: false,
    }])),
  }
}

test('reply controls distinguish previews, opened lists, collapsed lists and unknown counts', () => {
  for (const [total, drawn, expanded, hidden, expectedCount, moreReplies] of [
    [5, 2, false, false, 3, true],
    [5, 2, true, false, 5, false],
    [5, 2, false, true, 5, false],
    [1, 3, false, false, 0, true],
    [0, 0, false, false, 0, false],
    [null, 2, false, false, null, true],
    [null, 2, true, false, null, false],
    [null, 2, false, true, null, false],
  ]) assert.deepEqual(replyControls(total, drawn, expanded, hidden), { replyCount: expectedCount, moreReplies })
})

test('an unchanged preview keeps its prepared count and connection facts without mutating inputs', () => {
  const posts = [feedPost(2, 1), feedPost(3, 2)]
  const { items, states } = fixture(posts)
  items[0].drawn = 2
  items[0].joins = false
  states.get(2n).totalReplies = 5
  const before = structuredClone({ items, states })
  const display = layoutPreview(items, posts, states, parent)
  assert.equal(display.cards[0].replyCount, 5, 'a preview that does not start beneath the card does not discount its count')
  assert.equal(display.cards[0].moreReplies, false)
  assert.equal(display.cards[0].connector, false)
  assert.equal(display.cards[1].separator, true)
  assert.deepEqual(display.posts, posts)
  assert.deepEqual({ items, states }, before)
})

test('a changed preview recounts visible replies and labels the gap left by a missing parent', () => {
  const posts = [feedPost(2, 1), feedPost(3, 2), feedPost(4, 2), feedPost(5, 3)]
  const { items, states } = fixture(posts)
  states.get(2n).totalReplies = 2
  const kept = [posts[0], posts[2], posts[3]]
  const display = layoutPreview(items, kept, states, parent)
  assert.deepEqual(display.posts.map(p => p.id), [2n, 4n, 5n])
  assert.equal(display.cards[0].replyCount, 1, 'only #4 is drawn directly under #2')
  assert.deepEqual(display.cards.map(c => c.connector), [true, false, false])
  assert.deepEqual(display.cards.map(c => c.context), [null, null, { id: 3n, separator: true }])
  assert.equal(display.cards[2].separator, false, 'the context label owns the border')
})

test('ended context does not subtract from live counts or reopen its saved branch', () => {
  const posts = [feedPost(2, 1), feedPost(3, 2), feedPost(4, 2), feedPost(5, 3)]
  const { items, states } = fixture(posts)
  states.get(2n).totalReplies = 1
  Object.assign(states.get(3n), { ended: true, open: true })
  const display = layoutPreview(items, [posts[0], posts[1], posts[3]], states, parent)
  assert.equal(display.cards[0].replyCount, 1, 'ended #3 is context, not a live reply')
  assert.equal(display.cards[1].expanded, false)
  assert.equal(display.cards[2].separator, true, 'a saved open choice still interrupts the preview join')
})

test('separators distinguish joined children, siblings, opened lists and visible editors', () => {
  const posts = [feedPost(2, 1), feedPost(3, 2), feedPost(4, 2)]
  const { items, states } = fixture(posts)
  states.get(2n).totalReplies = 3
  const display = () => layoutPreview(items, posts, states, parent).cards
  assert.deepEqual(display().map(c => c.separator), [false, false, true])
  assert.deepEqual(display().map(c => c.connector), [true, false, false])
  states.get(2n).editorOpen = true
  assert.deepEqual(display().map(c => c.separator), [false, true, true])
  assert.equal(display()[0].branchSeparator, true)
  Object.assign(states.get(2n), { editorOpen: false, open: true })
  assert.deepEqual(display().map(c => c.separator), [false, true, true])
  assert.equal(display()[0].replyCount, 3)
  assert.equal(display()[0].moreReplies, false)
  Object.assign(states.get(2n), { open: false, hidden: true })
  const collapsed = layoutPreview(items, [posts[0]], states, parent).cards[0]
  assert.equal(collapsed.connector, false)
  assert.equal(collapsed.replyCount, 3)
  assert.equal(collapsed.moreReplies, false)
})

test('a loading parent owns the first border; a failed parent gets a context link', () => {
  const posts = [feedPost(2, 1), feedPost(3, 1)]
  const { items, states } = fixture(posts)
  const draw = overrides => layoutPreview(items, posts, states, { ...parent, separator: true, ...overrides }).cards
  assert.deepEqual(draw({ loading: true }).map(c => c.separator), [false, true])
  assert.equal(draw({ loading: true })[0].context, null)
  assert.deepEqual(draw({ missing: true })[0].context, { id: 1n, separator: true })
  assert.equal(draw({ missing: true })[0].separator, false)
  items[0].gap = true
  assert.deepEqual(draw({ loading: true })[0].context, { id: 1n, separator: false })
  assert.equal(draw({})[0].context.separator, true)
})

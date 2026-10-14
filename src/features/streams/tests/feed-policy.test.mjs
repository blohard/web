// Product rules, without paging, caches or asynchronous reads.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown, author as viewer, address, feedPost, hash } from '../../../../scripts/harness.mjs'
const { selectPost, feedQuery, appliesMutes, curatedSubjects } = await load('features/streams/feed-policy.ts')
after(teardown)
const followed = address('33'), stranger = address('44')
const following = { kind: 'following', authors: [viewer, followed], viewer, includeRepliesToViewer: true }
const keyring = { kind: 'following', authors: [followed], viewer, includeRepliesToViewer: false }

for (const [name, filter, expected] of [
  ['everyone', { kind: 'timeline', viewer }, ['selected', 'selected', 'selected', 'selected', 'excluded']],
  ['anonymous everyone', { kind: 'timeline' }, ['selected', 'selected', 'excluded', 'excluded', 'excluded']],
  ['following', following, ['selected', 'excluded', 'selected', 'selected', 'selected']],
  ['keyring', keyring, ['selected', 'excluded', 'excluded', 'excluded', 'selected']],
]) test(`${name} separates selected authors, own replies and replies to the viewer`, () => {
  const posts = [feedPost(1, 0, followed), feedPost(2, 0, stranger),
    feedPost(3, 2, viewer, stranger), feedPost(4, 9, stranger, viewer), feedPost(5, 2, followed, stranger)]
  assert.deepEqual(posts.map(post => selectPost(filter, post)), expected)
})

test('viewer identity alone does not select their posts or replies in a keyring', () => {
  for (const post of [feedPost(1, 0, viewer), feedPost(2, 1, viewer, viewer)]) assert.equal(selectPost(keyring, post), 'excluded')
  assert.deepEqual(feedQuery(keyring, {}), { any: [{ authors: [followed] }] })
  assert.deepEqual(feedQuery(following, {}), { any: [{ authors: [viewer, followed] }, { parent_authors: [viewer] }] })
  assert.deepEqual(feedQuery({ ...keyring, authors: [] }, {}), { any: [] })
  assert.deepEqual(feedQuery({ ...following, viewer: undefined }, {}), { any: [{ authors: following.authors }] })
})

for (const kind of ['author', 'author-replies']) test(`the profile ${kind} tab waits only for a viewer answer's selected parent`, () => {
  const filter = { kind, address: followed, viewer }
  const parent = feedPost(1, 0, followed), replyParent = feedPost(1, 9, followed, stranger)
  const answer = feedPost(2, 1, viewer, followed)
  assert.equal(selectPost(filter, parent), kind === 'author' ? 'selected' : 'excluded')
  assert.equal(selectPost(filter, replyParent), kind === 'author-replies' ? 'selected' : 'excluded')
  assert.equal(selectPost(filter, answer), 'waiting-for-parent')
  const selectedParent = kind === 'author' ? parent : replyParent
  assert.equal(selectPost(filter, answer, selectedParent), 'selected')
  assert.equal(selectPost(filter, feedPost(3, 1, stranger, followed), selectedParent), 'excluded')
  assert.equal(selectPost(filter, feedPost(4, 1, viewer, stranger)), 'excluded')
  assert.equal(selectPost({ ...filter, viewer: undefined }, answer), 'excluded')
  assert.deepEqual(feedQuery(filter, {}), { any: [
    { authors: [followed], kind: kind === 'author' ? 'posts' : 'replies' },
    { authors: [viewer], parent_authors: [followed] },
  ] })
})

test('the profile posts tab excludes an answer once its parent is known to be a reply', () => {
  const filter = { kind: 'author', address: followed, viewer }
  const parent = feedPost(1, 9, followed, stranger), answer = feedPost(2, 1, viewer, followed)
  assert.equal(selectPost(filter, answer), 'waiting-for-parent')
  assert.equal(selectPost(filter, answer, parent), 'excluded')
})

test('own replies do not select their stranger parent or its other replies', () => {
  const parent = feedPost(1, 0, stranger), own = feedPost(2, 1, viewer, stranger)
  const sibling = feedPost(3, 1, stranger, stranger)
  assert.equal(selectPost(following, own), 'selected')
  assert.equal(selectPost(following, parent), 'excluded')
  assert.equal(selectPost(following, sibling, parent), 'excluded')
  const selfHeld = { ...keyring, authors: [viewer, followed] }
  assert.equal(selectPost(selfHeld, own), 'selected')
  assert.equal(selectPost(selfHeld, sibling, parent), 'excluded')
})

test('curated queries require membership for own posts and replies to the viewer', () => {
  const filter = { kind: 'timeline', curatedOnly: true, viewer }
  assert.deepEqual(feedQuery(filter, { curated: true }), { any: [
    { curated: true },
    { authors: [viewer], kind: 'replies', parent_curated: true },
    { parent_authors: [viewer], parent_curated: true },
  ] })
  assert.deepEqual(feedQuery({ ...filter, viewer: undefined }, { curated: true }), { any: [{ curated: true }] })
  assert.deepEqual(curatedSubjects(filter, feedPost(1, 0, viewer)), [viewer], 'own top-level posts still require membership')
  assert.deepEqual(curatedSubjects(filter, feedPost(2, 1, viewer, followed)), [viewer, followed], 'either author can qualify an own reply')
  assert.deepEqual(curatedSubjects(filter, feedPost(3, 1, stranger, viewer)), [stranger, viewer], 'a reply to the viewer qualifies if the viewer is curated')
  assert.deepEqual(curatedSubjects(filter, feedPost(4, 1, stranger, followed)), [stranger], 'other readers do not get that exception')
  for (const viewer of [undefined, followed, stranger]) {
    assert.equal(selectPost({ ...filter, viewer }, feedPost(4, 1, followed, stranger)), 'selected', 'curated replies pass client selection for any reader')
  }
  assert.deepEqual(feedQuery(filter, {}), feedQuery({ kind: 'timeline', viewer }, {}), 'without a list it is everyone')
})

test('everyone requests top-level posts plus own replies and replies to the viewer', () => {
  assert.deepEqual(feedQuery({ kind: 'timeline', viewer }, {}), { any: [
    { kind: 'posts' }, { authors: [viewer], kind: 'replies' }, { parent_authors: [viewer] },
  ] })
  assert.deepEqual(feedQuery({ kind: 'timeline' }, {}), { any: [{ kind: 'posts' }] })
})

test('mutes apply to streams but not a profile the reader opened deliberately', () => {
  for (const filter of [following, keyring, { kind: 'timeline' }, { kind: 'timeline', curatedOnly: true }]) assert.equal(appliesMutes(filter), true)
  for (const kind of ['author', 'author-replies']) assert.equal(appliesMutes({ kind, address: followed }), false)
})

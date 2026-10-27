// Curated selection is the same for first loads, refresh cues and local posts.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { curate, load, mock, install, teardown, address, author, feedPost, feedHistory } from '../../../../scripts/host-harness.mjs'
const feed = await load('features/streams/feed.ts')
const listed = address('73'), stranger = address('74')
const filter = { kind: 'timeline', curatedOnly: true, viewer: author }
const drawn = page => [...new Set(page.rows.flatMap(r => [r.root.id, ...r.cards.map(c => c.post.id)]))].map(Number).sort((a,b) => a-b)
function history() {
  return [feedPost(1, 0, listed), feedPost(2), feedPost(3, 0, stranger),
    feedPost(4, 1, author, listed), feedPost(5, 3, author, stranger), feedPost(6, 2, stranger, author),
    feedPost(7, 3, listed, stranger), feedPost(8, 3, stranger, stranger)]
}
beforeEach(() => {
  install()
  mock.blocked = false
  curate([])
  curate([listed])
})
after(teardown)

test('Curated includes listed replies and own replies to listed authors on load and refresh', async () => {
  feedHistory(history().slice(0, 3))
  assert.deepEqual(drawn(await feed.loadFeed(mock.chain, filter)), [1])
  feedHistory(history())
  assert.deepEqual(drawn(await feed.loadFeed(mock.chain, filter)), [1, 3, 4, 7], 'the unlisted parent is context, without its other replies')
})

test('Curated cues listed replies and own replies to listed authors, without unrelated notifications', async () => {
  feedHistory(history().slice(0, 1))
  await feed.loadFeed(mock.chain, filter)
  feedHistory(history())
  for (const id of [2n, 5n, 6n, 8n]) mock.associations.set(id, { account: author, reference: { kind: 'mention', account: author } })
  assert.equal(await feed.peekFeed(mock.chain, filter, { account: author, heard() {} }), 2)
  assert.deepEqual(drawn(await feed.resumeFeed(mock.chain, filter)), [1], 'the quiet poll does not move the stream')
  assert.deepEqual(drawn(await feed.loadFeed(mock.chain, filter)), [1, 3, 4, 7])
  assert.equal(await feed.peekFeed(mock.chain, filter), 0)
})

test('Curated local confirmations use the same rule as the host feed', async () => {
  feedHistory(history().slice(0, 1))
  await feed.loadFeed(mock.chain, filter)
  feedHistory(history())
  for (const [id, parent] of [[2n, 0n], [5n, 3n], [4n, 1n]]) await feed.acceptPublication(mock.chain, id, parent)
  assert.deepEqual(drawn(await feed.resumeFeed(mock.chain, filter)), [1, 4])
  assert.equal(await feed.peekFeed(mock.chain, filter), 1, 'the listed account’s remote reply stays behind the cue')
})

test('anonymous Curated includes listed replies without an own-reply exception', async () => {
  feedHistory(history())
  assert.deepEqual(drawn(await feed.loadFeed(mock.chain, { kind: 'timeline', curatedOnly: true })), [1, 3, 7])
})

test('a curated reader’s local reply to an unlisted author appears once', async () => {
  const own = { ...filter, viewer: listed }
  feedHistory(history().slice(0, 3))
  await feed.loadFeed(mock.chain, own)
  feedHistory(history())
  await feed.acceptPublication(mock.chain, 7n, 3n)
  const resumed = await feed.resumeFeed(mock.chain, own)
  assert.deepEqual(drawn(resumed), [1, 3, 7])
  assert.equal(await feed.peekFeed(mock.chain, own), 1, 'an incoming reply to this curated reader stays behind the cue')
  const refreshed = await feed.loadFeed(mock.chain, own)
  assert.deepEqual(drawn(refreshed), [1, 3, 4, 7])
  assert.equal(refreshed.rows.flatMap(r => r.cards).filter(c => c.post.id === 7n).length, 1, 'refresh does not duplicate the merged reply')
})

test('curation edits add and remove existing replies only on refresh', async () => {
  const anonymous = { kind: 'timeline', curatedOnly: true }
  curate([])
  feedHistory(history())
  assert.deepEqual(drawn(await feed.loadFeed(mock.chain, anonymous)), [])
  curate([listed])
  assert.ok(await feed.peekFeed(mock.chain, anonymous) > 0)
  assert.deepEqual(drawn(await feed.resumeFeed(mock.chain, anonymous)), [])
  assert.deepEqual(drawn(await feed.loadFeed(mock.chain, anonymous)), [1, 3, 7])
  curate([])
  assert.ok(await feed.peekFeed(mock.chain, anonymous) > 0)
  assert.deepEqual(drawn(await feed.resumeFeed(mock.chain, anonymous)), [1, 3, 7])
  assert.deepEqual(drawn(await feed.loadFeed(mock.chain, anonymous)), [])
})

for (const reader of ['curated', 'other curated', 'unlisted', 'anonymous']) test(`Curated selects unlisted replies only to the ${reader} reader when listed`, async () => {
  const other = address('75')
  curate([listed, other])
  const viewer = { curated: listed, 'other curated': other, unlisted: author, anonymous: undefined }[reader]
  const personal = { ...filter, viewer }
  const posts = [feedPost(1, 0, listed), feedPost(2, 0, other), feedPost(3)]
  const visible = reader === 'curated' ? [1, 2, 4] : reader === 'other curated' ? [1, 2, 5] : [1, 2]
  feedHistory(posts)
  await feed.loadFeed(mock.chain, personal)
  feedHistory([...posts, feedPost(4, 1, stranger, listed), feedPost(5, 2, stranger, other),
    feedPost(6, 3, stranger, author), feedPost(7, 4, stranger, stranger)])
  assert.equal(await feed.peekFeed(mock.chain, personal), visible.length - 2, 'only direct replies to this curated reader cue refresh')
  assert.deepEqual(drawn(await feed.resumeFeed(mock.chain, personal)), [1, 2], 'new replies wait for a refresh')
  assert.deepEqual(drawn(await feed.loadFeed(mock.chain, personal)), visible)
  assert.equal(await feed.peekFeed(mock.chain, personal), 0)
})

for (const stream of ['Curated', 'Following', 'Keyring']) test(`${stream} does not promote an old post through unselected ancestors`, async () => {
  const selected = stream === 'Curated' ? filter : {
    kind: 'following', authors: [listed], viewer: author, includeRepliesToViewer: stream === 'Following',
  }
  const posts = [feedPost(1, 0, listed), feedPost(2, 1, stranger, listed),
    feedPost(3, 2, stranger, stranger), feedPost(4, 0, listed)]
  feedHistory(posts)
  assert.deepEqual((await feed.loadFeed(mock.chain, selected)).rows.map(r => r.root.id), [4n, 1n])
  feedHistory([...posts, feedPost(5, 3, listed, stranger), feedPost(6, 5, listed, listed)])
  const page = await feed.loadFeed(mock.chain, selected)
  assert.deepEqual(page.rows.map(r => r.root.id), [3n, 4n, 1n], 'the active branch moves up; the disconnected old post stays below the newer post')
  assert.deepEqual(page.rows.map(r => r.activity.id), [6n, 4n, 1n], 'ranking uses the branch actually displayed')
  assert.deepEqual(page.rows[0].cards.map(c => c.post.id), [5n, 6n])
  assert.equal(page.rows[0].root.omitted, false, 'the immediate parent explains the active branch')
  assert.deepEqual(page.rows[2].cards, [])
})

test('Everyone ranks a disconnected branch separately from the reader’s old post', async () => {
  const everyone = { kind: 'timeline', viewer: author }
  feedHistory([feedPost(1), feedPost(2, 1, stranger, author),
    feedPost(3, 2, stranger, stranger), feedPost(4),
    feedPost(5, 3, author, stranger), feedPost(6, 5, stranger, author)])
  const page = await feed.loadFeed(mock.chain, everyone)
  assert.deepEqual(page.rows.map(r => r.root.id), [3n, 4n, 1n])
  assert.deepEqual(page.rows.map(r => r.activity.id), [6n, 4n, 2n])
  assert.deepEqual(page.rows[0].cards.map(c => c.post.id), [5n, 6n])
  assert.deepEqual(page.rows[2].cards.map(c => c.post.id), [2n], 'a directly connected reply still belongs to its parent')
})

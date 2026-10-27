import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, author, address, feedPost, feedHistory, counted, ids, curate, gateChanged } from '../../../../scripts/host-harness.mjs'

const { loadFeed, olderFeed, resumeFeed, peekFeed, feedKey, FEED_PAGE_SIZE } = await load('features/streams/feed.ts')
const { prepareRow, drawnReplies, gapsIn, rowKey, withInlined } = await load('features/streams/conversation.ts')
const { RowExpansion, expansionOf } = await load('features/streams/stream-expansion.ts')
beforeEach(install)
after(teardown)

const visible = (page) => page.rows.map((r) => r.lead).slice(0, page.limit)
test('twenty rows arrive with their counts; more extends the prefix and refresh preserves it', async () => {
  feedHistory(Array.from({ length: 100 }, (_, i) => feedPost(i + 1)))
  const filter = { kind: 'following', includeRepliesToViewer: false, authors: [author] }
  const page = await counted(loadFeed(mock.chain, filter))
  assert.equal(page.rows.length, 20)
  assert.equal(page.complete, false)
  assert.equal(page.counts.size, 20)
  assert.deepEqual(mock.calls.map((c) => c.method), ['feed'], 'one page supplies records, gates and counts')
  mock.calls = []
  const more = await counted(olderFeed(mock.chain, filter, 40))
  assert.equal(visible(more).length, 40)
  assert.equal(more.counts.size, 40)
  assert.deepEqual(mock.calls.map((c) => c.method), ['feed'])
  assert.equal(mock.calls[0].cursor.before, '81')
  feedHistory(Array.from({ length: 105 }, (_, i) => feedPost(i + 1)))
  const refreshed = await counted(loadFeed(mock.chain, filter, { limit: 40 }))
  assert.equal(visible(refreshed).length, 45)
  assert.equal(visible(refreshed)[0].id, 105n)
  assert.equal(visible(refreshed).at(-1).id, 61n)
  assert.equal(refreshed.counts.size, 45)
  const reset = await counted(loadFeed(mock.chain, filter, { limit: FEED_PAGE_SIZE, preserveVisibleRows: false }))
  assert.equal(visible(reset).length, 20, 'a new stream visit starts at twenty')
})

test('a refresh makes room for a conversation a new reply moves to the top, and needs none for a new lead inside a displayed one', async () => {
  feedHistory(Array.from({ length: 30 }, (_, i) => feedPost(i + 1)))
  const filter = { kind: 'following', includeRepliesToViewer: false, authors: [author] }
  const page = await counted(loadFeed(mock.chain, filter, { limit: FEED_PAGE_SIZE, preserveVisibleRows: false }))
  assert.deepEqual(ids(visible(page)).at(-1), 11)
  // The reader answers post 5, hidden behind the limit: its conversation rises to the top and every displayed row stays.
  feedHistory([...Array.from({ length: 30 }, (_, i) => feedPost(i + 1)), feedPost(31, 5)])
  const risen = await counted(loadFeed(mock.chain, filter))
  assert.equal(visible(risen).length, 21)
  assert.deepEqual(visible(risen).map((m) => Number(rowKey(filter, m))).slice(0, 2), [5, 30])
  assert.equal(ids(visible(risen)).at(-1), 11, 'the last row displayed before is still displayed')
  // The reader answers post 30, already displayed: the conversation keeps its row, so nothing needs room.
  feedHistory([...Array.from({ length: 30 }, (_, i) => feedPost(i + 1)), feedPost(31, 5), feedPost(32, 30)])
  const same = await counted(loadFeed(mock.chain, filter))
  assert.equal(visible(same).length, 21)
  assert.deepEqual(visible(same).map((m) => Number(rowKey(filter, m))).slice(0, 3), [30, 5, 29])
  assert.equal(ids(visible(same))[0], 32, 'the new reply leads the row its post had')
})

test('show more consumes rows already held before asking for the next host page', async () => {
  const { muted } = await load('lib/muted.svelte.ts')
  const loud = address('88')
  // One filtered candidate forces a second page; the excess rows remain held.
  feedHistory(Array.from({ length: 60 }, (_, i) => feedPost(i + 1, 0, i === 59 ? loud : author)))
  muted.toggle(loud)
  try {
    const filter = { kind: 'timeline' }
    const page = await loadFeed(mock.chain, filter)
    assert.equal(page.rows.length, 39)
    mock.calls = []
    const more = await olderFeed(mock.chain, filter, 30)
    assert.equal(visible(more).length, 30)
    assert.equal(mock.calls.length, 0)
    assert.equal(visible(await olderFeed(mock.chain, filter, 40)).length, 40)
    assert.equal(mock.calls.filter((c) => c.method === 'feed').length, 1)
  } finally { muted.toggle(loud) }
})

for (const retryWithRefresh of [false, true]) test(`a failed older page resumes from its last completed cursor via ${retryWithRefresh ? 'refresh' : 'show more'}`, async () => {
  feedHistory(Array.from({ length: 100 }, (_, i) => feedPost(i + 1)))
  const filter = { kind: 'timeline' }
  await loadFeed(mock.chain, filter)
  mock.failRead = (url, ask) => url.endsWith('/feed') && ask.cursor?.before === '31'
  // The first fifty older rows land; the next page fails.
  await assert.rejects(olderFeed(mock.chain, filter, 90), /index unavailable/)
  mock.failRead = null; mock.calls = []
  const retried = await (retryWithRefresh ? loadFeed(mock.chain, filter) : olderFeed(mock.chain, filter, 90))
  assert.equal(visible(retried).length, 90)
  assert.equal(new Set(retried.rows.map((r) => r.key)).size, retried.rows.length)
  assert.equal(mock.calls.find((c) => c.method === 'feed').cursor.before, '31', 'the successful older page is not fetched again')
})

test('a long conversation previews only its newest replies and counts only the cards displayed', async () => {
  const root = feedPost(1, 0, address('88'))
  const replies = Array.from({ length: 99 }, (_, i) => feedPost(i + 2, i + 1))
  feedHistory([root, ...replies])
  const page = await counted(loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: false, authors: [author] }))
  const row = page.rows[0]
  assert.deepEqual(ids(row.cards.map((c) => c.post)), [97, 98, 99, 100], 'the newest three and their immediate followed parent, without recursively filling the gap')
  assert.equal(row.root.joins, false, 'no line bridges the omitted replies')
  assert.equal(row.cards[0].post.parentAuthor, author, 'the omitted parent remains known for attribution and moderation')
  assert.deepEqual(row.cards.filter((c) => c.gap).map((c) => c.post.id), [97n], 'only the card after the cut links to what it answers')
  assert.deepEqual([...page.counts.keys()].sort((a, b) => Number(a - b)), [1n, 97n, 98n, 99n, 100n])
  assert.deepEqual([row.root.drawn, ...row.cards.map((c) => c.drawn)], [0, 1, 1, 1, 0])
})

test('the preview is the newest three replies across branches, oldest first, even when depth-first order ends on an older sibling', () => {
  const root = feedPost(1)
  const replies = [feedPost(2, 1), feedPost(3, 2), feedPost(4, 2), feedPost(5, 3), feedPost(6, 5)]
  const grouped = withInlined([root], replies)
  const row = prepareRow({ kind: 'timeline' }, grouped.posts[0], { ...grouped, parents: new Map(), ended: new Set() })
  const cards = row.cards.map(c => c.post)
  assert.deepEqual(ids(cards), [4, 5, 6])
  assert.deepEqual([...gapsIn(1n, cards)], [4n, 5n], '4 answers 2 and 5 answers 3; 6 answers the card above it')
})

test('no slot is kept for the reply answering the post when the newest cards are on other branches', () => {
  const root = feedPost(1)
  // Two branches beneath the post: 1 → 2 → 4 → 6 and 1 → 3 → 5 → 7.
  const replies = [feedPost(2, 1), feedPost(3, 1), feedPost(4, 2), feedPost(5, 3), feedPost(6, 4), feedPost(7, 5)]
  const grouped = withInlined([root], replies)
  const row = prepareRow({ kind: 'timeline' }, grouped.posts[0], { ...grouped, parents: new Map(), ended: new Set() })
  const cards = row.cards.map(c => c.post)
  assert.deepEqual(ids(cards), [5, 6, 7])
  assert.deepEqual([...gapsIn(1n, cards)], [5n, 6n, 7n], 'returning to another branch names its parent even when that parent is drawn')
  assert.deepEqual([...drawnReplies(cards)], [[3n, 1], [4n, 1], [5n, 1]])
})

test('siblings need no label when their parent is drawn higher up', () => {
  const root = feedPost(1)
  // 2 answers the post; 3 and then 4 both answer 2.
  const replies = [feedPost(2, 1), feedPost(3, 2), feedPost(4, 2)].map(post => ({ ...post, parentAuthor: author }))
  const grouped = withInlined([root], replies)
  const row = prepareRow({ kind: 'timeline' }, grouped.posts[0], { ...grouped, parents: new Map(), ended: new Set() })
  const cards = row.cards.map(c => c.post)
  assert.deepEqual(ids(cards), [2, 3, 4], 'three replies are shown whole')
  assert.deepEqual([...gapsIn(1n, cards)], [], 'both siblings answer the visible 2')
  assert.deepEqual([...drawnReplies(cards)], [[1n, 1], [2n, 2]], '2 has two drawn replies; the siblings have none')
})

test('the newest reply beneath an older direct reply is previewed and places the conversation', () => {
  // Five direct replies to post 1, then the newest activity answers the oldest of them.
  const replies = [...[10, 11, 12, 13, 14].map((i) => feedPost(i, 1)), feedPost(30, 10)]
  const grouped = withInlined([feedPost(1), feedPost(20)], replies)
  assert.deepEqual(ids(grouped.posts), [14, 20], 'the conversation ranks by its newest reply, above post 20')
  const row = prepareRow({ kind: 'timeline' }, grouped.posts[0], { ...grouped, parents: new Map(), ended: new Set() })
  const cards = row.cards.map(c => c.post)
  assert.deepEqual(ids(cards), [13, 14, 30])
  assert.deepEqual([...gapsIn(1n, cards)], [30n], 'only 30 answers a parent left out of the preview')
})

test('prepared rows carry actual connectors, gaps, attribution and drawn counts', async () => {
  const { prepareRow } = await load('features/streams/conversation.ts')
  const root = feedPost(1)
  const replies = [feedPost(2, 1), feedPost(3, 2), feedPost(4, 2)].map(post => ({ ...post, parentAuthor: author }))
  const grouped = withInlined([root], replies)
  const row = prepareRow({ kind: 'following', includeRepliesToViewer: false, authors: [author] }, grouped.posts[0], { ...grouped, parents: new Map([[1n, root]]), ended: new Set() })
  assert.equal(row.kind, 'pair')
  assert.equal(row.key, 1n)
  assert.equal(row.root.post, root)
  assert.equal(row.root.drawn, 1)
  assert.equal(row.root.joins, true)
  assert.deepEqual(row.cards.map((c) => [c.post.id, c.drawn, c.joins, c.gap, c.post.parentAuthor]), [
    [2n, 2, true, false, author], [3n, 0, false, false, author], [4n, 0, false, false, author],
  ])
  const lone = prepareRow({ kind: 'timeline' }, root, { chains: new Map(), groups: new Map(), parents: new Map(), ended: new Set() })
  assert.equal(lone.key, row.key, 'a post keeps its row when its first reply arrives')
  assert.equal(lone.root.post, root)
  assert.deepEqual(lone.cards, [])
})

test('sibling replies do not repeat a label for the parent already shown at the top', () => {
  const cards = [feedPost(175, 168), feedPost(176, 168), feedPost(177, 168)]
  assert.deepEqual([...gapsIn(168n, cards)], [])
})

test('following shows immediate followed parents without spending a preview slot on them', async () => {
  const stranger = address('88')
  feedHistory([feedPost(135, 0, stranger), feedPost(136, 135), feedPost(137, 136), feedPost(138, 135), feedPost(139, 135)])
  const page = await counted(loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: false, authors: [author] }))
  const row = page.rows[0]
  assert.equal(row.root.omitted, false)
  assert.deepEqual(ids(row.cards.map(c => c.post)), [136, 137, 138, 139])
  assert.deepEqual(ids(row.cards.filter(c => c.gap).map(c => c.post)), [138], 'returning to #135 starts one new sibling group')
  assert.deepEqual(row.cards.map(c => c.joins), [true, false, false, false])
  assert.equal(row.root.drawn, 3)
})

test('six followed siblings under a stranger keep three previews and three more replies', async () => {
  feedHistory([feedPost(1, 0, address('88')), ...Array.from({ length: 6 }, (_, i) => feedPost(i + 2, 1))])
  const page = await counted(loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: false, authors: [author] }))
  const row = page.rows[0]
  assert.equal(row.root.omitted, false)
  assert.deepEqual(ids(row.cards.map(c => c.post)), [5, 6, 7])
  assert.equal(page.counts.get(1n) - row.root.drawn, 3)
  assert.deepEqual(row.cards.map(c => c.gap), [false, false, false], 'all three siblings join the root context card')
})

for (const keyring of [false, true]) test(`an own reply keeps its stranger parent in ${keyring ? 'keyring' : 'following'}, without selecting other replies to the reader`, async () => {
  const stranger = address('88'), outsider = address('77')
  feedHistory([feedPost(1, 0, stranger), feedPost(2, 1, stranger), feedPost(3, 2), feedPost(4, 0), feedPost(5, 4, outsider)])
  const filter = keyring ? { kind: 'following', includeRepliesToViewer: false, authors: [author], viewer: author } : { kind: 'following', includeRepliesToViewer: true, authors: [author], viewer: author }
  const page = await counted(loadFeed(mock.chain, filter))
  const row = page.rows.find(r => r.root.id === 2n)
  assert.deepEqual(ids(row.cards.map(c => c.post)), [3])
  assert.equal(row.root.post.id, 2n, 'only the immediate parent supplies context')
  assert.equal(row.root.omitted, false)
  if (keyring) assert.ok(!page.rows.some(r => r.cards.some(c => c.post.id === 5n)))
})

for (const reader of [undefined, author]) test(`a selected reply shows its stranger parent ${reader ? 'when connected' : 'when signed out'}`, async () => {
  feedHistory([feedPost(1, 0, address('88')), feedPost(2, 1)])
  const row = (await loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: true, authors: [author], viewer: reader })).rows[0]
  assert.equal(row.root.omitted, false)
  assert.equal(row.root.joins, true)
})

test('unselected ancestors cannot keep a row alive after its only selected reply is deleted', async () => {
  const stranger = address('88')
  feedHistory([feedPost(1, 0, stranger), feedPost(2, 1, stranger), feedPost(3, 2)])
  mock.gates.set(3n, '0x0000000000000000000000000000000000000001')
  const page = await loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: false, authors: [author] })
  assert.deepEqual(page.rows, [])
})

for (const gate of ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002']) test(`own replies retain ended parent context and its correct count (${gate})`, async () => {
  feedHistory([feedPost(1, 0, address('88')), feedPost(2, 1, address('88')), feedPost(3, 2)])
  mock.gates.set(2n, gate)
  const row = (await loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: true, authors: [author], viewer: author })).rows[0]
  assert.equal(row.root.post.id, 2n, 'the ended parent remains as a root placeholder')
  assert.equal(row.root.omitted, false)
  assert.deepEqual(ids(row.cards.map(c => c.post)), [3])
  assert.equal(row.root.drawn, 1, 'only the live answer counts as a reply')
})

test('muting the only selected reply leaves no empty context row', async () => {
  const { muted } = await load('lib/muted.svelte.ts')
  const stranger = address('88'), filter = { kind: 'following', includeRepliesToViewer: false, authors: [author] }
  feedHistory([feedPost(1, 0, stranger), feedPost(2, 1, stranger), feedPost(3, 2)])
  await loadFeed(mock.chain, filter)
  muted.toggle(author)
  try { assert.deepEqual((await loadFeed(mock.chain, filter)).rows, []) }
  finally { muted.toggle(author) }
})

test('curated shows every loaded qualifying reply, including earlier replies in a conversation', async () => {
  curate([author])
  const outsider = address('88')
  feedHistory([feedPost(23), feedPost(26, 23, outsider), feedPost(43, 23), feedPost(45, 26),
    feedPost(46, 45, outsider), feedPost(48, 46), feedPost(50, 43), feedPost(51, 23), feedPost(52, 23, outsider)])
  const page = await loadFeed(mock.chain, { kind: 'timeline', curatedOnly: true })
  assert.deepEqual(page.rows.map(row => row.root.id), [23n, 46n, 26n])
  assert.deepEqual(page.rows.map(row => ids(row.cards.map(c => c.post))), [[43, 50, 51], [48], [45]],
    'all curated replies remain in their selected branches, with immediate parent context')
  assert.ok(!mock.calls.some(c => c.method === 'replies'), 'showing selected replies never expands a reply page')
})

test('curated shows more than three loaded siblings while everyone keeps its preview limit', async () => {
  curate([author])
  feedHistory([feedPost(1), ...Array.from({ length: 6 }, (_, i) => feedPost(i + 2, 1))])
  const curated = await loadFeed(mock.chain, { kind: 'timeline', curatedOnly: true })
  assert.deepEqual(ids(curated.rows[0].cards.map(c => c.post)), [2, 3, 4, 5, 6, 7])
  const everyone = await loadFeed(mock.chain, { kind: 'timeline', viewer: author })
  assert.deepEqual(ids(everyone.rows[0].cards.map(c => c.post)), [5, 6, 7])
})


test('curated traverses loaded branches depth first with oldest siblings first', async () => {
  curate([author])
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 1), feedPost(4, 2),
    feedPost(5, 4), feedPost(6, 2), feedPost(7, 3)])
  const page = await loadFeed(mock.chain, { kind: 'timeline', curatedOnly: true })
  const row = page.rows[0]
  assert.deepEqual(ids(row.cards.map(c => c.post)), [2, 4, 5, 6, 3, 7])
  assert.deepEqual(row.cards.map(c => c.joins), [true, true, false, false, true, false])
  assert.deepEqual(row.cards.map(c => c.drawn), [2, 1, 0, 0, 1, 0])
  assert.deepEqual(mock.calls.map(c => c.method), ['feed'], 'ordering adds no reads')
})

test('depth-first order groups missing-parent siblings and preserves their context labels', async () => {
  const { branchOrder, conversationCards } = await load('features/streams/conversation.ts')
  const posts = [feedPost(12, 4), feedPost(8, 2), feedPost(11, 7), feedPost(9, 4), feedPost(10, 2)]
  const before = [...posts]
  const ordered = branchOrder(posts)
  assert.deepEqual(ids(ordered), [8, 10, 9, 12, 11])
  assert.deepEqual(conversationCards(1n, ordered).filter(c => c.gap).map(c => c.post.parentId), [2n, 4n, 7n])
  assert.deepEqual(posts, before, 'ordering does not mutate the loaded records')
})


for (const stream of ['following', 'curated', 'everyone']) test(`${stream} previews only activity newer than the next conversation, keeping parent context`, async () => {
  curate([author])
  feedHistory([feedPost(230), feedPost(232, 230), feedPost(243, 232), feedPost(280, 230), feedPost(386), feedPost(514, 230)])
  const page = await counted(loadFeed(mock.chain, stream === 'following' ? { kind: 'following', authors: [author], includeRepliesToViewer: false } : { kind: 'timeline', curatedOnly: stream === 'curated', viewer: author }))
  assert.deepEqual(page.rows.map(r => Number(r.root.id)), [230, 386])
  assert.deepEqual(ids(page.rows[0].cards.map(c => c.post)), [514])
  assert.equal(page.rows[0].root.drawn, 1)
  assert.equal(page.counts.get(230n), 3, 'older direct replies remain available through the count')
})

test('the preview cutoff uses the next conversation newest reply, not its old root or lead', async () => {
  feedHistory([feedPost(1), feedPost(2), feedPost(3, 2), feedPost(4, 1), feedPost(5, 3), feedPost(6, 1)])
  const page = await loadFeed(mock.chain, { kind: 'following', authors: [author], includeRepliesToViewer: false })
  assert.deepEqual(page.rows.map(r => Number(r.root.id)), [1, 2])
  assert.deepEqual(ids(page.rows[0].cards.map(c => c.post)), [6])
  assert.deepEqual(ids(page.rows[1].cards.map(c => c.post)), [3, 5], 'the last row has no cutoff')
})


test('a recent nested reply retains its older immediate parent, but not an old sibling', async () => {
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 1), feedPost(4), feedPost(5, 2)])
  const page = await loadFeed(mock.chain, { kind: 'following', authors: [author], includeRepliesToViewer: false })
  assert.deepEqual(ids(page.rows[0].cards.map(c => c.post)), [2, 5])
  assert.equal(page.rows[0].root.drawn, 1)
  assert.equal(page.rows[0].cards[0].joins, true)
})

for (const rootOpen of [false, true]) test(`refresh preserves an explicitly opened ${rootOpen ? 'root' : 'older preview'} branch`, async () => {
  const filter = { kind: 'following', authors: [author], includeRepliesToViewer: false }
  const history = [feedPost(1), feedPost(2, 1), feedPost(3, 2)]
  feedHistory(history)
  await loadFeed(mock.chain, filter)
  const expansion = new RowExpansion(expansionOf(feedKey(mock.chain, filter)), 1n)
  expansion.press(rootOpen ? 1n : 2n)
  // Three new siblings push the opened card outside the usual preview limit.
  feedHistory([...history, feedPost(4), feedPost(5, 1), feedPost(6, 1), feedPost(7, 1)])
  const page = await loadFeed(mock.chain, filter)
  assert.equal(expansion.isOpen(rootOpen ? 1n : 2n), true)
  if (!rootOpen) assert.deepEqual(ids(page.rows[0].cards.map(c => c.post)), [2, 5, 6, 7], 'the opened card survives, with its branch choice intact')
  assert.equal(page.rows[0].root.id, 1n)
})

test('paging and returning preserve the existing automatic preview cutoff', async () => {
  const filter = { kind: 'following', authors: [author], includeRepliesToViewer: false }
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3), feedPost(4, 1), ...Array.from({ length: 30 }, (_, i) => feedPost(i + 5))])
  const first = await loadFeed(mock.chain, filter)
  const more = await olderFeed(mock.chain, filter, 40)
  assert.deepEqual(more.rows.slice(0, first.limit), first.rows.slice(0, first.limit))
  assert.deepEqual((await resumeFeed(mock.chain, filter, 40)).rows, more.rows)
})


for (const stream of ['following', 'curated', 'everyone']) test(`${stream} keeps every newly discovered reply despite polls, age cutoff and preview limit`, async () => {
  curate([author])
  const filter = stream === 'following' ? { kind: 'following', authors: [author], includeRepliesToViewer: false } : { kind: 'timeline', curatedOnly: stream === 'curated', viewer: author }
  const history = [feedPost(1), feedPost(2, 1)]
  feedHistory(history)
  const before = await loadFeed(mock.chain, filter)
  history.push(...[3, 4, 5, 6, 7].map(id => feedPost(id, 1)), feedPost(8), feedPost(9, 1))
  feedHistory(history)
  await peekFeed(mock.chain, filter)
  await peekFeed(mock.chain, filter)
  assert.deepEqual(ids(before.rows[0].cards.map(c => c.post)), [2], 'background polls leave the shown preview alone')
  const refreshed = await loadFeed(mock.chain, filter)
  const replies = page => ids(page.rows.find(r => r.root.id === 1n).cards.map(c => c.post))
  assert.deepEqual(replies(refreshed), [3, 4, 5, 6, 7, 9], 'all new replies bypass both preview limits; old reply #2 does not')
  assert.deepEqual(replies(await olderFeed(mock.chain, filter)), replies(refreshed), 'paging keeps the newly revealed replies')
  assert.deepEqual(replies(await resumeFeed(mock.chain, filter)), replies(refreshed), 'Back keeps the newly revealed replies')
  assert.deepEqual(replies(await loadFeed(mock.chain, filter)), [9], 'the next explicit refresh can apply the cutoff to replies already loaded')
})


for (const retired of [false, true]) test(`a ${retired ? 'retired cursor' : 'failed refresh'} does not consume the new-reply exemption`, async () => {
  const filter = { kind: 'following', authors: [author], includeRepliesToViewer: false }
  feedHistory([feedPost(1), feedPost(2, 1)])
  await loadFeed(mock.chain, filter)
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 1), feedPost(4), feedPost(5, 1)])
  if (retired) mock.firstRetained = 1000n
  else {
    mock.failRead = url => url.endsWith('/changes')
    await assert.rejects(loadFeed(mock.chain, filter))
    mock.failRead = null
  }
  const page = await loadFeed(mock.chain, filter)
  assert.deepEqual(ids(page.rows[0].cards.map(c => c.post)), [3, 5])
})

for (const stream of ['following', 'curated', 'everyone']) test(`${stream} local reloads preserve previews until an explicit refresh`, async () => {
  curate([author])
  const filter = stream === 'following' ? { kind: 'following', authors: [author], includeRepliesToViewer: false } : { kind: 'timeline', curatedOnly: stream === 'curated', viewer: author }
  const history = [feedPost(1), feedPost(2, 1), feedPost(3, 1), feedPost(4, 1)]
  feedHistory(history)
  const replies = page => ids(page.rows.find(r => r.root.id === 1n).cards.map(c => c.post))
  assert.deepEqual(replies(await loadFeed(mock.chain, filter)), [2, 3, 4])
  history.push(feedPost(5), feedPost(6, 1))
  feedHistory(history)
  assert.deepEqual(replies(await loadFeed(mock.chain, filter, { preservePreviews: true })), [2, 3, 4, 6], 'an action reload keeps existing previews, even past the cap')
  history.push(feedPost(7, 1), feedPost(8), feedPost(9, 1))
  feedHistory(history)
  assert.deepEqual(replies(await loadFeed(mock.chain, filter, { preservePreviews: true })), [2, 3, 4, 6, 7, 9], 'successive local updates keep both old previews and all new replies')
  assert.deepEqual(replies(await loadFeed(mock.chain, filter)), [9], 'only an explicit refresh folds the previously loaded replies')
  history.push(feedPost(10, 1), feedPost(11), feedPost(12, 1))
  feedHistory(history)
  assert.deepEqual(replies(await loadFeed(mock.chain, filter)), [10, 12])
  mock.firstRetained = 1000n
  assert.deepEqual(replies(await loadFeed(mock.chain, filter, { preservePreviews: true })), [10, 12], 'cursor recovery during a local reload preserves the exemption')
})


test('local cursor recovery preserves previews from beyond the first screen', async () => {
  const filter = { kind: 'following', authors: [author], includeRepliesToViewer: false }
  const history = [feedPost(1), feedPost(2, 1), feedPost(3, 1), feedPost(4, 1),
    ...Array.from({ length: 30 }, (_, i) => feedPost(i + 10))]
  feedHistory(history)
  const first = await loadFeed(mock.chain, filter, { limit: 40 })
  assert.ok(first.rows.findIndex(r => r.root.id === 1n) >= 20)
  history.push(feedPost(40), feedPost(41, 1))
  feedHistory(history)
  mock.firstRetained = 1000n
  const next = await loadFeed(mock.chain, filter, { preservePreviews: true })
  assert.deepEqual(ids(next.rows.find(r => r.root.id === 1n).cards.map(c => c.post)), [2, 3, 4, 41])
})

test('a rebuilt index starts with the initial preview policy', async () => {
  const filter = { kind: 'following', authors: [author], includeRepliesToViewer: false }
  feedHistory([feedPost(1), feedPost(2, 1)])
  await loadFeed(mock.chain, filter)
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 1), feedPost(4), feedPost(5, 1)])
  const refreshed = await loadFeed(mock.chain, filter)
  assert.deepEqual(ids(refreshed.rows[0].cards.map(c => c.post)), [3, 5])
  mock.generation = `0x${'bb'.repeat(32)}`
  const rebuilt = await loadFeed(mock.chain, filter, { preservePreviews: true })
  assert.deepEqual(ids(rebuilt.rows[0].cards.map(c => c.post)), [5], 'an exemption from another index generation is not reused')
})


test('Everyone keeps immediate parent context for a recent nested reply', async () => {
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 1), feedPost(4), feedPost(5, 2)])
  const page = await loadFeed(mock.chain, { kind: 'timeline', viewer: author })
  assert.deepEqual(ids(page.rows[0].cards.map(c => c.post)), [2, 5])
})


test('Everyone preserves an explicitly opened parent card after its child folds', async () => {
  curate([author])
  const filter = { kind: 'timeline', viewer: author }
  const history = [feedPost(1), feedPost(2, 1), feedPost(3, 2)]
  feedHistory(history)
  const initial = await loadFeed(mock.chain, filter)
  assert.deepEqual(ids(initial.rows[0].cards.map(c => c.post)), [2, 3])
  const expansion = new RowExpansion(expansionOf(feedKey(mock.chain, filter)), 1n)
  expansion.press(2n)
  feedHistory([...history, feedPost(4), feedPost(5, 1)])
  const refreshed = await loadFeed(mock.chain, filter)
  assert.deepEqual(ids(refreshed.rows[0].cards.map(c => c.post)), [2, 5], 'the opened parent remains; its list owns the older child')
  assert.equal(expansion.isOpen(2n), true)
  expansion.hide(2n)
  assert.deepEqual(ids((await loadFeed(mock.chain, filter)).rows[0].cards.map(c => c.post)), [5], 'a dismissed context card is eligible to fold again')
})


for (const gate of ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002']) test(`an opened context card does not survive ending (${gate})`, async () => {
  const other = address('88'), filter = { kind: 'timeline', viewer: author }
  const history = [feedPost(1, 0, other), feedPost(2, 1, other), feedPost(3, 2)]
  feedHistory(history)
  await loadFeed(mock.chain, filter)
  const expansion = new RowExpansion(expansionOf(feedKey(mock.chain, filter)), 1n)
  expansion.press(2n)
  feedHistory([...history, feedPost(4), feedPost(5, 1)])
  gateChanged(2n, gate, 6n)
  const refreshed = await loadFeed(mock.chain, filter)
  assert.deepEqual(ids(refreshed.rows[0].cards.map(c => c.post)), [5], 'old expansion state cannot keep a deleted or removed context card')
})


for (const rootSelected of [false, true]) test(`curated ${rootSelected ? 'keeps a selected root' : 'omits orphaned root context'} after older replies fold`, async () => {
  curate([author])
  const other = address('88')
  feedHistory([feedPost(75, 0, rootSelected ? author : other), feedPost(76, 75),
    feedPost(82, 76, other), feedPost(100, 82), feedPost(562),
    feedPost(578, 100, other), feedPost(579, 578)])
  const page = await loadFeed(mock.chain, { kind: 'timeline', curatedOnly: true, viewer: author })
  const row = page.rows.find(r => r.root.id === 75n)
  assert.deepEqual(ids(row.cards.map(c => c.post)), [100, 578, 579])
  assert.equal(row.root.omitted, !rootSelected, 'a root kept only for context needs a displayed direct reply')
})

test('curated keeps an unlisted parent when a displayed reply directly answers it', async () => {
  curate([author])
  const other = address('88')
  feedHistory([feedPost(75, 0, other), feedPost(76, 75), feedPost(562), feedPost(579, 75)])
  const row = (await loadFeed(mock.chain, { kind: 'timeline', curatedOnly: true, viewer: author })).rows[0]
  assert.deepEqual(ids(row.cards.map(c => c.post)), [579])
  assert.equal(row.root.omitted, false)
})

for (const includeRepliesToViewer of [false, true]) test(`${includeRepliesToViewer ? 'Following' : 'Keyring'} keeps an opened context root and its expansion identity across refresh`, async () => {
  const other = address('88'), filter = { kind: 'following', authors: [author], includeRepliesToViewer }
  const history = [feedPost(1, 0, other), feedPost(2, 1, other), feedPost(3, 2)]
  feedHistory(history)
  const initial = await loadFeed(mock.chain, filter)
  assert.equal(initial.rows[0].key, 2n)
  const expansion = new RowExpansion(expansionOf(feedKey(mock.chain, filter)), 2n)
  expansion.press(2n)
  feedHistory([...history, feedPost(4), feedPost(5, 1)])
  const refreshed = await loadFeed(mock.chain, filter)
  const row = refreshed.rows.find(r => r.key === 2n)
  assert.equal(row.root.post.id, 2n)
  assert.equal(row.root.omitted, false)
  assert.equal(expansion.isOpen(2n), true)
  assert.deepEqual(ids(row.cards.map(c => c.post)), [3])
})


for (const curatedOnly of [false, true]) test(`${curatedOnly ? 'Curated' : 'Everyone'} keeps an opened context branch separate from a newer sibling branch`, async () => {
  curate([author])
  const other = address('88'), filter = { kind: 'timeline', curatedOnly, viewer: author }
  const history = [feedPost(1, 0, other), feedPost(2, 1, other), feedPost(3, 2)]
  feedHistory(history)
  const initial = await loadFeed(mock.chain, filter)
  assert.equal(initial.rows[0].root.id, 2n)
  assert.deepEqual(ids(initial.rows[0].cards.map(c => c.post)), [3])
  const expansion = new RowExpansion(expansionOf(feedKey(mock.chain, filter)), 2n)
  expansion.press(2n)
  feedHistory([...history, feedPost(4), feedPost(5, 1)])
  const refreshed = await loadFeed(mock.chain, filter)
  assert.deepEqual(refreshed.rows.map(row => row.root.id), [1n, 4n, 2n])
  assert.deepEqual(ids(refreshed.rows[0].cards.map(c => c.post)), [5])
  assert.deepEqual(ids(refreshed.rows[2].cards.map(c => c.post)), [3])
  assert.equal(expansion.isOpen(2n), true, 'the older branch retains its own expansion choice')
})

for (const stream of ['curated', 'following', 'everyone']) test(`${stream} returning and paging preserve context without revealing another ancestor`, async () => {
  curate([author])
  const other = address('88')
  const filter = stream === 'following'
    ? { kind: 'following', authors: [author], includeRepliesToViewer: false }
    : { kind: 'timeline', curatedOnly: stream === 'curated', viewer: author }
  feedHistory([feedPost(1, 0, other), feedPost(2, 1), feedPost(3), feedPost(4, 2)])
  const first = await counted(loadFeed(mock.chain, filter))
  assert.deepEqual(ids(first.rows[0].cards.map(c => c.post)), [2, 4])
  assert.equal(first.rows[0].root.omitted, stream !== 'everyone', 'only an independently selected root stays above this context')
  for (const read of [resumeFeed, resumeFeed, olderFeed]) {
    const returned = await counted(read(mock.chain, filter))
    assert.deepEqual(returned.rows, first.rows, 'retaining a context card must not promote it into an automatic preview')
  }
})

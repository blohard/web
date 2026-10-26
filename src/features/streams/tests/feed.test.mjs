// Feeds: pairs and groups, deletion and muting in a timeline, replies to the reader, the sponsored-tab rule, the refresh cue.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { curate, load, mock, install, teardown, address, hash, author, txHash, feedPost, feedHistory, ids, counted, at, gateChanged, response, deferred } from '../../../../scripts/host-harness.mjs'

const { TOMBSTONE, REMOVED } = await load('lib/board.ts')
const { getMessage } = await load('lib/messages.ts')
const { loadFeed, resumeFeed, feedCue, peekFeed } = await load('features/streams/feed.ts')
const { withInlined, drawnReplies } = await load('features/streams/conversation.ts')
const { gates: ledger } = await load('lib/gates.svelte.ts')

beforeEach(install)
after(teardown)

test('inlined replies to one post form one group, placed by its newest member', () => {
  const ev = (id, parentId, block, who = address('55')) =>
    ({ id: BigInt(id), author: who, parentId: BigInt(parentId), contentHash: hash('66'), blockNumber: BigInt(block), logIndex: 0, txHash: hash('77') })
  const top = [ev(1, 0, 1, author), ev(2, 0, 2, address('88'))]
  const replies = [
    ...[10, 11, 12, 13, 14].map((i) => ev(i, 1, i)), // five direct replies to the reader's post 1
    ev(20, 2, 20, author), // the reader's own reply to post 2
    ev(21, 14, 21), // an inlined reply answering reply 14: a chain under it
  ]
  const { posts, chains, groups } = withInlined(top, replies)
  // Neither parent is repeated on its own; each group is represented by its newest direct reply.
  assert.deepEqual(posts.map((p) => Number(p.id)), [14, 20])
  const g = groups.get(14n)
  assert.deepEqual(g.map((p) => Number(p.id)), [10, 11, 12, 13, 14], 'every reply, oldest first; the preview picks from them')
  assert.equal(groups.has(20n), false, 'a lone reply is no group')
  assert.deepEqual(chains.get(14n).map((p) => Number(p.id)), [21])
  // Without the chain, the group (newest member block 14) falls below the reply at block 20.
  const again = withInlined(top, replies.filter((r) => r.id !== 21n))
  assert.deepEqual(again.posts.map((p) => Number(p.id)), [20, 14])
})

for (const answers of [0, 1, 2, 3, 4]) test(`a profile reply remains visible with ${answers} answers from the reader`, async () => {
  const reader = address('33'), stranger = address('44')
  const responses = Array.from({ length: answers }, (_, i) => feedPost(i + 3, 2, reader, author))
  feedHistory([feedPost(1, 0, stranger), feedPost(2, 1, author, stranger), ...responses])
  const page = await counted(loadFeed(mock.chain, { kind: 'author-replies', address: author, viewer: reader }))
  assert.equal(page.rows.length, 1)
  const row = page.rows[0]
  assert.equal(row.key, 2n)
  assert.equal(row.root.id, 1n)
  assert.deepEqual(ids(row.cards.map(c => c.post)), [2, ...ids(responses.slice(-2))])
  assert.equal(page.counts.get(2n), answers)
  assert.equal(row.cards[0].drawn, Math.min(answers, 2), 'older answers remain reachable through the reply count')
  assert.deepEqual(row.cards.map(c => c.gap), [false, ...responses.slice(-2).map(() => false)])
})

test('a chain with a branch is drawn flattened; what each card has beneath it follows who answers whom, not the order', () => {
  const ev = (id, parentId) =>
    ({ id: BigInt(id), author, parentId: BigInt(parentId), contentHash: hash('66'), blockNumber: BigInt(id), logIndex: 0, txHash: hash('77') })
  const top = [{ ...ev(1, 0), author: address('88') }]
  // The reader answers post 1 (2), answers that twice (3, 4) and answers 3 once more (5).
  const replies = [ev(2, 1), ev(3, 2), ev(4, 2), ev(5, 3)]
  const { posts, chains } = withInlined(top, replies)
  assert.deepEqual(posts.map((p) => Number(p.id)), [2])
  const chain = chains.get(2n)
  assert.deepEqual(chain.map((p) => Number(p.id)), [3, 5, 4], 'depth first: 5 answers 3, then the sibling 4 answers 2 again')
  // Drawn beneath post 1 in that order, 2 has two replies on screen and 3 one; 5 and 4 none. Position would say 3 has one (5), 5 has one (4), 4 none.
  const drawn = drawnReplies([replies[0], ...chain])
  assert.deepEqual([...drawn].map(([id, n]) => [Number(id), n]), [[1, 1], [2, 2], [3, 1]])
})

test('deleted entries disappear from every feed, including after a refresh with no new posts', async () => {
  const posts = [feedPost(1), feedPost(2, 1, address('88')), feedPost(3, 2)]
  feedHistory(posts)
  const filters = [
    { kind: 'timeline' },
    { kind: 'following', includeRepliesToViewer: false, authors: [author] },
    { kind: 'author', address: author },
    { kind: 'author-replies', address: author },
  ]
  for (const f of filters) assert.ok((await loadFeed(mock.chain, f)).rows.map((r) => r.lead).length > 0, f.kind)
  // The post and the reply to it go, as events a refresh scans; the surviving
  // reply keeps its place in the views that select it, with its deleted parent
  // kept as context.
  gateChanged(1n, TOMBSTONE, 4n); gateChanged(2n, TOMBSTONE, 4n)
  for (const f of filters) {
    const page = await loadFeed(mock.chain, f)
    const expected = f.kind === 'following' || f.kind === 'author-replies' ? [3] : []
    assert.deepEqual(ids(page.rows.map((r) => r.lead)), expected, f.kind)
    if (expected.length) {
      assert.ok(page.rows[0].cards.some((c) => c.post.id === 3n) || page.rows[0].lead.id === 3n, f.kind)
      assert.equal(ledger.message(mock.chain, 2n), TOMBSTONE, 'the retained parent is only deleted context')
    }
  }
  // With the last survivor deleted, nothing is left anywhere.
  gateChanged(3n, TOMBSTONE, 5n)
  for (const f of filters) assert.deepEqual((await loadFeed(mock.chain, f)).rows.map((r) => r.lead), [], f.kind)
})

test('deleted inlined replies occupy no group slots; deleted ancestors survive only as reply context', async () => {
  const posts = [feedPost(1), feedPost(2, 1), feedPost(3, 1), feedPost(4, 2), feedPost(5, 4), feedPost(6, 1)]
  feedHistory(posts)
  for (const id of [1n, 2n, 4n, 6n]) mock.gates.set(id, TOMBSTONE)
  const page = await loadFeed(mock.chain, { kind: 'timeline', viewer: author })
  assert.deepEqual(ids(page.rows.map((r) => r.lead)), [3])
  assert.deepEqual(ids(page.rows[0].cards.map((c) => c.post)), [3, 4, 5], 'the newest three, a deleted ancestor among them as context')
  assert.deepEqual(page.rows[0].cards.map((c) => c.gap), [false, true, false], 'the deleted 4 links to the deleted 2 it answers')
  // Once the last live descendant is deleted, its entire deleted branch goes.
  gateChanged(5n, TOMBSTONE, 7n)
  const refreshed = await loadFeed(mock.chain, { kind: 'timeline', viewer: author })
  assert.deepEqual(ids(refreshed.rows.map((r) => r.lead)), [3])
  assert.deepEqual(ids(refreshed.rows[0].cards.map((c) => c.post)), [3])
})

test('deactivated authors remain visible, but deleted and removed messages do not', async () => {
  feedHistory([feedPost(1), feedPost(2), feedPost(3)])
  mock.authorGate = TOMBSTONE
  mock.gates.set(1n, TOMBSTONE); mock.gates.set(2n, REMOVED)
  mock.gateError = true // Separate point reads would fail; page records suffice.
  const page = await counted(loadFeed(mock.chain, { kind: 'timeline' }))
  assert.deepEqual(ids(page.rows.map((r) => r.lead)), [3])
  assert.equal(mock.calls.some((c) => c.method === 'state' || c.method === 'message'), false)
})

test('the new-post cue does not count deleted posts', async () => {
  const filter = { kind: 'timeline' }
  feedHistory([feedPost(1)])
  await loadFeed(mock.chain, filter)
  feedHistory([feedPost(1), feedPost(2), feedPost(3)])
  mock.gates.set(2n, TOMBSTONE)
  assert.equal(await peekFeed(mock.chain, filter), 1)
})

test('a home poll carries the reader\'s mentions and quotes to a listener in the request it makes anyway', async () => {
  const filter = { kind: 'timeline', viewer: author }
  feedHistory([feedPost(1)])
  await loadFeed(mock.chain, filter)
  feedHistory([feedPost(1), feedPost(2, 1, address('77'))])
  const answers = [], listener = { account: author, heard: (answer) => answers.push(answer) }
  await peekFeed(mock.chain, filter, listener)
  const asked = mock.calls.filter((c) => c.method === 'changes')
  assert.equal(asked.length, 1, 'one request serves the feed and the listener')
  assert.equal(asked[0].scope.account, author)
  assert.equal(asked[0].scope.exclude_list, undefined, 'no exclusion list, whose changes would stop the scan')
  assert.equal(asked[0].scope.feed.any.length, 3, 'the timeline already selects replies to the reader')
  assert.deepEqual(answers.map((a) => a.records.some((r) => r.id === '2')), [true])
  await peekFeed(mock.chain, filter)
  assert.equal(mock.calls.filter((c) => c.method === 'changes').at(-1).scope.account, undefined, 'without a listener the scope is the feed\'s alone')
})

test('feed counts drop deletions and removals without scanning old reply history on refresh', async () => {
  const filter = { kind: 'timeline' }
  const posts = [feedPost(1), feedPost(2, 1), feedPost(3, 1)]
  feedHistory(posts)
  assert.equal((await counted(loadFeed(mock.chain, filter))).counts.get(1n), 2)
  gateChanged(2n, REMOVED, 4n)
  mock.calls = []
  assert.equal((await counted(loadFeed(mock.chain, filter))).counts.get(1n), 1)
  assert.equal(mock.calls.filter((c) => c.method === 'changes').length, 1, 'one scoped change page carries new posts, gates and counts')
  feedHistory([...posts, at(5, 4, 1)])
  assert.equal((await counted(loadFeed(mock.chain, filter))).counts.get(1n), 2)
  gateChanged(3n, TOMBSTONE, 6n); gateChanged(4n, REMOVED, 6n)
  assert.equal((await counted(loadFeed(mock.chain, filter))).counts.get(1n), 0)
})

test('timeline views pair direct replies to the reader’s messages under them, the reader’s answer chained beneath', async () => {
  const stranger = address('88')
  // The reader's post, a stranger's post, the stranger's reply to the reader, and the reader's reply to that.
  feedHistory([feedPost(25), feedPost(26, 0, stranger), feedPost(28, 25, stranger), feedPost(29, 28)])
  for (const curatedOnly of [false, true]) {
    const page = await loadFeed(mock.chain, { kind: 'timeline', curatedOnly, viewer: author })
    assert.deepEqual(ids(page.rows.map((r) => r.lead)), [28, 26], `curatedOnly ${curatedOnly}: one block for the conversation, the reader's post not repeated`)
    assert.equal(page.rows[0].lead.parentId, 25n, 'the block hangs from the reader’s post')
    assert.deepEqual(ids(page.rows[0].cards.slice(1).map((c) => c.post)), [29], 'the reader’s answer chains beneath the reply')
  }
  // With nobody listed, Curated includes none of this conversation.
  // A chain whose list is configured from the start, as a host publishes it, opens its own view.
  const listed = { ...mock.chain, contract: address('c0'), curated: true }
  mock.blocked = false
  const sponsored = await loadFeed(listed, { kind: 'timeline', curatedOnly: true, viewer: author })
  assert.deepEqual(ids(sponsored.rows.map((r) => r.lead)), [])
  // Without a reader there is nobody to pair for: the timeline is top-level posts alone.
  const anonymous = await loadFeed(mock.chain, { kind: 'timeline' })
  assert.deepEqual(ids(anonymous.rows.map((r) => r.lead)), [26, 25])
})

for (const populated of [false, true]) test(`keyring selects only its ${populated ? 'chosen authors' : 'empty author list'}`, async () => {
  const member = address('77'), stranger = address('88')
  const filter = { kind: 'following', includeRepliesToViewer: false, authors: populated ? [member] : [] }
  const posts = [feedPost(1), feedPost(2), feedPost(3, 0, member), feedPost(4, 0, stranger), feedPost(5, 1, stranger), feedPost(6, 1, member)]
  feedHistory(posts)
  const page = await loadFeed(mock.chain, filter)
  const leads = (p) => ids(p.rows.map((r) => r.lead))
  assert.deepEqual(leads(page), populated ? [6, 3] : [])
  if (populated) assert.equal(page.rows[0].lead.parentId, 1n, 'the reader’s post remains as context for a selected author’s reply')
  const query = mock.calls.find((c) => c.method === 'feed')?.filter
  if (query) assert.ok(!query.any.some((c) => c.parent_authors?.includes(author)))

  feedHistory([...posts, feedPost(7, 2, stranger)])
  assert.equal(await peekFeed(mock.chain, filter), 0, 'an unrelated reply to the reader does not cue refresh')
  feedHistory([...posts, feedPost(7, 2, stranger), feedPost(8, 2, member)])
  assert.equal(await peekFeed(mock.chain, filter), populated ? 1 : 0, 'only a selected author cues refresh')
  assert.deepEqual(leads(page), populated ? [6, 3] : [], 'polling does not move the displayed feed')
  const refreshed = await loadFeed(mock.chain, filter)
  assert.deepEqual(leads(refreshed), populated ? [8, 6, 3] : [])
})

test('a muted reply to the reader’s post leaves the post standing, and stays only as context above the reader’s own answer', async () => {
  const { muted } = await load('lib/muted.svelte.ts')
  const loud = address('88')
  feedHistory([feedPost(1), feedPost(2, 1, loud), feedPost(3, 0, loud)])
  muted.toggle(loud)
  try {
    const page = await counted(loadFeed(mock.chain, { kind: 'timeline', viewer: author }))
    assert.deepEqual(ids(page.rows.map((r) => r.lead)), [1], 'the reader’s post stands; the muted reply and the muted post are gone')
    assert.equal(page.counts.get(1n), 1, 'the reply still counts')
    // The reader answers the muted reply: the reply stays as the context between the post and the answer.
    feedHistory([feedPost(1), feedPost(2, 1, loud), feedPost(3, 0, loud), feedPost(4, 2)])
    const answered = await loadFeed(mock.chain, { kind: 'timeline', viewer: author })
    assert.deepEqual(ids(answered.rows.map((r) => r.lead)), [2])
    assert.equal(answered.rows[0].lead.parentId, 1n)
    assert.deepEqual(ids(answered.rows[0].cards.slice(1).map((c) => c.post)), [4])
  } finally {
    muted.toggle(loud)
  }
})

test('a deleted post or reply whose only surviving replier is muted leaves with the reply', async () => {
  const { muted } = await load('lib/muted.svelte.ts')
  const loud = address('88')
  const filter = { kind: 'timeline', viewer: author }
  // A deleted post of the reader's with one reply, by someone the reader then mutes.
  feedHistory([feedPost(1), feedPost(2, 1, loud)])
  mock.gates.set(1n, TOMBSTONE)
  assert.deepEqual(ids((await loadFeed(mock.chain, filter)).rows.map((r) => r.lead)), [2], 'the reply shows with the deleted post as its context')
  muted.toggle(loud)
  try {
    assert.deepEqual((await loadFeed(mock.chain, filter)).rows.map((r) => r.lead), [], 'nothing stands for a deleted post over a muted reply')
    // A deleted reply of the reader's, answered only by the muted author: gone too, the post stands alone.
    feedHistory([feedPost(3), feedPost(4, 3), feedPost(5, 4, loud)])
    mock.gates.set(4n, TOMBSTONE)
    const page = await loadFeed(mock.chain, filter)
    assert.deepEqual(ids(page.rows.map((r) => r.lead)), [3])
    assert.equal(page.rows[0].cards.length, 0)
  } finally {
    muted.toggle(loud)
  }
  assert.deepEqual(ids((await loadFeed(mock.chain, filter)).rows.map((r) => r.lead)), [4, 2].sort((a, b) => b - a), 'unmuted, both replies return with their deleted context')
})

test('a feed opened for the first time brings the shared ledger up to its head before selecting', async () => {
  feedHistory([feedPost(1), feedPost(2)])
  assert.deepEqual(ids((await loadFeed(mock.chain, { kind: 'timeline' })).rows.map((r) => r.lead)), [2, 1])
  gateChanged(1n, TOMBSTONE, 5n) // deleted elsewhere while this tab looked at another view
  mock.calls = []
  const opened = await loadFeed(mock.chain, { kind: 'author', address: author }, { limit: 20, preserveVisibleRows: false })
  assert.deepEqual(ids(opened.rows.map((r) => r.lead)), [2], 'the deletion is known before the new view selects')
  assert.equal(mock.calls.filter((c) => c.method === 'feed').length, 1, 'the page carries current gate state')
  assert.equal(mock.calls.filter((c) => c.method === 'replyGate').length, 0)
})

for (const gate of [TOMBSTONE, REMOVED]) test(`a surviving descendant of ${gate} appears only when normal feed rules select it`, async () => {
  const followed = address('88')
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 2, followed), feedPost(4, 1, address('77'))])
  mock.gates.set(2n, gate)
  const everyone = await counted(loadFeed(mock.chain, { kind: 'timeline' }))
  assert.deepEqual(ids(everyone.rows.map((r) => r.lead)), [1])
  assert.equal(everyone.counts.get(1n), 1)
  const following = await loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: false, authors: [followed] })
  assert.deepEqual(ids(following.rows[0].cards.map((c) => c.post)), [3], 'the ended parent is supplied separately as the root placeholder')
  assert.equal(ledger.message(mock.chain, 2n), gate, 'the ended parent is known for moderation and its context label')
  assert.equal(following.rows[0].root.id, 2n, 'the surviving reply belongs to its immediate parent')
  assert.equal(following.rows[0].root.drawn, 1, 'the one live direct reply is counted')
  gateChanged(3n, REMOVED, 5n)
  const refreshed = await loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: false, authors: [followed] })
  assert.deepEqual(refreshed.rows, [], 'a removal received through changes drops the last survivor and its context')
})

/** A message outside the feed pages, returned by a host context read. */
const record = (id, who, parentId) => mock.messages.set(BigInt(id), { author: who, parentId: BigInt(parentId), timestamp: 0n, contentHash: hash('66') })

test('a stranger parent separates a followed reply from a followed ancestor', async () => {
  const followed = address('99'), stranger = address('88')
  // #1 the followed post; #2 a stranger's reply to it, which the feed does not select; #3 the followed author's reply to #2.
  feedHistory([feedPost(1, 0, followed), feedPost(2, 1, stranger), feedPost(3, 2, followed)])
  record(2, stranger, 1)
  const page = await loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: true, authors: [followed], viewer: author })
  assert.deepEqual(ids(page.rows.map((r) => r.lead)), [3, 1])
  assert.equal(page.rows[0].root.id, 2n, 'the reply belongs to its immediate parent')
  assert.equal(page.rows[0].root.omitted, false)
  assert.equal(page.rows[1].root.post?.id, 1n, 'the followed ancestor keeps its own row')
  assert.deepEqual(ids(page.rows[0].cards.map((c) => c.post)), [3], 'the immediate parent is supplied separately as the root card')
  assert.equal(page.rows[0].cards[0].gap, false, 'the row header names the immediate parent')
})

test('unselected ancestors do not bridge the immediate parent context', async () => {
  const followed = address('99'), a = address('88'), b = address('77')
  feedHistory([feedPost(1, 0, a), feedPost(2, 1, a), feedPost(3, 2, b), feedPost(4, 3, followed)])
  record(1, a, 0); record(2, a, 1); record(3, b, 2); record(4, followed, 3)
  const page = await loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: true, authors: [followed], viewer: author })
  assert.deepEqual(ids(page.rows.map((r) => r.lead)), [4])
  assert.equal(page.rows[0].root.id, 3n, 'only the immediate parent supplies the context card')
  assert.ok(!page.rows.find((r) => r.root?.id === 1n)?.root.post, 'a top-level post the feed does not select is not made context')
  assert.equal(page.rows[0].root.omitted, false)
  assert.deepEqual(ids(page.rows[0].cards.map((c) => c.post)), [4], 'only the selected reply is drawn')
})

test('a deleted unselected parent separates followed cards into their own rows', async () => {
  const followed = address('99'), stranger = address('88')
  feedHistory([feedPost(1, 0, followed), feedPost(2, 1, stranger), feedPost(3, 2, followed)])
  record(2, stranger, 1)
  mock.gates.set(2n, TOMBSTONE)
  const page = await loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: true, authors: [followed], viewer: author })
  assert.deepEqual(ids(page.rows.map((r) => r.lead)), [3, 1])
  assert.equal(page.rows[0].root.id, 2n)
  assert.equal(ledger.message(mock.chain, 2n), TOMBSTONE, 'the label can show that the missing parent was deleted')
  assert.deepEqual(ids(page.rows[0].cards.map((c) => c.post)), [3])
  assert.equal(page.rows[0].cards[0].gap, false, 'the row header names the immediate parent')
})

test('cold sibling context walks share one host ancestor request, while held parents need none', async () => {
  const followed = address('99'), stranger = address('88')
  const posts = [feedPost(1, 0, followed), feedPost(2, 1, stranger), feedPost(3, 2, stranger),
    feedPost(4, 3, followed), feedPost(5, 3, followed), feedPost(6, 3, followed), feedPost(7, 1, followed)]
  feedHistory(posts)
  for (const p of posts) record(p.id, p.author, p.parentId)
  const filter = { kind: 'following', includeRepliesToViewer: false, authors: [followed] }
  const page = await counted(loadFeed(mock.chain, filter))
  assert.equal(page.rows.length, 2, 'context never bridges its followed replies to the ancestor')
  assert.equal(page.rows[1].root.id, 3n)
  assert.equal(page.rows[0].root.id, 1n)
  assert.ok((ledger.message(mock.chain, 2n) !== undefined) && (ledger.message(mock.chain, 3n) !== undefined), 'both unselected replies are context')
  assert.deepEqual(mock.calls.filter((c) => c.method === 'message').map((c) => new URL(c.url, 'https://client.invalid').pathname), [`/api/chains/${mock.chain.id}/message/3`])
  assert.equal(mock.calls.filter((c) => c.method === 'getMessage').length, 0, 'the ancestor request warmed the record cache for counts too')
  mock.calls = []
  await counted(loadFeed(mock.chain, filter))
  assert.equal(mock.calls.filter((c) => c.method === 'message').length, 0, 'refresh uses the shared records')
})

test('host context keeps the five-hop limit without grouping through omitted ancestors', async () => {
  const followed = address('99'), stranger = address('88')
  const posts = Array.from({ length: 9 }, (_, i) => feedPost(i + 1, i, i === 8 ? followed : stranger))
  feedHistory(posts)
  for (const p of posts) record(p.id, p.author, p.parentId)
  const page = await counted(loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: false, authors: [followed] }))
  assert.equal(page.rows.length, 1)
  assert.equal(page.rows[0].root.id, 8n, 'the immediate parent supplies the label')
  assert.equal(page.rows[0].root.omitted, false)
  assert.deepEqual(mock.calls.filter((c) => c.method === 'message' && c.url.includes('ancestors=4')).map((c) => new URL(c.url, 'https://client.invalid').pathname), [`/api/chains/${mock.chain.id}/message/8`])
  assert.ok(!(ledger.message(mock.chain, 1n) !== undefined) && !(ledger.message(mock.chain, 2n) !== undefined), 'the walk never reaches the older ancestors')
})

test('a failed ancestor request keeps cached and independent context, and the next refresh retries it', async () => {
  const followed = address('99'), stranger = address('88')
  const posts = [feedPost(1, 0, stranger), feedPost(2, 1, stranger), feedPost(3, 2, stranger),
    feedPost(4, 3, stranger), feedPost(5, 4, followed), feedPost(6, 0, followed),
    feedPost(7, 6, stranger), feedPost(8, 7, followed)]
  feedHistory(posts)
  for (const p of posts) record(p.id, p.author, p.parentId)
  await getMessage(mock.chain, 4n)
  mock.failRead = (url) => url.includes('/message/3?') // the suffix after cached #4 fails
  mock.calls = []
  const filter = { kind: 'following', includeRepliesToViewer: false, authors: [followed] }
  const page = await counted(loadFeed(mock.chain, filter))
  assert.equal(page.rows.length, 3, 'a context failure never rejects the feed')
  assert.ok((ledger.message(mock.chain, 4n) !== undefined), 'the failed walk keeps what it already yielded')
  assert.ok((ledger.message(mock.chain, 7n) !== undefined), 'the independent walk still adds its context')
  assert.deepEqual(mock.calls.filter((c) => c.method === 'message' && c.url.includes('ancestors=')).map((c) => new URL(c.url, 'https://client.invalid').pathname.split('/').at(-1)).sort(), ['3', '7'])
  assert.ok(!mock.calls.some((c) => c.method === 'getMessage' && c.args[0] === 2n), 'no single-read fallback after the ancestor request fails')

  mock.failRead = null
  mock.calls = []
  const again = await counted(loadFeed(mock.chain, filter))
  assert.ok((ledger.message(mock.chain, 2n) !== undefined) && (ledger.message(mock.chain, 3n) !== undefined), 'the next refresh fills the missing context')
  assert.equal(mock.calls.filter((c) => c.method === 'message').length, 1, 'only the failed walk asks again')
  assert.deepEqual(again.rows.map((r) => Number(r.root.id)).sort(), [4, 6, 7])
})


test('stream state belongs to a Board deployment, not only its chain number', async () => {
  const filter = { kind: 'timeline' }
  feedHistory([feedPost(1)])
  const first = await loadFeed(mock.chain, filter)
  assert.deepEqual(ids(first.rows.map((r) => r.lead)), [1])
  mock.chain = { ...mock.chain, contract: address('99') }
  feedHistory([feedPost(2)])
  const second = await loadFeed(mock.chain, filter)
  assert.deepEqual(ids(second.rows.map((r) => r.lead)), [2], 'another Board never inherits the previous stream')
})


test('a quiet poll reads one page even after a large backlog accumulates', async () => {
  const filter = { kind: 'timeline' }
  feedHistory([feedPost(1)])
  await loadFeed(mock.chain, filter)
  feedHistory(Array.from({ length: 250 }, (_, i) => feedPost(i + 1)))
  for (let i = 0; i < 3; i++) {
    mock.calls.length = 0
    const n = await peekFeed(mock.chain, filter)
    assert.ok(n > 0)
    assert.ok(mock.calls.filter(c => c.method === 'changes').length <= 1)
  }
})


test('a listener keeps hearing after the refresh cue stops counting', async () => {
  const filter = { kind: 'timeline', viewer: author }
  feedHistory([feedPost(1)])
  await loadFeed(mock.chain, filter)
  feedHistory(Array.from({ length: 150 }, (_, i) => feedPost(i + 1)))
  let heard = 0
  const listener = { account: author, heard: () => { heard++ } }
  for (let i = 0; i < 4; i++) {
    mock.calls.length = 0
    await peekFeed(mock.chain, filter, listener)
    assert.equal(mock.calls.filter((c) => c.method === 'changes').length, 1, `poll ${i + 1} still reads its one page`)
  }
  assert.equal(heard, 4)
  // Past the limit the count keeps the rows it has: each poll's own work stays the same.
  const { QuietChanges } = await load('features/streams/quiet-changes.ts')
  const quiet = new QuietChanges()
  const base = { generation: hash('aa'), sequence: '0', checkpoint: { block: String(mock.head), hash: hash('77') } }
  const checked = []
  for (let i = 0; i < 6; i++) {
    let n = 0
    await quiet.peek(mock.chain, base, { feed: { any: [{ kind: 'posts' }] }, gates: false }, () => { n++; return true }, () => {})
    checked.push(n)
  }
  assert.deepEqual(checked.slice(3), [51, 51, 51])
  assert.equal(await peekFeed(mock.chain, filter, listener), Infinity, 'the cue itself still stops at fifty')
  mock.calls.length = 0
  await peekFeed(mock.chain, filter)
  await peekFeed(mock.chain, filter)
  assert.ok(mock.calls.filter((c) => c.method === 'changes').length <= 1, 'without a listener the scan stops as before')
})


test('unrelated activity does not cue refresh and later relevant posts are found incrementally', async () => {
  const followed = address('91'), stranger = address('92')
  const filter = { kind: 'following', includeRepliesToViewer: false, authors: [followed] }
  const first = feedPost(1, 0, followed)
  feedHistory([first])
  await loadFeed(mock.chain, filter)
  const unrelated = Array.from({ length: 150 }, (_, i) => feedPost(i + 2, 0, stranger))
  feedHistory([first, ...unrelated])
  for (let i = 0; i < 4; i++) {
    mock.calls.length = 0
    assert.equal(await peekFeed(mock.chain, filter), 0)
    assert.equal(mock.calls.filter(c => c.method === 'changes').length, 1)
  }
  feedHistory([first, ...unrelated, feedPost(152, 0, followed)])
  assert.equal(await peekFeed(mock.chain, filter), 1)
  assert.equal(await peekFeed(mock.chain, filter), 1, 'the same post is counted once')
  await loadFeed(mock.chain, filter)
  assert.equal(await peekFeed(mock.chain, filter), 0, 'explicit refresh starts a new scan')
})

test('a mention from an unlisted author reaches the notification dot but is not a new sponsored post', async () => {
  curate([])
  mock.blocked = false
  const filter = { kind: 'timeline', curatedOnly: true, viewer: author }, stranger = address('a4')
  feedHistory([feedPost(1)])
  await loadFeed(mock.chain, filter)
  feedHistory([feedPost(1), feedPost(2, 0, stranger)])
  mock.associations.set(2n, { account: author, reference: { kind: 'mention', account: author } })
  let heard = 0
  const listener = { account: author, heard: (answer) => { heard += answer.records.length } }
  assert.equal(await peekFeed(mock.chain, filter, listener), 0, 'the shared poll carried the mention only for the dot')
  assert.equal(heard, 1)
})

test('an author added to the sponsored list appears with their older posts after an explicit refresh', async () => {
  const listed = address('a3')
  curate([])
  mock.blocked = false
  const filter = { kind: 'timeline', curatedOnly: true }
  feedHistory([feedPost(1, 0, listed)])
  assert.deepEqual(ids((await loadFeed(mock.chain, filter)).rows.map((r) => r.lead)), [])
  curate([listed])
  assert.ok(await peekFeed(mock.chain, filter) > 0, 'a quiet poll only cues a refresh')
  assert.deepEqual(ids((await loadFeed(mock.chain, filter)).rows.map((r) => r.lead)), [1], 'the refresh reads the view afresh')
})

test('changing conversation scope keeps pending counts while replaying bounded pages', async () => {
  const { QuietChanges } = await load('features/streams/quiet-changes.ts')
  const { snapshots } = await load('lib/api.ts')
  feedHistory([feedPost(1)])
  const base = (await snapshots(mock.chain)).at
  const quiet = new QuietChanges(), scope = { feed: { any: [{ kind: 'posts' }] }, gates: false }
  feedHistory(Array.from({ length: 110 }, (_, i) => feedPost(i + 1)))
  const keep = r => r.id >= 100n
  let count = 0
  for (let i = 0; i < 4; i++) count = await quiet.peek(mock.chain, base, scope, keep)
  assert.equal(count, 11)
  mock.calls.length = 0
  assert.equal(await quiet.peek(mock.chain, base, { ...scope, parents: ['1'] }, keep), 11)
  assert.equal(mock.calls.filter(c => c.method === 'changes').length, 1)
  let seen = 0
  await assert.rejects(quiet.peek(mock.chain, base, { ...scope, parents: ['1'] }, () => {
    if (++seen === 2) throw Error('membership unavailable')
    return false
  }))
  assert.equal(await quiet.peek(mock.chain, base, { ...scope, parents: ['1'] }, keep), 11)
})

for (const reload of ['refresh', 'return home']) test(`notification discovery survives ${reload} without another poll`, async () => {
  const { NotificationDot } = await load('features/notifications/notification-dot.svelte.ts')
  const dot = new NotificationDot(), filter = { kind: 'timeline', viewer: author }
  feedHistory([feedPost(1)])
  await dot.check([mock.chain], author, undefined)
  await loadFeed(mock.chain, filter)
  const before = dot.listen(mock.chain, author)
  await peekFeed(mock.chain, filter, before)
  feedHistory([feedPost(1), feedPost(2, 1, address('77'))])
  await loadFeed(mock.chain, filter)
  const listener = reload === 'refresh' ? before : dot.listen(mock.chain, author)
  mock.calls.length = 0
  assert.equal(await peekFeed(mock.chain, filter, listener), 0, 'already displayed posts do not cue refresh')
  await new Promise(setImmediate)
  assert.equal(dot.shown(author), true)
  assert.equal(mock.calls.filter(c => c.method === 'changes').length, 1, 'the feed request also discovers the reply')
  assert.equal(mock.calls.filter(c => c.method === 'notifications').length, 1, 'one filtered confirmation of the cue')
  mock.calls.length = 0
  await peekFeed(mock.chain, filter, listener)
  await new Promise(setImmediate)
  assert.deepEqual(mock.calls.map(c => c.method), ['changes'], 'an idle tick performs no separate notification read')
})

test('a notification gap checks the head once without scanning history behind the feed', async () => {
  const { NotificationDot } = await load('features/notifications/notification-dot.svelte.ts')
  const dot = new NotificationDot(), filter = { kind: 'timeline', viewer: author }
  feedHistory([feedPost(1)])
  await dot.check([mock.chain], author, undefined)
  feedHistory(Array.from({ length: 250 }, (_, i) => feedPost(i + 1)))
  await loadFeed(mock.chain, filter)
  const listener = dot.listen(mock.chain, author)
  for (let i = 0; i < 5; i++) {
    mock.calls.length = 0
    assert.equal(await peekFeed(mock.chain, filter, listener), 0)
    assert.equal(mock.calls.filter(c => c.method === 'changes').length, 1)
    assert.equal(mock.calls.filter(c => c.method === 'notifications').length, i === 0 ? 1 : 0)
  }
})

for (const expired of [false, true]) test(`a ${expired ? 'retired' : 'lagging'} notification checkpoint never delays the home cue`, async () => {
  const { NotificationDot } = await load('features/notifications/notification-dot.svelte.ts')
  const { snapshots } = await load('lib/api.ts')
  const dot = new NotificationDot(), filter = { kind: 'timeline', viewer: author }
  feedHistory([feedPost(1)])
  await dot.check([mock.chain], author, undefined)
  const posts = [feedPost(1), feedPost(2, 1, address('77')), ...Array.from({ length: 298 }, (_, i) => feedPost(i + 3))]
  feedHistory(posts)
  await loadFeed(mock.chain, filter)
  const base = (await snapshots(mock.chain)).at
  const listener = dot.listen(mock.chain, author), fetch = globalThis.fetch, scans = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/changes')) {
      const request = JSON.parse(init.body)
      scans.push(request.after)
      if (expired && BigInt(request.after) < BigInt(base.sequence)) return response({ error: 'reset_required' }, 409)
    }
    return fetch(url, init)
  }
  try {
    for (let i = 1; i <= 3; i++) {
      posts.push(feedPost(300 + i)); feedHistory(posts)
      mock.calls.length = 0
      assert.equal(await peekFeed(mock.chain, filter, listener), i, 'the first poll finds the new post, without draining notification history')
      await new Promise(setImmediate)
      assert.equal(scans.length, i, 'one changes request per tick')
      assert.ok(BigInt(scans.at(-1)) >= BigInt(base.sequence), 'the dot cannot rewind the feed')
      assert.equal(mock.calls.filter(c => c.method === 'notifications').length, i === 1 ? 1 : 0)
      assert.equal(dot.shown(author), true, 'the head check finds the reply skipped by the feed reload')
    }
  } finally { globalThis.fetch = fetch }
})

test('a failed notification gap check retries without blocking the home cue', async () => {
  const { NotificationDot } = await load('features/notifications/notification-dot.svelte.ts')
  const dot = new NotificationDot(), filter = { kind: 'timeline', viewer: author }
  feedHistory([feedPost(1)])
  await dot.check([mock.chain], author, undefined)
  feedHistory([feedPost(1), feedPost(2, 1, address('77'))])
  await loadFeed(mock.chain, filter)
  const listener = dot.listen(mock.chain, author)
  feedHistory([feedPost(1), feedPost(2, 1, address('77')), feedPost(3)])
  mock.failRead = url => url.endsWith('/notifications')
  assert.equal(await peekFeed(mock.chain, filter, listener), 1)
  await new Promise(setImmediate)
  assert.equal(dot.shown(author), false)
  mock.failRead = null
  mock.calls.length = 0
  assert.equal(await peekFeed(mock.chain, filter, listener), 1)
  await new Promise(setImmediate)
  assert.equal(dot.shown(author), true)
  assert.deepEqual(mock.calls.map(c => c.method), ['changes', 'notifications'])
  mock.calls.length = 0
  assert.equal(await peekFeed(mock.chain, filter, listener), 1)
  await new Promise(setImmediate)
  assert.deepEqual(mock.calls.map(c => c.method), ['changes'])
})

test('a slow notification gap check is shared and never holds up feed polls', { timeout: 5000 }, async () => {
  const { NotificationDot } = await load('features/notifications/notification-dot.svelte.ts')
  const dot = new NotificationDot(), filter = { kind: 'timeline', viewer: author }
  feedHistory([feedPost(1)])
  await dot.check([mock.chain], author, undefined)
  const posts = [feedPost(1), feedPost(2, 1, address('77'))]
  feedHistory(posts)
  await loadFeed(mock.chain, filter)
  const listener = dot.listen(mock.chain, author), fetch = globalThis.fetch
  let release, started, checks = 0
  const pending = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { started = resolve })
  globalThis.fetch = async (url, init) => {
    const answer = await fetch(url, init)
    if (String(url).endsWith('/notifications') && ++checks === 1) {
      started()
      await pending
    }
    return answer
  }
  try {
    posts.push(feedPost(3)); feedHistory(posts)
    assert.equal(await peekFeed(mock.chain, filter, listener), 1)
    await ready
    posts.push(feedPost(4)); feedHistory(posts)
    assert.equal(await peekFeed(mock.chain, filter, listener), 2)
    assert.equal(checks, 1, 'a pending head check is shared across polls')
    release()
    await new Promise(setImmediate)
    assert.equal(dot.shown(author), true)
    assert.equal(await peekFeed(mock.chain, filter, listener), 2)
    await new Promise(setImmediate)
    assert.equal(checks, 2, 'a response behind the latest poll leaves its remaining gap to check')
    assert.equal(await peekFeed(mock.chain, filter, listener), 2)
    await new Promise(setImmediate)
    assert.equal(checks, 2, 'caught up polls do not check the head again')
  } finally { release(); globalThis.fetch = fetch }
})

const lead = (page) => ids(page.rows.map((r) => r.lead))
/** Answers covering one entry each, so a backlog needs more pages than a refresh may spend. */
function onePerPage() {
  const real = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const answer = await real(input, init)
    if (!String(input).endsWith('/changes')) return answer
    const body = JSON.parse(init.body), data = await answer.clone().json()
    if (!answer.ok) return answer
    const through = String(BigInt(body.after) + 1n)
    return response({ ...data, changes: data.changes.filter((c) => BigInt(c.sequence) <= BigInt(through)), through, more: BigInt(through) < BigInt(data.until.sequence) })
  }
  return () => { globalThis.fetch = real }
}

for (const loss of ['a rebuilt index', 'history the host no longer keeps', 'a backlog past the refresh budget']) test(`a refresh after ${loss} loads the feed afresh`, async () => {
  const filter = { kind: 'timeline' }
  const posts = [feedPost(1), feedPost(2)]
  feedHistory(posts)
  assert.deepEqual(lead(await loadFeed(mock.chain, filter)), [2, 1])
  for (let id = 3; id <= 230; id++) posts.push(feedPost(id))
  feedHistory(posts)
  let restore = () => {}
  if (loss === 'a rebuilt index') mock.generation = hash('bb')
  else if (loss === 'history the host no longer keeps') mock.firstRetained = 1000n
  else restore = onePerPage()
  try {
    const page = await loadFeed(mock.chain, filter)
    assert.deepEqual(lead(page).slice(0, 3), [230, 229, 228], 'the replacement shows the latest posts')
  } finally { restore() }
  mock.firstRetained = 0n
  feedHistory([...posts, feedPost(231)])
  mock.calls.length = 0
  assert.deepEqual(lead(await loadFeed(mock.chain, filter)).slice(0, 1), [231], 'and follows from there')
  assert.equal(mock.calls.filter((c) => c.method === 'changes').length, 1)
})

test('a failed replacement keeps the page shown, and the next refresh tries again', async () => {
  const filter = { kind: 'timeline' }
  feedHistory([feedPost(1), feedPost(2)])
  const shown = await loadFeed(mock.chain, filter)
  feedHistory([feedPost(1), feedPost(2), feedPost(3)])
  mock.generation = hash('bb')
  mock.failRead = (url) => url.endsWith('/feed')
  await assert.rejects(loadFeed(mock.chain, filter), /index unavailable/)
  assert.deepEqual(lead(shown), [2, 1], 'what was shown is untouched')
  mock.calls.length = 0
  await assert.rejects(loadFeed(mock.chain, filter), /index unavailable/)
  assert.equal(mock.calls.filter((c) => c.method === 'feed').length, 1, 'one fresh attempt per refresh')
  mock.failRead = null
  assert.deepEqual(lead(await loadFeed(mock.chain, filter)), [3, 2, 1])
})

test('loading older posts never jumps to the latest feed, and a quiet poll only cues refresh', async () => {
  const filter = { kind: 'timeline' }
  feedHistory(Array.from({ length: 30 }, (_, i) => feedPost(i + 1)))
  const first = await loadFeed(mock.chain, filter)
  assert.deepEqual(lead(first).slice(0, 1), [30])
  feedHistory(Array.from({ length: 31 }, (_, i) => feedPost(i + 1)))
  mock.generation = hash('bb')
  const { olderFeed } = await load('features/streams/feed.ts')
  await assert.rejects(olderFeed(mock.chain, filter), (e) => e.code === 'reset_required')
  assert.equal(await peekFeed(mock.chain, filter), Infinity, 'the quiet poll cues a refresh')
  assert.deepEqual(lead(await loadFeed(mock.chain, filter)).slice(0, 1), [31], 'the explicit refresh recovers')
})

test('a first load that meets a rebuild mid-read retries once from the host\'s head', async () => {
  const filter = { kind: 'timeline' }
  feedHistory([feedPost(1), feedPost(2)])
  await ledger.ensureMessage(mock.chain, 1n)
  const real = globalThis.fetch
  let rebuilt = false
  globalThis.fetch = async (input, init) => {
    const answer = await real(input, init)
    // The index is rebuilt just after the ledger caught up, before the feed's first page.
    if (!rebuilt && String(input).endsWith('/changes')) { rebuilt = true; mock.generation = hash('bb') }
    return answer
  }
  try {
    assert.deepEqual(lead(await loadFeed(mock.chain, filter)), [2, 1])
  } finally { globalThis.fetch = real }
  assert.equal(ledger.generation(mock.chain), hash('bb'))
})


test('returning to a stream keeps rows and the pending cue until explicit refresh', async () => {
  const filter = { kind: 'timeline' }
  feedHistory([feedPost(1)])
  await counted(loadFeed(mock.chain, filter))
  feedHistory([feedPost(1), feedPost(2)])
  assert.equal(await peekFeed(mock.chain, filter), 1)
  assert.equal(feedCue(mock.chain, filter), 1)
  mock.calls.length = 0
  const returned = await counted(resumeFeed(mock.chain, filter))
  assert.deepEqual(ids(returned.rows.map(r => r.lead)), [1])
  assert.equal(mock.calls.length, 0, 'returning makes no feed or changes read')
  assert.equal(feedCue(mock.chain, filter), 1, 'returning keeps the refresh pill')
  assert.deepEqual(ids((await counted(loadFeed(mock.chain, filter))).rows.map(r => r.lead)), [2, 1])
  assert.equal(feedCue(mock.chain, filter), 0)
})

test('restoring a paged stream keeps its limit; a new filter still reads current posts', async () => {
  const posts = Array.from({ length: 35 }, (_, i) => feedPost(i + 1))
  feedHistory(posts)
  const filter = { kind: 'timeline' }
  await counted(loadFeed(mock.chain, filter, { limit: 35 }))
  feedHistory([...posts, feedPost(36)])
  const returned = await counted(resumeFeed(mock.chain, filter, 35))
  assert.equal(returned.limit, 35)
  assert.equal(returned.rows.length, 35)
  assert.equal(returned.rows[0].lead.id, 35n)
  const first = await counted(resumeFeed(mock.chain, { kind: 'author', address: author }))
  assert.equal(first.rows[0].lead.id, 36n, 'no retained view means a real first load')
})

test('an expired snapshot keeps its refresh cue across a return and refresh recovers', async () => {
  const filter = { kind: 'timeline' }
  feedHistory([feedPost(1)])
  await counted(loadFeed(mock.chain, filter))
  mock.generation = hash('ab')
  feedHistory([feedPost(1), feedPost(2)])
  assert.equal(await peekFeed(mock.chain, filter), Infinity)
  assert.equal(feedCue(mock.chain, filter), Infinity)
  assert.deepEqual(ids((await counted(resumeFeed(mock.chain, filter))).rows.map(r => r.lead)), [1])
  assert.equal(feedCue(mock.chain, filter), Infinity)
  assert.deepEqual(ids((await counted(loadFeed(mock.chain, filter))).rows.map(r => r.lead)), [2, 1])
  assert.equal(feedCue(mock.chain, filter), 0)
})

test('an open stream branch resumes its existing replies without silently refreshing', async () => {
  const { readRoot, replySlice } = await load('features/streams/replies.ts')
  feedHistory([feedPost(1), feedPost(2, 1)])
  const first = await readRoot(mock.chain, 1n)
  assert.deepEqual(ids((await replySlice(mock.chain, first.replies, 1n, 20)).list), [2])
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 1)])
  mock.calls.length = 0
  const returned = await readRoot(mock.chain, 1n, true)
  assert.deepEqual(ids((await replySlice(mock.chain, returned.replies, 1n, 20)).list), [2])
  assert.equal(mock.calls.length, 0)
  const refreshed = await readRoot(mock.chain, 1n)
  assert.deepEqual(ids((await replySlice(mock.chain, refreshed.replies, 1n, 20)).list), [2, 3])
})


for (const completed of [0, 1]) test(`paging failure after ${completed} pages keeps previously displayed rows on return`, async () => {
  const { olderFeed } = await load('features/streams/feed.ts')
  feedHistory(Array.from({ length: 200 }, (_, i) => feedPost(i + 1)))
  const filter = { kind: 'timeline' }
  const first = await counted(loadFeed(mock.chain, filter, { limit: 35 }))
  const shown = ids(first.rows.map(row => row.lead))
  const real = globalThis.fetch
  let failed = 0
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/feed')) {
      if (failed++ === completed) return response(503, { error: 'busy' })
    }
    return real(input, init)
  }
  try {
    await assert.rejects(olderFeed(mock.chain, filter, 150))
    assert.equal(failed, completed + 1)
    mock.calls.length = 0
    const returned = await counted(resumeFeed(mock.chain, filter, 35))
    const restored = ids(returned.rows.map(row => row.lead))
    for (const id of shown) assert.ok(restored.includes(id), `previously shown row ${id} survives`)
    assert.equal(mock.calls.length, 0, 'resume does not need an available host')
  } finally { globalThis.fetch = real }
})

for (const direct of [false, true]) test(`following ${direct ? 'groups a direct reply with its parent' : 'separates context from an older selected ancestor'}`, async () => {
  const followed = address('99'), stranger = address('88')
  feedHistory([
    feedPost(345, 0, followed), feedPost(522, 0, followed),
    feedPost(529, 345, stranger, followed),
    feedPost(530, direct ? 345 : 529, followed, direct ? followed : stranger),
    feedPost(531, direct ? 345 : 529, followed, direct ? followed : stranger),
  ])
  const page = await counted(loadFeed(mock.chain, { kind: 'following', authors: [followed], includeRepliesToViewer: false }))
  assert.deepEqual(page.rows.map(r => Number(r.root.id)), direct ? [345, 522] : [529, 522, 345])
  assert.equal(page.rows[0].root.omitted, false)
  assert.deepEqual(ids(page.rows[0].cards.map(c => c.post)), [530, 531])
  assert.equal(page.rows[0].root.drawn, 2)
})

for (const includeRepliesToViewer of [false, true]) for (const nested of [false, true]) test(`${includeRepliesToViewer ? 'Following' : 'Keyring'} keeps an unfollowed ${nested ? 'reply' : 'post'} as immediate context while signed out`, async () => {
  const followed = address('99'), stranger = address('88')
  feedHistory([
    feedPost(1, 0, followed),
    feedPost(2, nested ? 1 : 0, stranger, nested ? followed : undefined),
    feedPost(3, 2, stranger, stranger),
    feedPost(4, 2, followed, stranger),
  ])
  const page = await counted(loadFeed(mock.chain, { kind: 'following', authors: [followed], includeRepliesToViewer }))
  const row = page.rows[0]
  assert.equal(row.root.id, 2n)
  assert.equal(row.root.omitted, false, 'the selected reply supplies its immediate parent context')
  assert.deepEqual(ids(row.cards.map(c => c.post)), [4], 'context does not bring in other replies')
  assert.deepEqual(page.rows.map(r => r.root.id), [2n, 1n], 'context does not pull a distant ancestor into the conversation')
  assert.equal(page.counts.get(2n), 2)
  assert.equal(row.root.drawn, 1, 'the unselected sibling remains behind the reply count')
})

test('profile replies retain older ancestors above the immediate parent', async () => {
  const stranger = address('44')
  feedHistory([feedPost(979, 0, stranger), feedPost(997, 979, author, stranger), feedPost(1000, 997, author, author)])
  const page = await counted(loadFeed(mock.chain, { kind: 'author-replies', address: author }))
  assert.equal(page.rows.length, 1, 'overlapping reply context forms one conversation')
  const row = page.rows.find(row => row.lead.id === 1000n)
  assert.equal(row.root.id, 979n)
  assert.deepEqual(ids(row.cards.map(card => card.post)), [997, 1000])
  assert.deepEqual(row.cards.map(card => card.gap), [false, false])
  assert.equal(row.root.drawn, 1)
  assert.equal(row.cards[0].drawn, 1)
})

test('profile reply context stops after five ancestors and keeps deleted context', async () => {
  const stranger = address('44')
  const records = Array.from({ length: 9 }, (_, i) => feedPost(i + 1, i, i === 8 ? author : stranger, stranger))
  feedHistory(records)
  mock.gates.set(6n, TOMBSTONE)
  const page = await counted(loadFeed(mock.chain, { kind: 'author-replies', address: author }))
  assert.equal(page.rows.length, 1)
  const row = page.rows[0]
  assert.equal(row.root.id, 4n)
  assert.deepEqual(ids(row.cards.map(card => card.post)), [5, 6, 7, 8, 9])
  assert.equal(ledger.message(mock.chain, 6n), TOMBSTONE)
  assert.equal(row.cards.find(card => card.post.id === 5n).drawn, 0, 'deleted context does not count as a live reply')
})


test('profile replies share sibling context without duplicating subjects or reader answers', async () => {
  const stranger = address('44'), reader = address('55')
  feedHistory([
    feedPost(949, 0, stranger), feedPost(951, 949, stranger), feedPost(953, 951),
    feedPost(954, 953, stranger), feedPost(956, 954), feedPost(958, 956, stranger),
    feedPost(959, 958), feedPost(962, 958, stranger), feedPost(970, 962), feedPost(974, 962),
    feedPost(978, 0, stranger), feedPost(981, 978), feedPost(982, 956, reader, author),
  ])
  const page = await counted(loadFeed(mock.chain, { kind: 'author-replies', address: author, viewer: reader }))
  assert.deepEqual(ids(page.rows.map(row => row.lead)), [981, 974], 'rank by the profile replies, not context or the reader’s answers')
  const shown = page.rows.flatMap(row => [row.root.id, ...row.cards.map(card => card.post.id)])
  assert.equal(new Set(shown).size, shown.length, 'every subject, context post and reader answer appears once')
  assert.deepEqual(shown.map(Number).sort((a, b) => a - b), [949, 951, 953, 954, 956, 958, 959, 962, 970, 974, 978, 981, 982])
  const conversation = page.rows[1]
  assert.equal(conversation.cards.find(card => card.post.id === 956n).drawn, 2)
  assert.deepEqual(ids(conversation.cards.map(card => card.post)), [951, 953, 954, 956, 958, 959, 962, 970, 974, 982])
})

for (const stream of ['everyone', 'curated', 'following', 'keyring']) test(`${stream} excludes indexed blocks without a local mute`, async () => {
  const blocked = address('88'), other = address('99')
  const { readerBlocklist } = await load('features/account/blocking.ts')
  const { muted } = await load('lib/muted.svelte.ts')
  assert.equal(muted.has(blocked), false)
  feedHistory([feedPost(1), ...Array.from({ length: 30 }, (_, i) => feedPost(i + 2, 0, blocked))])
  if (stream === 'curated') curate([author, blocked])
  const filter = stream === 'everyone' || stream === 'curated'
    ? { kind: 'timeline', viewer: author, curatedOnly: stream === 'curated' }
    : { kind: 'following', viewer: author, authors: [author, blocked], includeRepliesToViewer: stream === 'following' }
  const list = readerBlocklist(mock.chain, author)
  mock.membershipEvents.push({ kind: 'membership', list, member: blocked, present: true, position: { block: '40', log: 0 } })
  const leads = page => ids(page.rows.map(r => r.lead))
  assert.deepEqual(leads(await loadFeed(mock.chain, filter)), [1])
  assert.equal(mock.calls.filter(c => c.method === 'feed').length, 1, 'blocked posts do not use page slots')
  assert.ok(leads(await loadFeed(mock.chain, { ...filter, viewer: other })).includes(31), 'another viewer has a different list')
  assert.ok(leads(await loadFeed(mock.chain, { kind: 'author', address: blocked, viewer: author })).includes(31), 'a deliberately opened profile still reads its posts')
})

test('blocklist changes reset a retained home feed on refresh, including unblock', async () => {
  const blocked = address('88')
  const { readerBlocklist } = await load('features/account/blocking.ts')
  const filter = { kind: 'timeline', viewer: author }
  feedHistory([feedPost(1), feedPost(2, 0, blocked)])
  const leads = page => ids(page.rows.map(r => r.lead))
  assert.deepEqual(leads(await loadFeed(mock.chain, filter)), [2, 1])
  const list = readerBlocklist(mock.chain, author)
  mock.membershipEvents.push({ kind: 'membership', list, member: blocked, present: true, position: { block: '3', log: 0 } })
  assert.equal(await peekFeed(mock.chain, filter), Infinity, 'quiet reads request refresh after membership changes')
  assert.deepEqual(leads(await loadFeed(mock.chain, filter)), [1])
  mock.membershipEvents.push({ kind: 'membership', list, member: blocked, present: false, position: { block: '4', log: 0 } })
  assert.deepEqual(leads(await loadFeed(mock.chain, filter)), [2, 1])
})

for (const kind of ['author', 'author-replies']) test(`${kind} cues unseen reply counts without changing the retained profile`, async () => {
  const stranger = address('77')
  const filter = { kind, address: author }
  const posts = kind === 'author' ? [feedPost(1)] : [feedPost(1, 0, stranger), feedPost(2, 1)]
  const parent = posts.at(-1).id
  feedHistory(posts)
  const first = await counted(loadFeed(mock.chain, filter))
  assert.equal(first.counts.get(parent), 0)
  feedHistory([...posts, feedPost(3, parent, stranger)])
  assert.equal(await peekFeed(mock.chain, filter), Infinity, 'a reply outside the author filter still needs a refresh')
  assert.equal(await peekFeed(mock.chain, filter), Infinity, 'the cue survives a later empty poll')
  assert.equal(feedCue(mock.chain, filter), Infinity)
  const resumed = await counted(resumeFeed(mock.chain, filter))
  assert.equal(resumed.counts.get(parent), 0, 'Back preserves the snapshot until refresh')
  const fresh = await counted(loadFeed(mock.chain, filter))
  assert.equal(fresh.counts.get(parent), 1, 'ordinary refresh updates the count')
  assert.equal(await peekFeed(mock.chain, filter), 0)
  assert.equal(feedCue(mock.chain, filter), 0)
  assert.equal(first.counts.get(parent), 0, 'the old page was not mutated')
})


test('profile reply counts cue deletions but not unrelated or unchanged records', async () => {
  const stranger = address('77'), filter = { kind: 'author', address: author }
  const posts = [feedPost(1), feedPost(2, 1, stranger)]
  feedHistory(posts)
  const first = await counted(loadFeed(mock.chain, filter))
  assert.equal(first.counts.get(1n), 1)
  assert.equal(await peekFeed(mock.chain, filter), 0)
  feedHistory([...posts, feedPost(3, 0, stranger), feedPost(4, 3, stranger)])
  assert.equal(await peekFeed(mock.chain, filter), 0, 'another conversation does not change this profile')
  gateChanged(2n, TOMBSTONE, 5n)
  assert.equal(await peekFeed(mock.chain, filter), Infinity)
  assert.equal(first.counts.get(1n), 1)
  const refreshed = await counted(loadFeed(mock.chain, filter))
  assert.equal(refreshed.counts.get(1n), 0)
  assert.equal(await peekFeed(mock.chain, filter), 0)
})

test('profile replies cue changed counts on displayed context outside the author filter', async () => {
  const stranger = address('77'), filter = { kind: 'author-replies', address: author }
  const posts = [feedPost(1, 0, stranger), feedPost(2, 1)]
  feedHistory(posts)
  const first = await counted(loadFeed(mock.chain, filter))
  assert.equal(first.rows[0].root.id, 1n)
  assert.equal(first.counts.get(1n), 1)
  feedHistory([...posts, feedPost(3, 1, stranger)])
  assert.equal(await peekFeed(mock.chain, filter), Infinity)
  assert.equal(first.counts.get(1n), 1)
  const refreshed = await counted(loadFeed(mock.chain, filter))
  assert.equal(refreshed.counts.get(1n), 2)
  assert.equal(await peekFeed(mock.chain, filter), 0)
})


test('a late profile count check cannot cue a snapshot already refreshed', async () => {
  const filter = { kind: 'author', address: author }
  feedHistory([feedPost(1)])
  await counted(loadFeed(mock.chain, filter))
  feedHistory([feedPost(1), feedPost(2, 1, address('77'))])
  const fetch = globalThis.fetch, started = deferred(), release = deferred()
  let delayed = false
  globalThis.fetch = async (url, init) => {
    const answer = await fetch(url, init)
    if (String(url).endsWith('/changes') && !delayed) {
      delayed = true
      started.resolve()
      await release.promise
    }
    return answer
  }
  const old = peekFeed(mock.chain, filter)
  try {
    await started.promise
    feedHistory([feedPost(1), feedPost(2, 1, address('77')), feedPost(3, 1, address('77'))])
    assert.equal((await counted(loadFeed(mock.chain, filter))).counts.get(1n), 2)
    assert.equal(await peekFeed(mock.chain, filter), 0)
    release.resolve()
    await old
    assert.equal(feedCue(mock.chain, filter), 0)
    assert.equal(await peekFeed(mock.chain, filter), 0)
  } finally { release.resolve(); await old; globalThis.fetch = fetch }
})

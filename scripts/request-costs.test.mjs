// Application-reader call budgets, not timing benchmarks. Count every host
// request, including any unexpected per-card state, body or history reads.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { zeroAddress } from 'viem'
import { load, mock, install, teardown, address, feedPost, feedHistory, counted, gateChanged,
  makePost, sign, txHash, posted } from './host-harness.mjs'
const { loadFeed, olderFeed, peekFeed } = await load('features/streams/feed.ts')
const { readThread, replySlice } = await load('features/streams/replies.ts')
const { gates } = await load('lib/gates.svelte.ts')
const { getMessage } = await load('lib/messages.ts')
const { recoverPost } = await load('features/publishing/recovery.ts')
const { savePending, listPending } = await load('features/publishing/pending.ts')
const { TOMBSTONE } = await load('lib/board.ts')
const { bodyRecord } = await load('features/publishing/posting.ts')
const { loadBody } = await load('lib/content.ts')
const sessions = new Map()
beforeEach(() => { sessions.clear(); install() })
after(teardown)

async function budget(expected, work) {
  mock.calls = []
  const result = await work()
  const counts = {}
  for (const call of mock.calls) counts[call.method] = (counts[call.method] ?? 0) + 1
  assert.deepEqual(counts, expected)
  return result
}
async function cardReads(posts) {
  await Promise.all(posts.map(async (p) => {
    await getMessage(mock.chain, p.id)
    if (await gates.ensureMessage(mock.chain, p.id) === zeroAddress) await gates.ensureAuthor(mock.chain, p.author)
  }))
}
async function feedCards(pending) {
  const page = await counted(pending)
  await cardReads(page.rows.slice(0, page.limit).map((r) => r.lead))
  assert.equal(page.counts.size, page.rows.slice(0, page.limit).length)
  return page
}

for (const [historySize, retained] of [[100, 20], [2000, 200]]) {
  test(`feed request budget: ${historySize} posts, ${retained} retained rows`, async () => {
    const history = Array.from({ length: historySize }, (_, i) => feedPost(i + 1, 0, address((32 + i % 20).toString(16))))
    feedHistory(history)
    const filter = { kind: 'timeline' }
    let page = await budget({ feed: 1 }, () => feedCards(loadFeed(mock.chain, filter)))
    assert.equal(page.rows.length, 20)
    assert.equal(mock.calls[0].limit, 20)
    if (retained > 20) {
      page = await budget({ feed: 4 }, () => feedCards(olderFeed(mock.chain, filter, retained)))
      assert.deepEqual(mock.calls.map((c) => c.limit), [50, 50, 50, 30])
    }
    assert.equal(page.rows.length, retained)
    page = await budget({ changes: 1 }, () => feedCards(loadFeed(mock.chain, filter, { limit: retained })))
    const before = page.rows.map((r) => r.key)
    feedHistory([...history, feedPost(historySize + 1)])
    assert.equal(await budget({ changes: 1 }, () => peekFeed(mock.chain, filter)), 1)
    assert.deepEqual(page.rows.map((r) => r.key), before, 'poll only cues')
    page = await budget({ changes: 1 }, () => feedCards(loadFeed(mock.chain, filter, { limit: retained })))
    assert.equal(page.rows.length, retained + 1)
    assert.equal(page.rows[0].lead.id, BigInt(historySize + 1))
    gateChanged(BigInt(historySize), TOMBSTONE, BigInt(historySize + 2))
    page = await budget({ changes: 1 }, () => feedCards(loadFeed(mock.chain, filter, { limit: retained })))
    assert.ok(!page.rows.some((r) => r.lead.id === BigInt(historySize)))
    const heldRows = page.rows.length, oldLogs = mock.logs
    feedHistory(Array.from({ length: 51 }, (_, i) => feedPost(historySize + 3 + i)))
    mock.logs = [...oldLogs, ...mock.logs]
    page = await budget({ changes: 2 }, () => feedCards(loadFeed(mock.chain, filter, { limit: page.limit })))
    assert.equal(page.rows.length, heldRows + 51, 'a two-page update adds all new rows')
  })
}

for (const children of [100, 2000]) {
  test(`thread request budget: ${children} direct replies`, async () => {
    feedHistory([feedPost(1), feedPost(2, 1), ...Array.from({ length: children }, (_, i) => feedPost(i + 3, 2))])
    const root = await budget({ message: 1 }, () => readThread(sessions, mock.chain, 2n))
    assert.equal(root.parent.id, 1n)
    assert.equal(new URL(mock.calls[0].url, 'https://client.invalid').searchParams.get('ancestors'), '1')
    let slice = await budget({ replies: 1 }, async () => {
      const result = await replySlice(mock.chain, root.replies, 2n, 20)
      await cardReads([root.record, root.parent, ...result.list])
      return result
    })
    assert.equal(slice.total, children)
    assert.equal(slice.list.length, 20)
    const last = BigInt(children + 2)
    slice = await budget({ message: 1 }, () => replySlice(mock.chain, root.replies, 2n, 20, last))
    assert.equal(slice.list.at(-1).id, last)
    assert.equal(slice.list.length, 21, 'reveal does not fill the gap')
    // A refresh answers the root and its parent from the changes it read.
    const refreshed = await budget({ changes: 1 }, () => readThread(sessions, mock.chain, 2n))
    await budget({}, async () => {
      const same = await replySlice(mock.chain, refreshed.replies, 2n, 20)
      assert.deepEqual(same.list.map((r) => r.id), slice.list.map((r) => r.id))
      await cardReads([refreshed.record, refreshed.parent, ...same.list])
    })
    const more = await budget({ replies: 1 }, () => replySlice(mock.chain, refreshed.replies, 2n, 40))
    assert.equal(mock.calls[0].cursor.after, '22')
    assert.equal(more.loaded, 40)
    assert.equal(more.list.at(-1).id, last)
  })
}

test('one known pending hash costs one receipt read and one journal lookup, regardless of chain age', async () => {
  const post = makePost(true); sign(post); post.txHash = txHash
  await savePending(post)
  mock.receiptMissing = true; mock.relayStatus = 200
  for (const head of [100n, 20_000_000n]) {
    mock.head = head
    await budget({ transaction: 1, relay: 1, upload: 2 }, () => recoverPost(mock.chain, post))
    assert.equal((await listPending())[0].records.length, 2, 'held bytes remain retryable')
  }
  mock.receiptMissing = false
  mock.logs = [posted(post)]
  // Simulate promotion while waiting for the receipt. Both verified content
  // probes succeed, so the confirmed pass must not upload either record again.
  for (const record of post.records) mock.bodies.set(record.hash, record.bytes)
  // Receipt identity is checked against the accepted index: one checkpoint
  // snapshot and one pinned record read are required even on the fast path.
  const result = await budget({ transaction: 1, state: 1, message: 1, content: 2 }, () => recoverPost(mock.chain, post))
  assert.equal(result.done, true)
  assert.deepEqual(await listPending(), [])
})

test('a hundred cards sharing one body make one download; a miss retries once and a verified body stays cached', async () => {
  const body = bodyRecord(`request-cost fixture ${mock.chain.id}`)
  const cards = () => Promise.all(Array.from({ length: 100 }, (_, i) =>
    loadBody(body.hash, { chainId: mock.chain.id, messageId: BigInt(i + 1) })))
  const missing = await budget({ content: 1 }, cards)
  assert.ok(missing.every((b) => b.kind === 'missing'))
  mock.bodies.set(body.hash, body.bytes)
  const loaded = await budget({ content: 1 }, cards)
  assert.ok(loaded.every((b) => b.kind === 'text' && b === loaded[0]))
  const refreshed = await budget({}, cards)
  assert.ok(refreshed.every((b) => b === loaded[0]))
})

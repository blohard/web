// Recovery scans and relayer retries have independent evidence and stopping rules.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, makePost, sign, posted, replyArgs, txHash, address } from '../../../../scripts/host-harness.mjs'
const { RelayUnknown } = await load('features/publishing/relay.ts')

const { recoverPost, resolvePendingId } = await load('features/publishing/recovery.ts')
const { publishPost } = await load('features/publishing/posting.ts')
const { savePending, listPending } = await load('features/publishing/pending.ts')
const { Reverted } = await load('lib/transactions.ts')
beforeEach(install)
after(teardown)
const lookups = () => mock.calls.filter((c) => c.method === 'lookup')
const relays = () => mock.calls.filter((c) => c.method === 'relay').length

test('an old unsigned post survives incomplete lookup pages and uploads when a later page finds it', async () => {
  const post = makePost(); post.createdAt -= 61 * 60_000
  await savePending(post)
  const fetch = globalThis.fetch
  let first = true
  globalThis.fetch = async (url, init) => {
    const res = await fetch(url, init)
    if (!String(url).endsWith('/lookup') || !first) return res
    first = false
    const answer = await res.json()
    answer.next = { generation: answer.at.generation, filter: `0x${'bb'.repeat(32)}`, ceiling: '100', before: '50' }
    return new Response(JSON.stringify(answer))
  }
  assert.equal((await recoverPost(mock.chain, post)).done, undefined)
  const [saved] = await listPending()
  assert.ok(saved.lookup.cursor)
  mock.logs = [posted(post)]
  assert.equal((await recoverPost(mock.chain, saved)).done, true)
  assert.equal(saved.messageId, 7n)
  assert.deepEqual(await listPending(), [])
})

test('the pre-signing head is saved and becomes the first recovery bound, independently of the clock', async () => {
  mock.head = 5000n
  const args = { ...replyArgs(), parentId: 0n }
  args.pending.createdAt += 24 * 60 * 60_000
  args.wallet.provider.request = async ({ method }) => {
    if (method === 'eth_accounts') return [args.wallet.account]
    const [saved] = await listPending()
    assert.equal(saved.fromBlock, 5000n)
    assert.equal(saved.contract, mock.chain.contract)
    return '0x1234'
  }
  await assert.rejects(publishPost(args), RelayUnknown)
  mock.head = 5010n
  await resolvePendingId(mock.chain, args.pending)
  assert.deepEqual(lookups().map((c) => c.from_block), ['5000'])
})

test('a completed accepted range advances once; a failed lookup preserves its bound', async () => {
  mock.head = 5100n
  const post = makePost(); post.fromBlock = 5000n
  await savePending(post)
  assert.equal(await resolvePendingId(mock.chain, post), null)
  assert.equal(post.fromBlock, 5101n)
  assert.equal((await listPending())[0].fromBlock, 5101n)
  mock.head = 5200n; mock.lookupError = true
  await assert.rejects(resolvePendingId(mock.chain, post))
  assert.equal(post.fromBlock, 5101n)
  mock.lookupError = false
  mock.logs = [posted(post)]
  assert.equal(await resolvePendingId(mock.chain, post), 7n)
  assert.deepEqual(lookups().map((c) => c.from_block), ['5000', '5101', '5101'])
})

test('an unavailable host snapshot stops a new send before the wallet is asked', async () => {
  mock.hostStatus = 503
  const args = { ...replyArgs(), parentId: 0n }
  await assert.rejects(publishPost(args), /host unavailable/)
  assert.equal(relays(), 0)
  assert.equal(mock.calls.some((c) => c.method === 'eth_signTypedData_v4'), false)
  assert.deepEqual(await listPending(), [])
})

test('recovery cannot apply a saved cursor or signature to another Board', async () => {
  const post = makePost(); sign(post); post.contract = address('88'); post.fromBlock = 5000n
  await assert.rejects(recoverPost(mock.chain, post), /another chain or Board/)
  assert.equal(mock.calls.length, 0)
})

test('a failed chain scan does not prevent recovery of the hash from the relayer', async () => {
  const post = makePost(); sign(post); post.fromBlock = 0n
  mock.lookupError = true; mock.relayStatus = 200
  await recoverPost(mock.chain, post)
  assert.equal(post.fromBlock, 0n)
  assert.equal(post.txHash, txHash)
  assert.equal(relays(), 1)
})

test('an unsigned recovery record without a captured bound starts at deployment', async () => {
  mock.chain.start_block = 100; mock.head = 200n
  const post = makePost()
  await resolvePendingId(mock.chain, post)
  assert.deepEqual(lookups().map((c) => c.from_block), ['100'])
  assert.equal(post.fromBlock, 201n)
})

test('a known hash uses only its receipt, retaining missing or failed reads', async () => {
  const post = makePost(); post.txHash = txHash
  await savePending(post)
  mock.receiptMissing = true
  assert.equal(await resolvePendingId(mock.chain, post), null)
  mock.receiptMissing = false; mock.receiptError = true
  await assert.rejects(resolvePendingId(mock.chain, post))
  mock.receiptError = false; mock.receiptLogs = mock.logs = [posted(post)]
  assert.equal(await resolvePendingId(mock.chain, post), 7n)
  assert.deepEqual(lookups(), [])
  assert.equal(relays(), 0)
  assert.equal(mock.calls.some((c) => c.method === 'eth_blockNumber'), false)
})

test('a receipt must confirm the canonical Board, author and body; a revert is definitive', async () => {
  const post = makePost(); post.txHash = txHash
  for (const log of [
    { ...posted(post), address: address('88') },
    posted({ bodyHash: `0x${'aa'.repeat(32)}` }),
    { ...posted(post), topics: [posted(post).topics[0], `0x${'00'.repeat(12)}${'88'.repeat(20)}`, ...posted(post).topics.slice(2)] },
  ]) {
    mock.receiptLogs = [log]
    await assert.rejects(resolvePendingId(mock.chain, post), /confirm this post/)
    assert.equal(post.messageId, null)
  }
  mock.receiptStatus = '0x0'
  await assert.rejects(resolvePendingId(mock.chain, post), Reverted)
  assert.deepEqual(lookups(), [])
})

// A 429 with Retry-After is the relayer pacing this network; without it, a spent daily quota.
for (const [status, outcome, paused, retryAfter = null] of [[403, 'refused', true], [409, 'refused', true], [429, 'refused', false, 2], [429, 'refused', false, 0], [429, 'refused', true], [503, 'refused', false], [403, 'unknown', false], [503, null, false]]) {
  test(`recovery ${status}/${outcome}${retryAfter === null ? '' : ' with Retry-After'} ${paused ? 'pauses' : 'keeps'} resubmission without stopping chain checks`, async () => {
    const post = makePost(); sign(post)
    await savePending(post)
    mock.relayStatus = status; mock.relayOutcome = outcome; mock.relayRetryAfter = retryAfter
    await recoverPost(mock.chain, post)
    const [saved] = await listPending()
    assert.equal(!!saved.relayPaused, paused)
    await recoverPost(mock.chain, saved)
    assert.equal(relays(), paused ? 1 : 2)
    assert.equal(lookups().length, 2)
    mock.head++
    mock.logs = [posted(post)]
    assert.equal((await recoverPost(mock.chain, saved)).done, true)
    assert.equal(relays(), paused ? 1 : 2)
  })
}

test('manual recovery asks the journal even after a paused signature expires', async () => {
  const post = makePost(); sign(post); post.relayPaused = true
  mock.relayStatus = 429; mock.relayRetryAfter = 2
  await recoverPost(mock.chain, post, true)
  assert.equal(relays(), 1)
  assert.equal(post.relayPaused, false)
  sign(post, Date.now() - 1000)
  await recoverPost(mock.chain, post, true)
  assert.equal(relays(), 2)
  assert.equal(lookups().length, 2)
})

test('a dropped relayer hash is replaced using the same signature and saved before uploading', async () => {
  const post = makePost(true); sign(post); post.txHash = txHash
  await savePending(post)
  mock.transactions.set(txHash, { status: 'pending' })
  const replacement = `0x${'ab'.repeat(32)}`
  mock.relayStatus = 200; mock.relayHash = replacement
  await recoverPost(mock.chain, post)
  assert.equal(post.txHash, replacement)
  assert.equal((await listPending())[0].txHash, replacement)
  assert.deepEqual(mock.calls.find((c) => c.method === 'relay').signed, post.signed)
  assert.ok(mock.calls.filter((c) => c.method === 'upload').every((c) => c.url.includes(replacement)))
  mock.logs = [{ ...posted(post), transactionHash: replacement }]
  assert.equal((await recoverPost(mock.chain, post)).done, true)
  assert.equal(relays(), 1, 'a matching receipt finishes without another journal query')
  assert.deepEqual(await listPending(), [])
})

for (const known of [false, true]) test(`an expired signature can recover a journal hash, known=${known}`, async () => {
  const post = makePost(); sign(post, Date.now() - 1000); post.txHash = known ? txHash : null
  await savePending(post)
  mock.receiptMissing = true; mock.relayStatus = 200
  await recoverPost(mock.chain, post)
  assert.equal(relays(), 1)
  assert.equal(post.txHash, txHash)
  mock.receiptMissing = false; mock.logs = [posted(post)]
  assert.equal((await recoverPost(mock.chain, post)).done, true)
})

test('a refused or unknown journal recheck keeps the old hash and continues receipt recovery', async () => {
  const post = makePost(); sign(post, Date.now() - 1000); post.txHash = txHash
  await savePending(post); mock.receiptMissing = true
  mock.relayStatus = 504
  await recoverPost(mock.chain, post)
  assert.equal(post.txHash, txHash)
  assert.notEqual(post.relayPaused, true)
  mock.relayStatus = 403
  await recoverPost(mock.chain, post)
  assert.equal(post.txHash, txHash)
  assert.equal(post.relayPaused, true)
  await recoverPost(mock.chain, post)
  assert.equal(relays(), 2, 'a definite refusal pauses further automatic journal checks')
  mock.receiptMissing = false; mock.logs = [posted(post)]
  assert.equal((await recoverPost(mock.chain, post)).done, true)
})

test('an old wallet hash finds a mined speed-up and saves its identity before uploading', async () => {
  const post = makePost(true); post.txHash = txHash; post.walletSubmitted = true
  post.createdAt -= 120_000; post.fromBlock = 400n; mock.head = 410n
  await savePending(post)
  const replacement = `0x${'ab'.repeat(32)}`
  mock.transactions.set(txHash, { status: 'pending' })
  mock.logs = [{ ...posted(post), transactionHash: replacement }]
  const fetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('/api/publish?')) {
      const [saved] = await listPending()
      assert.equal(saved.messageId, 7n)
      assert.equal(saved.txHash, replacement)
      assert.ok(String(url).includes('message_id=7'))
      assert.ok(!String(url).includes('tx_hash='))
    }
    return fetch(url, init)
  }
  assert.equal((await recoverPost(mock.chain, post)).done, true)
  assert.equal(post.txHash, replacement)
  assert.equal(post.messageId, 7n)
  assert.deepEqual(lookups().map((c) => c.from_block), ['400'])
  assert.equal(relays(), 0, 'wallet recovery never asks the relayer or sends another transaction')
  assert.deepEqual(await listPending(), [])
})

test('wallet replacement lookup starts after two minutes and retains a failed search bound', async (t) => {
  const now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const post = makePost(); post.txHash = txHash; post.walletSubmitted = true; post.fromBlock = 500n
  post.createdAt = now - 119_999
  mock.head = 510n; mock.receiptMissing = true
  await savePending(post)
  assert.equal(await resolvePendingId(mock.chain, post), null)
  assert.equal(lookups().length, 0, 'fresh hashes take only the receipt path')
  post.createdAt--
  await savePending(post)
  mock.lookupError = true
  await assert.rejects(resolvePendingId(mock.chain, post), /lookup unavailable/)
  assert.equal(post.fromBlock, 500n)
  assert.equal(post.txHash, txHash)
  mock.lookupError = false
  assert.equal(await resolvePendingId(mock.chain, post), null)
  assert.equal(post.fromBlock, 511n)
  assert.equal(post.txHash, txHash, 'an empty search is not evidence of cancellation')
  mock.head = 520n
  mock.logs = [{ ...posted(post), transactionHash: `0x${'cd'.repeat(32)}` }]
  const [saved] = await listPending()
  assert.equal(await resolvePendingId(mock.chain, saved), 7n)
  assert.deepEqual(lookups().map((c) => c.from_block), ['500', '500', '511'])
})

test('old successful or reverted wallet receipts and signed posts do not search for replacements', async () => {
  const post = makePost(); post.txHash = txHash; post.createdAt -= 120_000
  mock.receiptLogs = mock.logs = [posted(post)]
  assert.equal(await resolvePendingId(mock.chain, post), 7n)
  post.messageId = null
  mock.receiptStatus = '0x0'
  await assert.rejects(resolvePendingId(mock.chain, post), Reverted)
  mock.receiptMissing = true
  sign(post)
  assert.equal(await resolvePendingId(mock.chain, post), null)
  assert.deepEqual(lookups(), [], 'signed attempts continue to recover through their journal')
})

test('a saved lookup position from before the index was rebuilt is dropped, and the range scanned again', async () => {
  const { response, hash } = await import('../../../../scripts/host-harness.mjs')
  const post = makePost(); post.createdAt -= 61 * 60_000
  await savePending(post)
  const fetch = globalThis.fetch
  let page = 0
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith('/lookup')) return fetch(url, init)
    const ask = JSON.parse(init.body)
    if (ask.cursor && ask.cursor.generation !== mock.generation) return response({ error: 'reset_required' }, 409)
    const answer = await (await fetch(url, init)).json()
    if (page++ === 0) answer.next = { generation: answer.at.generation, filter: hash('bb'), ceiling: '100', before: '50' }
    return new Response(JSON.stringify(answer))
  }
  try {
    await recoverPost(mock.chain, post)
    assert.ok(post.lookup?.cursor, 'an incomplete scan saved its position')
    mock.generation = hash('cc')
    mock.logs = [posted(post)]
    // The page's next refresh adopts the rebuilt index through its head read.
    const { gates } = await load('lib/gates.svelte.ts')
    await gates.advanceToHead(mock.chain)
    await recoverPost(mock.chain, post)
    const [saved] = await listPending()
    assert.notEqual(saved?.messageId ?? post.messageId, null, 'the rebuilt index finds the post')
  } finally { globalThis.fetch = fetch }
})

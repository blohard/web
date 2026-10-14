// Application transaction reads use the host; the wallet only signs/submits.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { decodeFunctionData, encodeErrorResult, zeroAddress } from 'viem'
import { load, mock, install, teardown, address, hash, response, makePost } from './harness.mjs'
const { RelayUnknown } = await load('features/publishing/relay.ts')

const api = await load('lib/api.ts')
const board = await load('lib/board.ts')
const { explain } = await load('lib/errors.ts')
const { pendingInterval } = await load('lib/pending-interval.ts')
const tx = await load('lib/transactions.ts')
const pending = await load('features/publishing/pending.ts')
const { publishPost } = await load('features/publishing/posting.ts')
const { resolvePendingId } = await load('features/publishing/recovery.ts')
const { boardAbi } = await load('lib/abi/board.ts')
let calls, send, at, message, receipt, provider, walletCalls, post

beforeEach(() => {
  install()
  post = makePost()
  post.parentId = 0n
  calls = []; walletCalls = []
  at = { generation: hash('ab'), sequence: '10', checkpoint: { block: '100', hash: hash('cc') } }
  message = {
    id: '1', author: post.author, parent: '0', parent_author: zeroAddress, timestamp: 1700000000,
    content_hash: post.bodyHash, transaction: hash('dd'), position: { block: '1', log: 0 },
    gate: zeroAddress, author_gate: zeroAddress, effective_gate: zeroAddress, replies: '0',
  }
  message.commitment = api.commitment({ author: message.author, parentId: 0n, timestamp: message.timestamp, contentHash: message.content_hash })
  receipt = { hash: hash('dd'), status: 'success', block: '1', block_hash: hash('cc'), events: [{ kind: 'posted', message }] }
  send = async (url, init) => {
    if (url.includes('/transaction/')) return response(receipt)
    if (url.endsWith('/admission')) return response({ gate: address('55') })
    if (url.endsWith('/post-estimate')) return response({ gas: '125000' })
    if (url.endsWith('/state')) {
      const ask = JSON.parse(init.body)
      return response({ at, items: (ask.ids ?? []).map(() => message), accounts: [], memberships: [] })
    }
    if (url.includes('/message/')) return response({ at, message, ancestors: [] })
    if (url.endsWith('/lookup')) return response({ at, items: [], next: null })
    if (url.includes('/api/publish?')) return response({ hash: post.bodyHash, held: url.includes('tx_hash=') }, url.includes('tx_hash=') ? 202 : 200)
    if (url.includes('/api/relay/')) return response({ tx_hash: hash('dd') })
    throw new Error(`unexpected request ${url}`)
  }
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null })
    return send(String(url), init)
  }
  provider = { request: async (ask) => {
    walletCalls.push(ask)
    if (ask.method === 'eth_chainId') return `0x${mock.chain.id.toString(16)}`
    if (ask.method === 'eth_accounts') return [post.author]
    if (ask.method === 'eth_sendTransaction') return hash('dd')
    if (ask.method === 'eth_signTypedData_v4') return '0x1234'
    throw new Error(`unexpected wallet read ${ask.method}`)
  } }
})
after(teardown)
const expected = () => ({ author: post.author, contentHash: post.bodyHash, parentId: post.parentId })
const wallet = () => ({ provider, account: post.author, chainId: mock.chain.id, ensureChain: async () => {} })
const publish = (sponsored) => publishPost({ chain: mock.chain, wallet: wallet(), parentId: post.parentId, pending: post, sponsored, onNote() {}, onWarn() {} })

test('reply admission sends a domain question and preserves a decoded Board refusal', async () => {
  assert.equal(await board.checkReply(mock.chain, 3n, post.author), address('55'))
  assert.deepEqual(calls[0].body, { parent: '3', replier: post.author })
  send = async () => response({ error: 'simulation_refused', revert: encodeErrorResult({ abi: boardAbi, errorName: 'GateRejected', args: [address('55')] }) }, 422)
  await assert.rejects(board.checkReply(mock.chain, 3n, post.author), (e) => { assert.equal(explain(e), "the parent's reply rule refused your reply", `revert=${e.revert}`); return true })
  assert.equal(walletCalls.length, 0)
})

for (const sponsored of [false, true]) test(`${sponsored ? 'sponsored' : 'paid'} publication uses host reads, captures its bound before signing and verifies the indexed result`, async () => {
  const request = provider.request
  provider.request = async (ask) => {
    const saved = (await pending.listPending())[0]
    assert.equal(saved.fromBlock, 100n)
    assert.equal(saved.parentId, 0n)
    assert.equal(saved.contract, mock.chain.contract)
    return request(ask)
  }
  assert.equal(await publish(sponsored), 1n)
  assert.equal(post.messageId, 1n)
  assert.equal((await pending.listPending()).length, 0)
  assert.ok(calls.some((c) => c.url.includes('/transaction/')))
  assert.ok(calls.some((c) => c.url.includes('/message/1?ancestors=0&commit=')))
  assert.ok(calls.every((c) => c.body?.method === undefined))
  if (!sponsored) {
    const sent = walletCalls.find((c) => c.method === 'eth_sendTransaction').params[0]
    assert.equal(BigInt(sent.gas), 125000n)
    const decoded = decodeFunctionData({ abi: boardAbi, data: sent.data })
    assert.equal(decoded.functionName, 'post')
    assert.deepEqual(decoded.args, [post.bodyHash, 0n, zeroAddress, '0x'])
  }
})

test('an excessive host estimate cannot be handed to the wallet', async () => {
  const normal = send
  send = (url, init) => url.endsWith('/post-estimate') ? response({ gas: '500001' }) : normal(url, init)
  await assert.rejects(publish(false), /excessive gas/)
  assert.equal(walletCalls.length, 0)
})

test('receipts must identify this transaction, author, parent and body', async () => {
  for (const wrong of [
    { ...receipt, hash: hash('ee') },
    { ...receipt, events: [] },
    { ...receipt, events: [{ kind: 'posted', message: { ...message, author: address('ee') } }] },
    { ...receipt, events: [{ kind: 'posted', message: { ...message, parent: '9' } }] },
    { ...receipt, events: [{ kind: 'posted', message: { ...message, content_hash: hash('ee') } }] },
  ]) {
    send = async () => response(wrong)
    await assert.rejects(tx.awaitPosted(mock.chain, hash('dd'), expected()), /invalid|confirm/)
  }
  send = async () => response({ ...receipt, status: 'reverted', events: [] })
  await assert.rejects(tx.awaitPosted(mock.chain, hash('dd'), expected()), tx.Reverted)
})

test('a known hash never searches the author index, and missing receipts remain pending', async () => {
  post.txHash = hash('dd')
  await pending.savePending(post)
  const normal = send
  send = async () => response({ hash: hash('dd'), status: 'pending' })
  assert.equal(await resolvePendingId(mock.chain, post), null)
  send = normal
  assert.equal(await resolvePendingId(mock.chain, post), 1n)
  assert.ok(calls.every((c) => !c.url.endsWith('/lookup')))
})

test('an upload finishing before the receipt retains the pending transaction metadata', async () => {
  post.txHash = hash('dd')
  await pending.savePending(post)
  await pending.recordUploaded(post.key, post.bodyHash, false)
  const saved = (await pending.listPending())[0]
  assert.equal(saved.txHash, post.txHash)
  assert.equal(saved.records.length, 0)
  assert.equal(saved.messageId, null)
  assert.equal(await resolvePendingId(mock.chain, saved), 1n)
  assert.equal((await pending.listPending()).length, 0)
})

test('lookup advances only after completing its captured range, not past posts arriving between pages', async () => {
  post.fromBlock = 10n
  await pending.savePending(post)
  const cursor = { generation: at.generation, filter: hash('ef'), ceiling: '5000', before: '4500' }
  send = async () => response({ at, items: [], next: cursor })
  assert.equal(await resolvePendingId(mock.chain, post), null)
  assert.equal(post.fromBlock, 10n)
  assert.equal(post.lookup.throughBlock, 100n)
  send = async () => response({ error: 'host_busy' }, 503)
  await assert.rejects(resolvePendingId(mock.chain, post), /host busy/)
  assert.deepEqual(post.lookup.cursor, cursor)
  at = { ...at, checkpoint: { ...at.checkpoint, block: '200' } }
  send = async () => response({ at, items: [], next: null })
  assert.equal(await resolvePendingId(mock.chain, post), null)
  assert.equal(post.fromBlock, 101n, 'the second page does not skip the newly accepted blocks')
  assert.equal(post.lookup, undefined)
  assert.deepEqual(calls.map((c) => c.body.cursor), [null, cursor, cursor])
})

test('a lookup match binds the author, body and direct parent', async () => {
  send = async () => response({ at, items: [{ ...message, author: address('ff') }], next: null })
  await assert.rejects(resolvePendingId(mock.chain, post), /inconsistent|invalid/)
  send = async () => response({ at, items: [message], next: null })
  assert.equal(await resolvePendingId(mock.chain, post), 1n)
})

test('an unknown relayer answer retains the exact signed request and captured bound', async () => {
  const normal = send
  send = (url, init) => url.includes('/api/relay/') ? response({ error: 'unknown', outcome: 'unknown' }, 504) : normal(url, init)
  await assert.rejects(publish(true), RelayUnknown)
  const saved = (await pending.listPending())[0]
  assert.deepEqual(saved.signed, post.signed)
  assert.equal(saved.fromBlock, 100n)
  assert.equal(saved.txHash, null)
})

test('moderation receipt matching rejects a different subject or gate', async () => {
  const r = { ...receipt, events: [{ kind: 'reply_gate', id: '4', old: zeroAddress, new: board.TOMBSTONE, position: { block: '1', log: 3 } }] }
  assert.deepEqual(tx.gateResult(r, 4n, board.TOMBSTONE), { txHash: hash('dd'), block: 1n, index: 3 })
  assert.throws(() => tx.gateResult(r, 5n, board.TOMBSTONE), /confirm/)
  assert.throws(() => tx.gateResult(r, 4n, board.REMOVED), /confirm/)
})


test('post completion waits for the index without polling the receipt again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  at = { ...at, checkpoint: { ...at.checkpoint, block: '0' } }
  let done = false
  const waiting = tx.awaitPosted(mock.chain, hash('dd'), expected()).then((id) => { done = true; return id })
  await new Promise(setImmediate)
  assert.equal(done, false)
  assert.equal(calls.some((c) => c.url.includes('/message/')), false)
  at = { ...at, checkpoint: { ...at.checkpoint, block: '1' } }
  t.mock.timers.tick(2000)
  assert.equal(await waiting, 1n)
  assert.equal(calls.filter((c) => c.url.includes('/transaction/')).length, 1)
})


for (const status of [0, 429, 502, 503, 504]) test(`receipt waits back off on ${status} and resume after the host recovers`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  t.mock.method(Math, 'random', () => 0.5)
  let mode = 'busy'
  send = async () => {
    if (mode === 'busy') {
      if (!status) throw new TypeError('network error')
      return new Response(null, { status })
    }
    return mode === 'pending' ? response({ hash: receipt.hash, status: 'pending' }) : response(receipt)
  }
  const waiting = tx.awaitSuccess(mock.chain, receipt.hash)
  const step = async (ms = 0) => { t.mock.timers.tick(ms); await new Promise(setImmediate) }
  await step()
  assert.equal(calls.length, 1)
  for (const gap of [3600, 7200, 14400, 27000]) {
    const before = calls.length
    await step(gap - 1)
    assert.equal(calls.length, before, 'no poll before its backoff')
    await step(1)
    assert.equal(calls.length, before + 1)
  }
  mode = 'pending'
  await step(27000)
  const before = calls.length
  await step(1999)
  assert.equal(calls.length, before)
  mode = 'success'
  await step(1)
  assert.deepEqual(await waiting, receipt)
  assert.equal(walletCalls.length, 0)
  assert.ok(calls.every((c) => c.url.endsWith(`/transaction/${receipt.hash}`)))
})

test('a long-pending receipt is checked quickly at first, then less often, within the wait window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  send = async () => response({ hash: receipt.hash, status: 'pending' })
  let ended = false
  const waiting = assert.rejects(tx.awaitSuccess(mock.chain, receipt.hash), /has not landed yet/).then(() => { ended = true })
  await new Promise(setImmediate)
  assert.equal(calls.length, 1)
  const gaps = []
  for (let n = 1; n <= 6; n++) gaps.push(pendingInterval(n))
  assert.deepEqual(gaps, [2000, 2000, 2000, 3000, 4500, 6750], 'three quick checks, then a stretching interval')
  assert.equal(pendingInterval(20), 15000, 'capped')
  for (const gap of gaps) {
    const before = calls.length
    t.mock.timers.tick(gap - 1); await new Promise(setImmediate)
    assert.equal(calls.length, before, 'no check before its interval')
    t.mock.timers.tick(1); await new Promise(setImmediate)
    assert.equal(calls.length, before + 1)
  }
  while (!ended) { t.mock.timers.tick(1000); await new Promise(setImmediate) }
  await waiting
  assert.ok(calls.length <= 14, `a two-minute pending wait costs at most 14 checks, not 60 (took ${calls.length})`)
  assert.ok(Date.now() <= 121_000)
})

for (const status of [0, 429, 502, 503, 504]) test(`a landed post keeps waiting for the index through ${status} and finishes after the host recovers`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  t.mock.method(Math, 'random', () => 0.5)
  at = { ...at, checkpoint: { ...at.checkpoint, block: '0' } }
  const normal = send
  let busy = true
  send = async (url, init) => {
    if (busy && url.endsWith('/state')) {
      if (!status) throw new TypeError('network error')
      return new Response(null, { status })
    }
    return normal(url, init)
  }
  const reads = () => calls.filter((c) => c.url.endsWith('/state')).length
  const step = async (ms = 0) => { t.mock.timers.tick(ms); await new Promise(setImmediate); await new Promise(setImmediate) }
  let settled = false
  const waiting = tx.awaitPosted(mock.chain, hash('dd'), expected()).finally(() => { settled = true })
  await step()
  assert.equal(reads(), 1)
  for (const gap of [3600, 7200]) {
    const before = reads()
    await step(gap - 1)
    assert.equal(reads(), before, 'no read before its backoff')
    await step(1)
    assert.equal(reads(), before + 1)
  }
  assert.equal(settled, false, 'a busy host does not abandon a landed post')
  busy = false
  at = { ...at, checkpoint: { ...at.checkpoint, block: '1' } }
  await step(14400)
  assert.equal(await waiting, 1n)
  assert.equal(calls.filter((c) => c.url.includes('/transaction/')).length, 1, 'the receipt is not polled again')
})

for (const status of [0, 503]) test(`the post read after indexing rides out ${status} without polling the receipt or resending`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  t.mock.method(Math, 'random', () => 0.5)
  const normal = send
  let failures = 2
  send = async (url, init) => {
    if (url.includes('/message/') && failures > 0) {
      failures--
      if (!status) throw new TypeError('network error')
      return new Response(null, { status })
    }
    return normal(url, init)
  }
  const reads = () => calls.filter((c) => c.url.includes('/message/')).length
  const step = async (ms = 0) => { t.mock.timers.tick(ms); for (let i = 0; i < 4; i++) await new Promise(setImmediate) }
  const waiting = tx.awaitPosted(mock.chain, hash('dd'), expected())
  await step()
  assert.equal(reads(), 1)
  await step(3599)
  assert.equal(reads(), 1, 'no read before its backoff')
  await step(1)
  assert.equal(reads(), 2)
  await step(7200)
  assert.equal(await waiting, 1n)
  assert.equal(calls.filter((c) => c.url.includes('/transaction/')).length, 1, 'the receipt is not polled again')
  assert.equal(walletCalls.length, 0, 'nothing is resent')
})

test('the post read after indexing still stops at once on a mismatch or a non-retryable error', async () => {
  const normal = send
  send = async (url, init) => url.includes('/message/') ? response({ error: 'not_found' }, 404) : normal(url, init)
  await assert.rejects(tx.awaitPosted(mock.chain, hash('dd'), expected()), (e) => e instanceof api.ApiError && e.status === 404)
  assert.equal(calls.filter((c) => c.url.includes('/message/')).length, 1)
  calls.length = 0
  const other = { ...message, content_hash: hash('ee') }
  other.commitment = api.commitment({ author: other.author, parentId: 0n, timestamp: other.timestamp, contentHash: other.content_hash })
  send = async (url, init) => url.includes('/message/') ? response({ at, message: other, ancestors: [] }) : normal(url, init)
  await assert.rejects(tx.awaitPosted(mock.chain, hash('dd'), expected()), /commitment/)
  assert.equal(calls.filter((c) => c.url.includes('/message/')).length, 1)
})

test('persistent index overload ends at the wait window with the landed message and leaves no timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  t.mock.method(Math, 'random', () => 0.5)
  send = async () => response({ error: 'busy' }, 503)
  let ended = false
  const waiting = assert.rejects(tx.awaitIndexed(mock.chain, 1n), /the transaction landed/).then(() => { ended = true })
  await new Promise(setImmediate)
  for (let i = 0; i < 20 && !ended; i++) { t.mock.timers.tick(30_000); await new Promise(setImmediate); await new Promise(setImmediate) }
  await waiting
  assert.ok(Date.now() <= 120_000 + 30_000)
  const count = calls.length
  assert.ok(count <= 8, `bounded reads, got ${count}`)
  t.mock.timers.tick(300_000); await new Promise(setImmediate)
  assert.equal(calls.length, count, 'the finished wait schedules nothing else')
})

test('the index wait still stops immediately on a non-retryable HTTP error', async () => {
  for (const status of [400, 404]) {
    calls = []
    send = async () => response({ error: 'bad_request' }, status)
    await assert.rejects(tx.awaitIndexed(mock.chain, 1n), (e) => e instanceof api.ApiError && e.status === status)
    assert.equal(calls.length, 1)
  }
})

test('persistent receipt overload stays within the wait window and leaves no polling timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  t.mock.method(Math, 'random', () => 0.5)
  send = async () => response({ error: 'busy' }, 503)
  let ended = false
  const waiting = assert.rejects(tx.awaitSuccess(mock.chain, receipt.hash), (e) => e instanceof api.ApiError && e.status === 503)
    .then(() => { ended = true })
  await new Promise(setImmediate)
  for (const ms of [3600, 7200, 14400, 27000, 27000, 27000]) {
    t.mock.timers.tick(ms); await new Promise(setImmediate)
  }
  assert.equal(Date.now(), 106200)
  assert.equal(calls.length, 7)
  t.mock.timers.tick(13799); await new Promise(setImmediate)
  assert.equal(ended, false)
  t.mock.timers.tick(1); await waiting
  assert.equal(calls.length, 7, 'no new request at the expired deadline')
  t.mock.timers.tick(300_000); await new Promise(setImmediate)
  assert.equal(calls.length, 7, 'the finished wait schedules nothing else')
})

test('receipt waits still stop immediately on a revert, invalid receipt or non-retryable HTTP error', async () => {
  for (const status of [400, 404]) {
    calls = []
    send = async () => response({ error: 'receipt_unavailable' }, status)
    await assert.rejects(tx.awaitSuccess(mock.chain, receipt.hash), (e) => e instanceof api.ApiError && e.status === status)
    assert.equal(calls.length, 1)
  }
  send = async () => response({ ...receipt, status: 'reverted' })
  await assert.rejects(tx.awaitSuccess(mock.chain, receipt.hash), tx.Reverted)
  send = async () => response({ ...receipt, hash: hash('ee') })
  await assert.rejects(tx.awaitSuccess(mock.chain, receipt.hash), /invalid transaction answer/)
})

test('a promoted held record is verified instead of uploaded again', async () => {
  const normal = send
  send = (url, init) => url.includes('/api/content/') ? new Response(post.records[0].bytes) : normal(url, init)
  assert.equal(await publish(false), 1n)
  assert.equal(calls.filter((c) => c.url.includes('/api/publish?')).length, 1)
  assert.equal(calls.filter((c) => c.url.includes('/api/content/')).length, 1)
  assert.equal((await pending.listPending()).length, 0)
  // The check asks at the address the page then shows the post from, so the browser cache answers that read.
  const { loadBody } = await load('lib/content.ts')
  await loadBody(post.records[0].hash, { chainId: mock.chain.id, messageId: 1n })
  const reads = calls.filter((c) => c.url.includes('/api/content/')).map((c) => c.url)
  assert.equal(reads.length, 2)
  assert.equal(reads[0], reads[1])
})

test('a successful list write is still successful when indexing takes too long', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const { writeList } = await load('lib/registry.ts')
  at = { ...at, checkpoint: { ...at.checkpoint, block: '0' } }
  const waiting = writeList(provider, post.author, mock.chain,
    { registry: address('ee'), owner: post.author, id: hash('ff') }, 'add', [address('11')])
  await new Promise(setImmediate)
  for (let i = 0; i < 60; i++) {
    t.mock.timers.tick(2000)
    await new Promise(setImmediate)
  }
  assert.deepEqual(await waiting, { hash: receipt.hash, indexed: false })
  assert.equal(walletCalls.filter((c) => c.method === 'eth_sendTransaction').length, 1)
  assert.equal(calls.filter((c) => c.url.includes('/transaction/')).length, 1)
})

test('post receipt progress distinguishes confirmation from waiting for the index', async () => {
  const notes = []
  let releaseIndex, reachedIndex
  const blocked = new Promise(resolve => { releaseIndex = resolve })
  const started = new Promise(resolve => { reachedIndex = resolve })
  const original = send
  send = async (url, init) => {
    if (url.endsWith('/state')) { reachedIndex(); await blocked }
    return original(url, init)
  }
  const work = tx.awaitPosted(mock.chain, hash('dd'), expected(), note => notes.push(note))
  await started
  try {
    assert.deepEqual(notes, ['transaction pending…', 'confirmed · loading post…'])
  } finally { releaseIndex(); await work }
})

test('a reverted receipt never reports the post as confirmed', async () => {
  const notes = []
  receipt = { ...receipt, status: 'reverted', events: [] }
  await assert.rejects(tx.awaitPosted(mock.chain, hash('dd'), expected(), note => notes.push(note)), tx.Reverted)
  assert.deepEqual(notes, ['transaction pending…'])
})

for (const sponsored of [false, true]) {
  test(`${sponsored ? 'sponsored' : 'wallet'} post keeps confirmed status while the early upload finishes`, async () => {
    const notes = []
    let releaseUpload, reachedUpload, releaseReceipt, reachedReceipt, reachedConfirmed
    const upload = new Promise(resolve => { releaseUpload = resolve })
    const uploading = new Promise(resolve => { reachedUpload = resolve })
    const receiptWait = new Promise(resolve => { releaseReceipt = resolve })
    const checking = new Promise(resolve => { reachedReceipt = resolve })
    const confirmed = new Promise(resolve => { reachedConfirmed = resolve })
    post.records = post.records.filter(record => record.kind === 'body')
    const original = send
    send = async (url, init) => {
      if (url.includes('/api/publish?') && url.includes('tx_hash=')) { reachedUpload(); await upload }
      if (url.includes('/transaction/')) { reachedReceipt(); await receiptWait }
      return original(url, init)
    }
    const work = publishPost({ chain: mock.chain, wallet: wallet(), parentId: 0n, pending: post, sponsored,
      onWarn() {}, onNote(note) { notes.push(note); if (note === 'confirmed · uploading post…') reachedConfirmed() } })
    await Promise.all([uploading, checking])
    try {
      assert.equal(notes.at(-1), 'transaction pending…')
      releaseReceipt(); await confirmed
      assert.equal(notes.at(-1), 'confirmed · uploading post…')
    } finally { releaseReceipt(); releaseUpload(); await work }
    const firstConfirmation = notes.findIndex(note => note.startsWith('confirmed ·'))
    assert.ok(firstConfirmation >= 0)
    assert.equal(notes.slice(firstConfirmation).includes('transaction pending…'), false)
    assert.equal(post.messageId, 1n)
  })
}

test('reply-rule transactions report approval and submitted stages', async () => {
  const notes = [], gate = address('77')
  receipt = { ...receipt, events: [{ kind: 'reply_gate', id: '1', new: gate, position: { block: '1', log: 0 } }] }
  await board.setReplyGate(provider, post.author, mock.chain, 1n, gate, note => notes.push(note))
  assert.deepEqual(notes, ['check your wallet…', 'transaction pending…'])
})

// ---- the checks before signing
const publishWith = (options) => publishPost({ chain: mock.chain, wallet: wallet(), parentId: post.parentId, pending: post, onWarn() {}, ...options })
const signs = () => walletCalls.filter((c) => ['eth_sendTransaction', 'eth_signTypedData_v4'].includes(c.method))

test('the reads before signing start together, and the notes fit the post', async () => {
  post.parentId = 3n
  // The receipt and index answer for this reply.
  message.id = '5'
  message.parent = '3'
  message.parent_author = address('33')
  message.commitment = api.commitment({ author: message.author, parentId: 3n, timestamp: message.timestamp, contentHash: message.content_hash })
  const normal = send
  let admission
  const held = new Promise((resolve) => { admission = resolve })
  send = async (url, init) => {
    if (url.endsWith('/admission')) await held
    return normal(url, init)
  }
  const notes = []
  const work = publishWith({ sponsored: false, onNote: (n) => notes.push(n) })
  for (let i = 0; i < 5; i++) await new Promise(setImmediate)
  assert.ok(calls.some((c) => c.url.endsWith('/state')), 'the snapshot read waited for the parent check')
  admission()
  await work
  assert.equal(notes[0], 'checking whether you can reply…')
  assert.ok(!notes.includes('checking the parent…'))
  message.id = '1'
  message.parent = '0'
  message.parent_author = zeroAddress
  message.commitment = api.commitment({ author: message.author, parentId: 0n, timestamp: message.timestamp, contentHash: message.content_hash })
  for (const sponsored of [false, true]) {
    post = makePost(); post.parentId = 0n
    const seen = []
    await publishWith({ sponsored, onNote: (n) => seen.push(n) })
    assert.equal(seen[0], 'preparing your post…', 'a top-level post has no parent to check')
    assert.equal(seen.includes("checking wallet connection…"), !sponsored, 'the relayer, not the wallet, sends a sponsored post')
  }
})

test('a failed check is reported even when the other reads succeed, before anything is saved or signed', async () => {
  post.parentId = 3n
  const normal = send
  for (const [failing, expected] of [['/admission', 403], ['/state', 503]]) {
    calls = []; walletCalls = []
    send = async (url, init) => url.endsWith(failing) ? response({ error: 'refused' }, expected) : normal(url, init)
    await assert.rejects(publishWith({ sponsored: false, onNote() {} }), (e) => e instanceof api.ApiError && e.status === expected)
    assert.deepEqual(signs(), [], `${failing}: nothing signed`)
    assert.equal(walletCalls.some((c) => c.method === 'wallet_switchEthereumChain'), false)
    assert.equal((await pending.listPending()).length, 0, `${failing}: no recovery copy for a post never sent`)
  }
  // Both failing: the parent check is reported, as when they ran in turn.
  send = async (url, init) => url.endsWith('/admission') ? response({ error: 'refused' }, 403) : url.endsWith('/state') ? response({ error: 'busy' }, 503) : normal(url, init)
  await assert.rejects(publishWith({ sponsored: false, onNote() {} }), (e) => e.status === 403)
})

test('an account switched in the wallet during the checks is refused at signing', async () => {
  const normal = send
  let switched = false
  send = async (url, init) => {
    if (url.endsWith('/state')) switched = true
    return normal(url, init)
  }
  const request = provider.request
  provider.request = async (ask) => ask.method === 'eth_accounts' && switched ? [address('77')] : request(ask)
  for (const sponsored of [false, true]) {
    post = makePost(); post.parentId = 0n; walletCalls = []; switched = false
    await assert.rejects(publishWith({ sponsored, onNote() {} }), /different account/)
    assert.deepEqual(signs(), [], `sponsored ${sponsored}: nothing signed or sent`)
  }
})

test('a receipt that appears in the last stretch before the deadline is still found', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const normal = send
  send = async (url, init) => url.includes('/transaction/') && Date.now() < 110_000 ? response({ hash: receipt.hash, status: 'pending' }) : normal(url, init)
  let answer
  const waiting = tx.awaitSuccess(mock.chain, receipt.hash).then((r) => { answer = r })
  for (let i = 0; i < 200 && !answer; i++) { t.mock.timers.tick(1000); await new Promise(setImmediate) }
  await waiting
  assert.equal(answer.status, 'success')
  assert.equal(Date.now(), 120_000, 'found by one last look at the deadline')
})

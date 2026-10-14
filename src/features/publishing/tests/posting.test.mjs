// Posting and recovery: uncertain sends, resends, uploads, the reply check before signing.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { decodeFunctionData, encodeErrorResult, zeroAddress } from 'viem'
import { load, mock, install, teardown, address, author, txHash, makePost, sign, posted, replyArgs } from '../../../../scripts/host-harness.mjs'
const { RelayBusy, RelayDeclined, RelayUnknown } = await load('features/publishing/relay.ts')

const pending = await load('features/publishing/pending.ts')
const { recoverPost, resolvePendingId } = await load('features/publishing/recovery.ts')
const { publishPost } = await load('features/publishing/posting.ts')
const { boardAbi } = await load('lib/abi/board.ts')
const { explain } = await load('lib/errors.ts')
const { Reverted } = await load('lib/transactions.ts')

beforeEach(install)
after(teardown)

for (const status of [0, 408, 409, 504, 403]) {
  test(`an old uncertain post survives resend outcome ${status} with the same signature`, async () => {
    const post = makePost(); sign(post); post.createdAt -= 2 * 60 * 60_000
    await pending.savePending(post); mock.relayStatus = status
    const result = await recoverPost(mock.chain, post)
    assert.equal(!!result.done, false)
    assert.deepEqual(mock.calls.find((c) => c.method === 'relay').signed, post.signed)
    assert.equal((await pending.listPending()).length, 1)
    assert.doesNotMatch(result.note, /post again/)
  })
}

test('expired signatures stay after a journal refusal, then finish when the post appears', async () => {
  const post = makePost(); sign(post, Date.now() - 1000); post.createdAt -= 2 * 60 * 60_000
  mock.relayStatus = 403
  await pending.savePending(post)
  assert.match((await recoverPost(mock.chain, post)).note, /refused/)
  assert.equal(mock.calls.filter((c) => c.method === 'relay').length, 1)
  assert.equal((await pending.listPending()).length, 1)
  mock.head++
  mock.logs = [posted(post)]
  assert.equal((await recoverPost(mock.chain, post)).done, true)
  assert.equal((await pending.listPending()).length, 0)
})

test('a successful resend uploads by transaction and retains held bytes until confirmation', async () => {
  const post = makePost(true); sign(post); await pending.savePending(post)
  mock.relayStatus = 200; mock.held = true
  assert.equal(!!(await recoverPost(mock.chain, post)).done, false)
  assert.equal(post.txHash, txHash)
  assert.ok(mock.calls.filter((c) => c.method === 'upload').every((c) => c.url.includes('tx_hash=')))
  assert.equal((await pending.listPending())[0].records.length, 2)
  mock.held = false; mock.logs = [posted(post)]
  assert.equal((await recoverPost(mock.chain, post)).done, true)
  assert.equal((await pending.listPending()).length, 0)
})

test('the hour cleanup applies only to unsigned posts and looks for the post first', async () => {
  const post = makePost(); post.createdAt -= 2 * 60 * 60_000; await pending.savePending(post)
  assert.equal((await recoverPost(mock.chain, post)).done, true)
  assert.equal(mock.calls.some((c) => c.method === 'upload'), false)
  const found = makePost(); found.createdAt = post.createdAt; await pending.savePending(found)
  mock.logs = [posted(found)]
  assert.equal(await resolvePendingId(mock.chain, found), 7n)
  assert.equal((await recoverPost(mock.chain, found)).done, true)
  assert.equal((await pending.listPending()).length, 0)
})

test('an attachment failure retains post metadata after the body is stored', async () => {
  const post = makePost(true); sign(post); post.messageId = 7n
  await pending.savePending(post); mock.uploadErrorHash = post.records[1].hash
  assert.match((await recoverPost(mock.chain, post)).note, /failed to upload/)
  const saved = (await pending.listPending())[0]
  assert.equal(saved.records.length, 1)
  assert.equal(saved.records[0].kind, 'attachment')
  assert.equal(saved.bodyHash, post.bodyHash)
  assert.equal(saved.messageId, 7n)
  assert.deepEqual(saved.signed, post.signed)
  mock.uploadErrorHash = null
  assert.equal((await recoverPost(mock.chain, saved)).done, true)
  assert.equal((await pending.listPending()).length, 0)
})

test('posting continues and reports both warnings when recovery storage fails', async () => {
  const post = makePost(), warnings = []
  globalThis.indexedDB = { open() { throw new Error('storage unavailable') } }
  const wallet = { account: author, chainId: mock.chain.id, ensureChain: async () => {}, provider: { request: async ({ method }) => method === 'eth_accounts' ? [author] : '0x1234' } }
  const warn = console.warn; console.warn = () => {}
  try {
    await assert.rejects(publishPost({ chain: mock.chain, wallet, parentId: 0n, pending: post, sponsored: true, onNote() {}, onWarn: (w) => warnings.push(w) }), RelayUnknown)
  } finally { console.warn = warn }
  assert.equal(warnings.length, 2)
  assert.equal(mock.calls.filter((c) => c.method === 'relay').length, 1)
  assert.deepEqual(mock.calls.find((c) => c.method === 'relay').signed, post.signed)
})

test('a definite refusal of the first send removes its recovery entry', async () => {
  const post = makePost(); mock.relayStatus = 403
  const wallet = { account: author, chainId: mock.chain.id, ensureChain: async () => {}, provider: { request: async ({ method }) => method === 'eth_accounts' ? [author] : '0x1234' } }
  await assert.rejects(publishPost({ chain: mock.chain, wallet, parentId: 0n, pending: post, sponsored: true, onNote() {}, onWarn() {} }), RelayDeclined)
  assert.equal((await pending.listPending()).length, 0)
})

test('a wallet broadcast with a lost hash keeps its bytes and recovers by the indexed post', async () => {
  const args = { ...replyArgs(), parentId: 0n, sponsored: false }
  const provider = args.wallet.provider, request = provider.request
  let sends = 0
  provider.request = async (ask) => {
    if (ask.method !== 'eth_sendTransaction') return request(ask)
    sends++
    const [saved] = await pending.listPending()
    assert.equal(saved.walletSubmitted, true, 'save uncertainty before invoking the wallet')
    mock.logs = [posted(args.pending)]
    throw new Error('wallet connection closed after broadcasting')
  }
  await assert.rejects(publishPost(args))
  const [saved] = await pending.listPending()
  assert.equal(saved.txHash, null)
  assert.equal(saved.walletSubmitted, true)
  assert.equal(saved.records.length, args.pending.records.length)
  assert.equal(mock.calls.some((c) => c.method === 'upload'), false)
  assert.equal((await recoverPost(mock.chain, saved)).done, true)
  assert.ok(mock.calls.some((c) => c.method === 'upload'))
  assert.equal(sends, 1, 'recovery never sends a second wallet transaction')
  assert.equal((await pending.listPending()).length, 0)
})

test('an uncertain wallet send survives reload and an hour without mining', async () => {
  const args = { ...replyArgs(), parentId: 0n, sponsored: false }
  const request = args.wallet.provider.request
  args.wallet.provider.request = async (ask) => {
    if (ask.method === 'eth_sendTransaction') throw new Error('connection lost')
    return request(ask)
  }
  await assert.rejects(publishPost(args))
  const [saved] = await pending.listPending()
  saved.createdAt -= 2 * 60 * 60_000
  await pending.savePending(saved)
  assert.equal(!!(await recoverPost(mock.chain, saved)).done, false)
  assert.equal((await pending.listPending()).length, 1)
  mock.head++
  mock.logs = [posted(saved)]
  assert.equal((await recoverPost(mock.chain, saved)).done, true)
  assert.equal((await pending.listPending()).length, 0)
})

test('an explicit wallet rejection still deletes the unsent recovery copy', async () => {
  const args = { ...replyArgs(), parentId: 0n, sponsored: false }
  const request = args.wallet.provider.request
  args.wallet.provider.request = async (ask) => {
    if (ask.method === 'eth_sendTransaction') throw Object.assign(new Error('reader rejected'), { code: 4001 })
    return request(ask)
  }
  await assert.rejects(publishPost(args))
  assert.equal((await pending.listPending()).length, 0)
})

test('a failed account check never marks the post as submitted', async () => {
  const args = { ...replyArgs(), parentId: 0n, sponsored: false }
  args.wallet.provider.request = async () => [address('99')]
  await assert.rejects(publishPost(args))
  assert.notEqual(args.pending.walletSubmitted, true)
  assert.equal((await pending.listPending()).length, 0)
})

test('a failed host estimate cleans up before any wallet submission', async () => {
  const args = { ...replyArgs(), parentId: 0n, sponsored: false }
  mock.failRead = (url) => url.endsWith('/post-estimate')
  await assert.rejects(publishPost(args))
  assert.notEqual(args.pending.walletSubmitted, true)
  assert.equal(mock.calls.some((c) => c.method === 'eth_sendTransaction'), false)
  assert.equal((await pending.listPending()).length, 0)
})

for (const reverted of [false, true]) {
  test(`publishing uploads early and handles a ${reverted ? 'reverted' : 'successful'} receipt`, async () => {
    const post = makePost(true); mock.relayStatus = 200; mock.logs = [posted(post)]
    mock.receiptStatus = reverted ? '0x0' : '0x1'
    mock.onRelay = async () => {
      const saved = (await pending.listPending())[0]
      assert.deepEqual(saved.signed, post.signed, 'signature is saved before submission')
      assert.equal(saved.records.length, 2)
    }
    const wallet = { account: author, chainId: mock.chain.id, ensureChain: async () => {}, provider: { request: async ({ method }) => method === 'eth_accounts' ? [author] : '0x1234' } }
    const publish = publishPost({ chain: mock.chain, wallet, parentId: 0n, pending: post, sponsored: true, onNote() {}, onWarn() {} })
    if (reverted) await assert.rejects(publish, Reverted)
    else {
      await publish
      assert.equal(post.messageId, 7n)
      assert.ok(post.records.every((r) => r.status === 'stored'))
      assert.ok(mock.calls.some((c) => c.method === 'upload' && c.url.includes('message_id=7')))
    }
    assert.ok(mock.calls.findIndex((c) => c.method === 'upload') < mock.calls.findIndex((c) => c.method === 'transaction'))
    assert.equal((await pending.listPending()).length, 0)
  })
}

for (const sponsored of [false, true]) {
  test(`an unfamiliar gate is checked before a ${sponsored ? 'sponsored signature' : 'wallet transaction'}`, async () => {
    mock.authorGate = address('99'); mock.relayStatus = 200
    const args = { ...replyArgs(), sponsored }
    mock.logs = [posted(args.pending, args.parentId)]
    assert.equal(await publishPost(args), 7n)
    assert.deepEqual(mock.calls.filter((c) => c.method === 'admission').map((c) => [c.parent, c.replier]), [[String(args.parentId), author]])
    assert.equal(mock.calls.filter((c) => c.method === 'admission').length, 1)
    assert.ok(mock.calls.findIndex((c) => c.method === 'admission') < mock.calls.findIndex((c) => c.method === 'wallet:ensureChain'))
    const sent = sponsored
      ? mock.calls.find((c) => c.method === 'relay').signed
      : decodeFunctionData({ abi: boardAbi, data: mock.calls.find((c) => c.method === 'eth_sendTransaction').params[0].data })
    if (sponsored) assert.equal('expectedParentGate' in sent, false)
    else assert.equal(sent.args.length, 4)
    assert.equal(sponsored ? sent.gateData : sent.args[3], '0x')
  })
}

for (const [name, errorName, args, expected] of [
  ['a gate rejection', 'GateRejected', [address('99')], /reply rule refused/],
  ['a blocklist rejection', 'GateRejected', [address('55')], /reply rule refused/],
  ['a missing parent', 'ParentNotFound', [6n], /no post #6/],
  ['a retracted parent', 'ParentRetracted', [6n], /retracted/],
  ['a removed parent', 'ParentRemoved', [6n], /removed/],
]) {
  test(`Board preview reports ${name} before asking the wallet`, async () => {
    mock.previewError = { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: boardAbi, errorName, args }) }
    await assert.rejects(publishPost(replyArgs()), (e) => expected.test(explain(e)))
    assert.ok(mock.calls.some((c) => c.method === 'admission'))
    assert.equal(mock.calls.some((c) => ['wallet:ensureChain', 'eth_signTypedData_v4', 'eth_sendTransaction', 'relay'].includes(c.method)), false)
    assert.equal((await pending.listPending()).length, 0)
  })
}

for (const [name, error, expected] of [
  ['an unrecognized revert', { code: 3, message: 'execution reverted', data: '0xdeadbeef' }, /revert/i],
  ['an RPC failure', { code: -32603, message: 'upstream unavailable' }, /admission unavailable/],
]) {
  test(`Board preview distinguishes ${name} without signing`, async () => {
    mock.previewError = error
    await assert.rejects(publishPost(replyArgs()), (e) => expected.test(explain(e)))
    assert.equal(mock.calls.some((c) => c.method === 'wallet:ensureChain' || c.method === 'relay'), false)
    assert.equal((await pending.listPending()).length, 0)
  })
}

test('a silent Board preview revert stops without a second admission path', async () => {
  mock.previewError = { code: 3, message: 'execution reverted' }
  await assert.rejects(publishPost(replyArgs()), (e) => /revert/i.test(explain(e)))
  assert.equal(mock.calls.filter((c) => c.method === 'admission').length, 1)
  assert.equal(mock.calls.some((c) => ['effectiveGate', 'canReply', 'wallet:ensureChain', 'relay'].includes(c.method)), false)
  assert.equal((await pending.listPending()).length, 0)
})

test('only replies need a Board preview; no gate pin is signed', async () => {
  for (const parentId of [0n, 6n]) {
    mock.authorGate = zeroAddress
    await assert.rejects(publishPost({ ...replyArgs(), parentId }), RelayUnknown)
  }
  assert.deepEqual(mock.calls.filter((c) => c.method === 'admission').map((c) => [c.parent, c.replier]), [['6', author]])
  assert.ok(mock.calls.filter((c) => c.method === 'relay').every((c) => !('expectedParentGate' in c.signed)))
})

for (const result of ['0x', '0x01']) {
  test(`a malformed Board preview (${result}) stops before signing`, async () => {
    mock.previewReply = result
    await assert.rejects(publishPost(replyArgs()))
    assert.equal(mock.calls.some((c) => c.method === 'wallet:ensureChain' || c.method === 'relay'), false)
  })
}


test('a first post uses explicit outcomes for paid fallback, including both kinds of 409', async () => {
  for (const [status, outcome] of [[503, 'refused'], [502, 'refused'], [409, 'refused'], [409, 'unknown'], [503, null], [403, null]]) {
    install()
    const post = makePost()
    mock.relayStatus = status
    mock.relayOutcome = outcome
    const wallet = { account: author, chainId: mock.chain.id, ensureChain: async () => {}, provider: { request: async ({ method }) => method === 'eth_accounts' ? [author] : '0x1234' } }
    const expected = outcome !== 'refused' ? RelayUnknown : status === 503 ? RelayBusy : RelayDeclined
    await assert.rejects(publishPost({ chain: mock.chain, wallet, parentId: 0n, pending: post, sponsored: true, onNote() {}, onWarn() {} }), expected)
    assert.equal((await pending.listPending()).length, outcome === 'refused' ? 0 : 1)
  }
})

test('a relayer that is busy or pacing this network is not a decline, while a spent daily quota is', async () => {
  // 503 is the relayer's congestion; a 429 with Retry-After is this network's pace.
  for (const [status, retryAfter, expected] of [[503, null, RelayBusy], [503, 2, RelayBusy], [429, 2, RelayBusy], [429, 0, RelayBusy], [429, null, RelayDeclined]]) {
    install()
    const post = makePost()
    mock.relayStatus = status; mock.relayOutcome = 'refused'; mock.relayRetryAfter = retryAfter
    const wallet = { account: author, chainId: mock.chain.id, ensureChain: async () => {}, provider: { request: async ({ method }) => method === 'eth_accounts' ? [author] : '0x1234' } }
    await assert.rejects(publishPost({ chain: mock.chain, wallet, parentId: 0n, pending: post, sponsored: true, onNote() {}, onWarn() {} }), (e) => e instanceof expected && !(expected === RelayBusy && e instanceof RelayDeclined))
    assert.equal((await pending.listPending()).length, 0, 'nothing was sent, so nothing is kept to resend')
  }
})

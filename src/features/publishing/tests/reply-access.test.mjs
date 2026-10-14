import assert from 'node:assert/strict'
import { test, beforeEach, after } from 'node:test'
import { decodeFunctionData, encodeFunctionResult, zeroAddress } from 'viem'
process.env.VITE_ACCOUNT_KEYS_ADDRESS = '0x7777777777777777777777777777777777777777'
process.env.VITE_ACCOUNT_KEYS_DEV_FUND = '0x3333333333333333333333333333333333333333'
const { load, install, teardown, mock, author, address, feedPost, feedHistory } = await import('../../../../scripts/host-harness.mjs')
const { replyAccess } = await load('features/publishing/reply-access.ts')
const { accountKeysAbi } = await load('lib/abi/accountKeys.ts')
const { postReplyChoice, postGateForChoice, replyRuleLabel, isClosedReplyRule } = await load('features/publishing/reply-rules.ts')
const { currentPostReplyGate } = await load('features/account/post-reply-rule.ts')
const { gating } = await load('features/messages/gating.svelte.ts')
let indexed, holdings, active, rpcReads
const reader = address('88'), closed = address('99')
beforeEach(() => {
  install(); mock.chain.id = 84532; mock.chain.public_rpc_url = 'https://keys.invalid'; mock.chain.closed_gate = closed
  mock.chain.contract = address('ab'); mock.chain.key_gates = { holders: address('97'), holders_blocklist: address('98') }
  mock.authorGate = mock.chain.key_gates.holders_blocklist; mock.blocked = false
  indexed = { chain: 84532, market: process.env.VITE_ACCOUNT_KEYS_ADDRESS }
  holdings = 0n; active = true; rpcReads = 0
  feedHistory([feedPost(1)])
  const host = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://keys.invalid')) return host(url, init)
    rpcReads++
    const q = JSON.parse(init.body)
    let result
    if (q.method === 'eth_blockNumber') result = '0x20'
    else {
      assert.equal(q.params[1], '0x20', 'both reads use the same block')
      const { functionName, args } = decodeFunctionData({ abi: accountKeysAbi, data: q.params[0].data })
      assert.equal(args[0].toLowerCase(), author)
      if (functionName === 'balanceOf') assert.equal(args[1].toLowerCase(), reader)
      result = encodeFunctionResult({ abi: accountKeysAbi, functionName,
        result: { active, supply: 1n, balanceOf: holdings, claimableFees: 0n }[functionName] })
    }
    return Response.json({ jsonrpc: '2.0', id: q.id, result })
  }
})
after(teardown)
test('missing keys offer the right creator, and a fresh check after buying removes the prompt', async () => {
  assert.deepEqual(await replyAccess(mock.chain, 1n, reader, indexed), { kind: 'keys', creator: author })
  assert.equal(rpcReads, 3)
  holdings = 1n
  assert.equal(await replyAccess(mock.chain, 1n, reader, indexed), null)
  assert.equal(rpcReads, 6)
})
test('blocks forbid submission only under gates that enforce the blocklist', async () => {
  mock.blocked = true
  for (const gate of [mock.chain.blocking.gate, mock.chain.key_gates.holders_blocklist]) {
    mock.authorGate = gate
    assert.deepEqual(await replyAccess(mock.chain, 1n, reader, indexed), { kind: 'blocked', creator: author })
  }
  assert.equal(rpcReads, 0)
  for (const gate of [zeroAddress, address('56'), mock.chain.key_gates.holders]) {
    mock.authorGate = gate; holdings = 1n
    assert.deepEqual(await replyAccess(mock.chain, 1n, reader, indexed), { kind: null, creator: author, blocked: true })
  }
})
test('an advisory block does not hide a plain key gate restriction', async () => {
  mock.blocked = true; mock.authorGate = mock.chain.key_gates.holders
  assert.deepEqual(await replyAccess(mock.chain, 1n, reader, indexed), { kind: 'keys', creator: author, blocked: true })
  active = false
  assert.deepEqual(await replyAccess(mock.chain, 1n, reader, indexed), { kind: 'inactive', creator: author, blocked: true })
})
test('unknown and mismatched markets never offer a purchase as the remedy', async () => {
  assert.equal(await replyAccess(mock.chain, 1n, reader, { ...indexed, market: address('55') }), null)
  mock.authorGate = address('56')
  assert.equal(await replyAccess(mock.chain, 1n, reader, indexed), null)
  assert.equal(rpcReads, 0)
})
test('inactive markets do not invite buying and failed reads remain unknown', async () => {
  active = false
  assert.deepEqual(await replyAccess(mock.chain, 1n, reader, indexed), { kind: 'inactive', creator: author })
  mock.gateError = true
  await assert.rejects(replyAccess(mock.chain, 1n, reader, indexed))
})
test('closing affects new replies, not display folding, and reopening remains available', async () => {
  mock.authorGate = closed
  assert.deepEqual(await replyAccess(mock.chain, 1n, author, indexed), { kind: 'closed', creator: author })
  assert.equal(await gating.check(mock.chain, { parentId: 1n, author: reader, blockNumber: 2n }, author), 'shown')
  mock.blocked = true
  assert.equal(await gating.check(mock.chain, { parentId: 1n, author: reader, blockNumber: 2n }, author), 'folded')
  assert.equal(isClosedReplyRule(mock.chain, closed, zeroAddress), true)
  assert.equal(isClosedReplyRule(mock.chain, zeroAddress, closed), true)
  assert.equal(isClosedReplyRule(mock.chain, mock.chain.blocking.gate, closed), false)
  assert.equal(postReplyChoice(mock.chain, closed), 'closed')
  assert.equal(postGateForChoice(mock.chain, 'closed'), closed)
  assert.equal(replyRuleLabel('closed', false), 'no new replies')
  assert.equal(postGateForChoice(mock.chain, 'default'), zeroAddress)
  assert.equal(await currentPostReplyGate(mock.chain, author, closed), closed)
  mock.publishedStatus = { chains: [{ ...mock.chain, closed_gate: null }], keyrings: [indexed] }
  assert.equal(await currentPostReplyGate(mock.chain, author, closed), zeroAddress)
})

test('the key-holder rule check before signing reads the public RPC, never a connected wallet', async () => {
  const { wallet } = await load('lib/wallet.svelte.ts')
  const gate = mock.chain.key_gates.holders_blocklist
  let walletReads = 0
  wallet.account = author; wallet.chainId = mock.chain.id
  // A wallet whose RPC never answers would otherwise hold a sponsored post for its timeout.
  wallet.provider = { request: () => { walletReads++; return new Promise(() => {}) } }
  mock.publishedStatus = { chains: [mock.chain], keyrings: [indexed] }
  const host = globalThis.fetch
  let publicReads = 0
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://keys.invalid')) return host(url, init)
    publicReads++
    const q = JSON.parse(init.body)
    const { functionName } = decodeFunctionData({ abi: accountKeysAbi, data: q.params[0].data })
    return Response.json({ jsonrpc: '2.0', id: q.id, result: encodeFunctionResult({ abi: accountKeysAbi, functionName, result: active }) })
  }
  try {
    assert.equal(await currentPostReplyGate(mock.chain, author, gate), gate)
    active = false
    assert.equal(await currentPostReplyGate(mock.chain, author, gate), zeroAddress)
    assert.equal(walletReads, 0)
    assert.equal(publicReads, 2)
  } finally { wallet.provider = undefined; wallet.account = null; wallet.chainId = null }
})

test('repeated checks without buying keep the key warning and reread balances', async () => {
  for (let i = 1; i <= 3; i++) {
    assert.deepEqual(await replyAccess(mock.chain, 1n, reader, indexed), { kind: 'keys', creator: author })
    assert.equal(rpcReads, i * 3)
  }
})


test('the immediate parent author can respond through closed, deactivated, key and blocked rules', async () => {
  feedHistory([feedPost(1, 0, reader), feedPost(2, 1, author)])
  mock.blocked = true
  for (const gate of [closed, '0x0000000000000000000000000000000000000001', mock.chain.key_gates.holders_blocklist]) {
    mock.authorGate = gate
    assert.equal(await replyAccess(mock.chain, 2n, reader, indexed), null)
  }
  assert.equal(rpcReads, 0)
  for (const gate of ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002']) {
    mock.gates.set(2n, gate)
    assert.deepEqual(await replyAccess(mock.chain, 2n, reader, indexed), { kind: 'closed', creator: author })
  }
})

test('protected responses bypass folding, but another author does not', async () => {
  feedHistory([feedPost(1, 0, reader), feedPost(2, 1, author), feedPost(3, 2, reader)])
  mock.blocked = true
  assert.equal(await gating.check(mock.chain, { parentId: 2n, author: reader, blockNumber: 3n }, author), 'shown')
  assert.equal(await gating.check(mock.chain, { parentId: 2n, author: address('66'), blockNumber: 3n }, author), 'folded')
})

test('a per-post key rule still refuses new replies without folding existing ones', async () => {
  mock.authorGate = zeroAddress
  mock.gates.set(1n, mock.chain.key_gates.holders_blocklist)
  mock.holdsKey = false
  assert.deepEqual(await replyAccess(mock.chain, 1n, reader, indexed), { kind: 'keys', creator: author })
  assert.equal(await gating.check(mock.chain, { parentId: 1n, author: reader, blockNumber: 2n }, author), 'shown')
  assert.equal(mock.calls.some(c => c.method === 'key-holdings'), false)
})

// Gates: sentinels remembered, gates supplied by host records, the published blocklist gate folding replies.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { decodeFunctionData, keccak256, zeroAddress } from 'viem'
import { load, mock, install, teardown, address, author, feedPost, feedHistory, replyArgs, verdict, counted, txHash, gateChanged } from './host-harness.mjs'

const { tombstone, removeReply, isDeactivated, TOMBSTONE, REMOVED } = await load('lib/board.ts')
const { Reverted } = await load('lib/transactions.ts')
const { gates: ledger } = await load('lib/gates.svelte.ts')
const { gating } = await load('features/messages/gating.svelte.ts')
const { loadFeed } = await load('features/streams/feed.ts')
const { pressBlock } = await load('features/account/blocking.ts')
const { registryAbi } = await load('lib/abi/registry.ts')

beforeEach(install)

test('cards and the widget close replies only for inherited author deactivation', () => {
  assert.equal(isDeactivated(zeroAddress, TOMBSTONE), true)
  for (const own of [undefined, TOMBSTONE, REMOVED, address('33')]) {
    assert.equal(isDeactivated(own, TOMBSTONE), false, 'a message gate overrides the author gate')
  }
  for (const authorGate of [undefined, zeroAddress, address('33')]) {
    assert.equal(isDeactivated(zeroAddress, authorGate), false)
  }
})
after(teardown)

test('a deletion or removal this tab made is known the moment it lands; a reverted one is not', async () => {
  feedHistory([feedPost(1)])
  assert.equal((await loadFeed(mock.chain, { kind: 'timeline' })).rows.length, 1)
  const provider = replyArgs().wallet.provider
  assert.equal(await ledger.ensureMessage(mock.chain, 1n), zeroAddress)
  gateChanged(1n, TOMBSTONE, 2n); mock.head = 1n
  mock.receiptLogs = [mock.logs.at(-1)]
  const landed = await tombstone(provider, author, mock.chain, 1n)
  ledger.settleMessage(mock.chain, 1n, TOMBSTONE, landed)
  // The accepted index still reports zero; the tab already has its receipt.
  assert.equal(ledger.message(mock.chain, 1n), TOMBSTONE)
  assert.deepEqual((await loadFeed(mock.chain, { kind: 'timeline' })).rows, [])
  gateChanged(3n, REMOVED, 3n); mock.head = 1n
  mock.receiptLogs = [mock.logs.at(-1)]
  const removed = await removeReply(provider, author, mock.chain, 3n)
  ledger.settleMessage(mock.chain, 3n, REMOVED, removed)
  assert.equal(ledger.message(mock.chain, 3n), REMOVED)
  mock.receiptStatus = '0x0'
  await assert.rejects(tombstone(provider, author, mock.chain, 2n), Reverted)
  assert.equal(await ledger.ensureMessage(mock.chain, 2n), zeroAddress)
})

test('pages and ancestor answers supply gates; a missing context count costs one snapshot, then refresh uses changes', async () => {
  const filter = { kind: 'following', includeRepliesToViewer: false, authors: [author] }
  feedHistory([feedPost(1), feedPost(2, 1), feedPost(3, 2)])
  mock.gates.set(2n, TOMBSTONE)
  await counted(loadFeed(mock.chain, filter))
  const reads = () => mock.calls.filter((c) => c.method === 'state').length
  assert.equal(reads(), 1)
  for (const id of [1n, 2n, 3n]) assert.equal(await ledger.ensureMessage(mock.chain, id), mock.gates.get(id) ?? zeroAddress)
  assert.equal(reads(), 1, 'cards reuse the records; the only snapshot was the context count')
  assert.equal(ledger.message(mock.chain, 2n), TOMBSTONE)
  gateChanged(3n, REMOVED, 4n)
  await counted(loadFeed(mock.chain, filter))
  assert.equal(reads(), 1, 'a refresh reads no gate again: the change came as an event')
  assert.equal(ledger.message(mock.chain, 3n), REMOVED)
  assert.equal(ledger.message(mock.chain, 3n), REMOVED)
  // The mock forgets; the ledger does not, for live gates and sentinels alike.
  mock.gates.clear()
  assert.equal(await ledger.ensureMessage(mock.chain, 1n), zeroAddress)
  assert.equal(reads(), 1)
})

test('the published blocklist gate folds according to the parent author’s list', async () => {
  assert.equal(await verdict(), 'folded')
  assert.deepEqual(mock.calls.find((c) => c.memberships?.length).memberships, [{ list: { registry: mock.chain.blocking.registry, owner: author, list: keccak256(new TextEncoder().encode('blocklist')) }, member: address('88') }])
  assert.equal(mock.calls.some((c) => c.method === 'eth_getTransactionByHash'), false)
})

test('blocklist verdicts belong to a Board deployment, not only a chain and id', async () => {
  assert.equal(await verdict(), 'folded')
  mock.chain = { ...mock.chain, contract: address('ef') }
  mock.blocked = false
  assert.equal(await verdict(), 'shown')
  assert.equal(mock.calls.filter((c) => c.memberships?.length).length, 2)
})

test('unblocked replies under unknown gates stay visible without replaying admission', async () => {
  mock.authorGate = address('99'); mock.blocked = false
  assert.equal(await verdict(), 'shown')
  assert.equal(mock.calls.some((c) => c.memberships?.length > 0), true)
  assert.ok(mock.calls.every((c) => c.method === 'state'), 'no arbitrary gate preview')
})

test('an unset gate still folds blocked replies', async () => {
  mock.authorGate = zeroAddress; mock.chain.blocking = null
  assert.equal(await verdict(), 'folded')
  assert.equal(mock.calls.some((c) => c.memberships?.length > 0), true)
})

test('a closed parent still folds blocked replies', async () => {
  mock.perMessageGate = address('01')
  assert.equal(await verdict(), 'folded')
  assert.equal(mock.calls.some((c) => c.memberships?.length > 0), true)
})

test('an account absent from the blocklist stays visible', async () => {
  mock.blocked = false
  assert.equal(await verdict(), 'shown')
  assert.ok(mock.calls.some((c) => c.memberships?.length > 0))
})

test('a failed gate lookup reports an unknown verdict', async () => {
  mock.gateError = true
  await assert.rejects(verdict())
  assert.ok(mock.calls.some((c) => c.method === 'state'))
})

test('a press of the block control acts for the account that pressed, or sends nothing if the wallet moved while the chain was checked', async () => {
  const alice = address('a1'), bob = address('b0'), target = address('77')
  const sent = []
  const provider = { on: () => {}, request: async ({ method, params }) => {
    if (method === 'eth_chainId') return `0x${mock.chain.id.toString(16)}`
    if (method === 'eth_accounts') return [alice]
    if (method === 'eth_estimateGas') return '0x5208'
    if (method === 'eth_sendTransaction') { sent.push(decodeFunctionData({ abi: registryAbi, data: params[0].data }).functionName); return txHash }
    throw new Error(`unexpected ${method}`)
  } }
  // Alice presses block; the wallet is Bob's by the time the chain check is done.
  const switching = { provider, account: alice, ensureChain: async () => { switching.account = bob } }
  assert.deepEqual(await pressBlock(switching, mock.chain, target, true), { kind: 'switched' })
  assert.deepEqual(sent, [], 'nothing went out for either account')
  // A steady wallet does what was asked: the state decided at the press, not the one shown later.
  const steady = { provider, account: alice, ensureChain: async () => {} }
  assert.deepEqual(await pressBlock(steady, mock.chain, target, false), { kind: 'unblocked', indexed: true })
  assert.deepEqual(sent, ['remove'])
  assert.deepEqual(await pressBlock(steady, mock.chain, target, true), { kind: 'blocked', gateSet: 'already', indexed: true })
  assert.deepEqual(sent, ['remove', 'add'], 'the author gate already enforces the list, so no gate transaction follows')
})


for (const kind of ['holders', 'holders_blocklist', 'deactivated']) {
  test(`blocking under ${kind} reports whether the gate enforces the blocklist`, async () => {
    mock.chain.key_gates = { holders: address('98'), holders_blocklist: address('99') }
    mock.authorGate = kind === 'deactivated' ? TOMBSTONE : mock.chain.key_gates[kind]
    const sent = []
    const provider = { request: async ({ method, params }) => {
      if (method === 'eth_chainId') return `0x${mock.chain.id.toString(16)}`
      if (method === 'eth_accounts') return [author]
      if (method === 'eth_estimateGas') return '0x52000'
      if (method === 'eth_sendTransaction') { sent.push(decodeFunctionData({ abi: registryAbi, data: params[0].data }).functionName); return txHash }
      throw new Error(`unexpected ${method}`)
    } }
    const wallet = { provider, account: author, ensureChain: async () => {} }
    const result = await pressBlock(wallet, mock.chain, address('88'), true)
    assert.equal(result.gateSet, kind === 'deactivated' ? 'deactivated' : kind === 'holders_blocklist' ? 'already' : 'keys-only')
    assert.deepEqual(sent, ['add'], 'never replace the chosen author gate or reactivate the account')
  })
}



for (const kind of ['holders', 'holders_blocklist']) {
  for (const perMessage of [false, true]) {
    test(`${kind} at ${perMessage ? 'message' : 'account'} scope ${perMessage ? 'only controls admission' : 'uses indexed balances'} and respects blocks`, async () => {
      const gate = address('99')
      mock.chain.key_gates = { [kind]: gate }
      if (perMessage) mock.perMessageGate = gate
      else mock.authorGate = gate
      mock.blocked = false; mock.holdsKey = false
      const old = await verdict()
      assert.equal(old, perMessage ? 'shown' : 'folded')
      assert.equal(mock.calls.some(c => c.method === 'key-holdings'), !perMessage)
      mock.holdsKey = true
      assert.equal(old, perMessage ? 'shown' : 'folded', 'the displayed result is unchanged until another explicit check')
      assert.equal(await verdict(), 'shown')
      mock.blocked = true
      assert.equal(await verdict(), 'folded')
      assert.equal(mock.calls.some(c => c.method === 'admission'), false)
    })
  }
}
test('concurrent holder checks deduplicate and batch at fifty pairs', async () => {
  mock.chain.key_gates = { holders: address('99') }; mock.authorGate = address('99'); mock.blocked = false
  const replies = Array.from({ length: 120 }, (_, n) => ({ parentId: 7n, author: `0x${(n + 1000).toString(16).padStart(40, '0')}`, blockNumber: 9n }))
  assert.ok((await Promise.all([...replies, ...replies].map(r => verdict(r)))).every(v => v === 'shown'))
  const asks = mock.calls.filter(c => c.method === 'key-holdings')
  assert.deepEqual(asks.map(c => c.pairs.length), [50, 50, 20])
  assert.equal(mock.calls.some(c => c.method === 'admission'), false)
})
test('unavailable holdings show replies without retry or paid admission', async () => {
  mock.chain.key_gates = { holders: address('99') }; mock.authorGate = address('99'); mock.blocked = false
  mock.holdingsError = true
  await assert.rejects(verdict())
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(mock.calls.filter(c => c.method === 'key-holdings').length, 1)
  mock.holdingsError = false; mock.holdsKey = false
  assert.equal(await verdict(), 'folded')
  assert.equal(mock.calls.some(c => c.method === 'admission'), false)
})
test('a per-post rule does not override account-level key folding', async () => {
  mock.chain.key_gates = { holders: address('99') }; mock.authorGate = address('99'); mock.blocked = false
  mock.holdsKey = false
  for (const gate of [address('aa'), mock.chain.blocking.gate, address('77')]) {
    mock.chain.closed_gate = address('77')
    mock.perMessageGate = gate
    assert.equal(await verdict(), 'folded')
  }
  assert.equal(mock.calls.some(c => c.method === 'key-holdings'), true)
})

for (const kind of ['holders', 'holders_blocklist']) {
  test(`${kind} does not require the parent author to hold keys`, async () => {
    mock.chain.key_gates = { [kind]: address('99') }; mock.authorGate = address('99'); mock.blocked = false
    mock.holdsKey = false; mock.blocked = false
    assert.equal(await verdict({ parentId: 7n, author }), 'shown')
    assert.equal(mock.calls.some(c => c.method === 'key-holdings'), false)
  })
}
test('an account block still folds under an explicit post rule', async () => {
  mock.chain.key_gates = { holders: address('99') }; mock.authorGate = address('99'); mock.blocked = false
  mock.perMessageGate = mock.chain.blocking.gate; mock.blocked = true
  assert.equal(await verdict(), 'folded')
})
test('a mounted card keeps its verdict after a trade, until explicit refresh', async () => {
  const { Resource } = await load('shared/resource.svelte.ts')
  const view = new Resource()
  mock.chain.key_gates = { holders: address('99') }; mock.authorGate = address('99'); mock.blocked = false
  const reply = { parentId: 7n, author: address('88'), blockNumber: 9n }
  const first = gating.check(mock.chain, reply, author)
  view.watch(first, 'card'); await first; await Promise.resolve()
  assert.equal(view.value('card'), 'shown')
  mock.holdsKey = false
  assert.equal(await gating.check(mock.chain, reply, author), 'folded', 'a newly opened view sees the sale')
  assert.equal(view.value('card'), 'shown', 'the existing view stays put')
  const refresh = gating.check(mock.chain, reply, author)
  view.watch(refresh, 'card'); await refresh; await Promise.resolve()
  assert.equal(view.value('card'), 'folded')
})

for (const kind of ['holders', 'holders_blocklist']) {
  for (const held of [false, true]) {
    test(`${kind} leaves replies visible when holdings ${held} precede the reply`, async () => {
      mock.chain.key_gates = { [kind]: address('99') }; mock.authorGate = address('99'); mock.blocked = false
      mock.holdsKey = held; mock.blocked = false
      mock.holdingsCheckpoint.block = '8'
      await assert.rejects(verdict(), /caught up/)
      assert.equal(mock.calls.some(c => c.method === 'admission'), false)
    })
  }
  for (const block of ['9', '10']) {
    test(`${kind} can fold using holdings at checkpoint ${block} for a reply at block 9`, async () => {
      mock.chain.key_gates = { [kind]: address('99') }; mock.authorGate = address('99'); mock.blocked = false
      mock.holdsKey = false; mock.blocked = false
      mock.holdingsCheckpoint.block = block
      assert.equal(await verdict(), 'folded')
    })
  }
}

for (const checkpoint of [undefined, null, {}, { block: 'bad' }, { block: '-1' }, { block: 9 }, { block: '18446744073709551616' }]) {
  test(`an invalid holdings checkpoint leaves replies visible (${JSON.stringify(checkpoint)})`, async () => {
    mock.chain.key_gates = { holders: address('99') }; mock.authorGate = address('99'); mock.blocked = false
    mock.holdsKey = false; mock.holdingsCheckpoint = checkpoint
    await assert.rejects(verdict())
  })
}

test('concurrent replies by the same holder apply their own block requirement', async () => {
  mock.chain.key_gates = { holders: address('99') }; mock.authorGate = address('99'); mock.blocked = false
  mock.holdsKey = false; mock.holdingsCheckpoint.block = '9'
  const older = { parentId: 7n, author: address('88'), blockNumber: 9n }
  const newer = { ...older, blockNumber: 10n }
  const results = await Promise.allSettled([verdict(older), verdict(newer), verdict(newer)])
  assert.equal(results[0].value, 'folded')
  assert.deepEqual(results.slice(1).map(r => r.status), ['rejected', 'rejected'])
  const asks = mock.calls.filter(c => c.method === 'key-holdings')
  assert.equal(asks.length, 1, 'different requirements still share one HTTP batch')
  assert.equal(asks[0].pairs.length, 2, 'identical concurrent checks still deduplicate')
})

test('plain blocklist checks still deduplicate across reply blocks', async () => {
  const older = { parentId: 7n, author: address('88'), blockNumber: 9n }
  assert.deepEqual(await Promise.all([verdict(older), verdict({ ...older, blockNumber: 10n })]), ['folded', 'folded'])
  assert.equal(mock.calls.filter(c => c.memberships?.length).flatMap(c => c.memberships).length, 1)
})

test('a stale holdings verdict stays visible after catch-up until explicit refresh', async () => {
  const { Resource } = await load('shared/resource.svelte.ts')
  const view = new Resource()
  mock.chain.key_gates = { holders: address('99') }; mock.authorGate = address('99'); mock.blocked = false
  mock.holdsKey = false; mock.holdingsCheckpoint.block = '8'
  const first = verdict()
  view.watch(first, 'card'); await assert.rejects(first); await Promise.resolve()
  assert.equal(view.value('card'), null)
  mock.holdingsCheckpoint.block = '9'
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(view.value('card'), null)
  assert.equal(mock.calls.filter(c => c.method === 'key-holdings').length, 1)
  const refresh = verdict()
  view.watch(refresh, 'card'); await refresh; await Promise.resolve()
  assert.equal(view.value('card'), 'folded')
})

for (const scope of ['message', 'author']) {
  for (const blocked of [true, false]) {
    test(`${scope} tombstone retains only the current blocklist display rule when blocked=${blocked}`, async () => {
      mock.blocked = blocked
      mock.authorGate = scope === 'author' ? TOMBSTONE : address('99')
      mock.perMessageGate = scope === 'message' ? TOMBSTONE : zeroAddress
      assert.equal(await verdict(), blocked ? 'folded' : 'shown')
      assert.ok(mock.calls.some(c => c.memberships?.some(m => m.list.owner === author)))
      assert.equal(mock.calls.some(c => c.method === 'key-holdings'), false)
    })
  }
}
test('a tombstone without a published blocking setup leaves replies shown', async () => {
  mock.authorGate = TOMBSTONE
  mock.chain.blocking = null; mock.chain.blocklist = null
  assert.equal(await verdict(), 'shown')
})
test("a custom per-post gate still applies the author's blocklist", async () => {
  mock.authorGate = TOMBSTONE
  mock.perMessageGate = address('77')
  assert.equal(await verdict(), 'folded')
  assert.equal(mock.calls.some(c => c.memberships?.length), true)
})

for (const gate of [zeroAddress, address('99')]) {
  test(`blocklist display and notification filters survive unverified gate ${gate}`, async () => {
    const { readerBlocklist } = await load('features/account/blocking.ts')
    mock.chain.blocking = null; mock.chain.key_gates = null; mock.authorGate = gate
    assert.equal(await verdict(), 'folded')
    assert.deepEqual(readerBlocklist(mock.chain, author), { registry: mock.chain.blocklist.registry, owner: author, list: keccak256(new TextEncoder().encode('blocklist')) })
    mock.blocked = false
    assert.equal(await verdict(), 'shown')
  })
}

test('a missing parent supplies protection and gate state before ordinary folding', async () => {
  mock.chain.key_gates = { holders: address('99') }; mock.authorGate = address('99'); mock.blocked = false; mock.holdsKey = true
  assert.equal(await verdict(), 'shown')
  const states = mock.calls.filter((c) => c.method === 'state')
  assert.equal(states.length, 2, 'read the missing parent, then its blocklist')
  assert.deepEqual(states[0].ids, ['7'])
  assert.ok(states[1].memberships?.length)
  assert.equal(states[1].ids?.length ?? 0, 0, 'the parent read already supplied its gate')
})

test('a blocked reply folds even when its key holdings cannot be read', async () => {
  mock.chain.key_gates = { holders: address('99') }; mock.authorGate = address('99')
  mock.blocked = true; mock.holdingsError = true
  assert.equal(await verdict(), 'folded', 'the author’s list decides first')
})

test('an unreadable blocklist is reported even when the gate would show the reply', async () => {
  mock.chain.key_gates = { holders: address('99') }; mock.authorGate = address('99'); mock.blocked = false; mock.holdsKey = true
  mock.failRead = (url, ask) => url.endsWith('/state') && ask.memberships?.length > 0
  await assert.rejects(verdict(), /index unavailable/)
})

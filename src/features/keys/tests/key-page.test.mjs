import { answerCall } from './multicall.mjs'
import assert from 'node:assert/strict'
import { test, beforeEach, after } from 'node:test'
import { load, install, teardown, address, txHash, deferred } from '../../../../scripts/harness.mjs'
const { KeyPage } = await load('features/keys/key-page.svelte.ts')
const { KeyActivationReverted, KeyTransactionReverted } = await load('features/keys/account-keys.ts')
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
let saved, sequence = 0
const creator = address('11'), holder = address('22')
const account = { blockNumber: 17n, active: true, supply: 2n, holdings: 1n, fees: 5n }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
beforeEach(() => {
  install(); saved = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  } })
})
after(async () => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original)
  else delete globalThis.localStorage
  await teardown()
})
function fixture(action = 'trade', changes = {}, key = `key-test-${++sequence}`) {
  const market = { verify: async () => {}, account: async () => account,
    findReceipt: async () => null, receipt: async () => ({ blockNumber: 17n }),
    settledAccount: async () => account, ...changes }
  const view = new KeyPage(market, creator, holder, key, action)
  const stop = view.watch()
  return { view, market, key, stop() { stop?.(); view.dispose() } }
}
for (const action of ['activation', 'trade']) {
  test(`${action} reopening checks once, preserves unknown hashes, and allows clearing`, async () => {
    let checks = 0
    const f = fixture(action, { findReceipt: async (hash, kind) => {
      assert.equal(hash, txHash); assert.equal(kind, action); checks++; return null
    }, receipt: async () => { assert.fail('recovery must never poll') } })
    try {
      f.view.tracking.save(txHash); await settle()
      assert.equal(checks, 1); assert.equal(f.view.tracking.busy, false)
      assert.equal(f.view.tracking.hash, txHash)
      await f.view.send(async () => { assert.fail('pending transaction must prevent a send') })
      await f.view.clear()
      assert.equal(f.view.tracking.hash, null)
      assert.deepEqual(f.view.account.value(), account)
    } finally { f.stop() }
  })
  test(`${action} success reads receipt state and clears only its own hash`, async () => {
    const f = fixture(action, { settledAccount: async (...args) => {
      assert.deepEqual(args, [creator, 17n, holder, action]); return account
    } })
    try {
      await settle(); await f.view.send(async guard => { guard(); return txHash })
      assert.equal(f.view.tracking.hash, null)
      assert.deepEqual(f.view.account.value(), account)
      assert.equal(f.view.tracking.busy, false)
    } finally { f.stop() }
  })
  test(`${action} a reverted receipt releases tracking, but RPC errors keep it`, async () => {
    const f = fixture(action)
    try {
      await settle(); f.view.tracking.save(txHash)
      f.market.findReceipt = async () => { throw new Error('RPC down') }
      await f.view.check(); assert.equal(f.view.tracking.hash, txHash)
      f.market.findReceipt = async () => { throw action === 'trade' ? new KeyTransactionReverted() : new KeyActivationReverted() }
      await f.view.check(); assert.equal(f.view.tracking.hash, null)
      assert.equal(f.view.tracking.busy, false)
    } finally { f.stop() }
  })
  test(`${action} navigation preserves wallet prompt ownership and its late hash`, async () => {
    const prompt = deferred()
    const f = fixture(action, { receipt: async () => { throw new Error('timeout') } })
    await settle()
    const sending = f.view.send(async () => prompt.promise)
    f.stop()
    const next = fixture(action, f.market, f.key)
    try {
      await settle(); assert.equal(next.view.tracking.busy, true)
      await next.view.send(async () => { assert.fail('only one wallet prompt') })
      prompt.resolve(txHash); await sending
      assert.equal(next.view.tracking.hash, txHash)
      assert.equal(next.view.tracking.busy, false)
      assert.equal(next.view.error, '', 'unmounted failures do not change the new page')
    } finally { next.stop() }
  })
}
test('clearing requires fresh state and working storage and cannot run after navigation', async () => {
  const f = fixture(); await settle(); f.view.tracking.save(txHash)
  try {
    f.market.account = async () => { throw Error('RPC down') }
    await f.view.clear(); assert.equal(f.view.tracking.hash, txHash)
    f.market.account = async () => account
    localStorage.removeItem = () => { throw Error('storage unavailable') }
    await f.view.clear(); assert.equal(f.view.tracking.hash, txHash)
    assert.match(f.view.error, /could not clear/)
    const read = deferred(); f.market.account = () => read.promise
    const clearing = f.view.clear(); f.stop(); read.resolve(account); await clearing
    assert.equal(f.view.tracking.hash, txHash)
  } finally { f.stop() }
})
test('an unsaved hash survives navigation and refresh', async () => {
  localStorage.setItem = () => { throw Error('storage unavailable') }
  const f = fixture('trade', { receipt: async () => { throw Error('timeout') } })
  await settle(); await f.view.send(async () => txHash)
  assert.equal(f.view.tracking.saved, false); f.stop()
  const next = fixture('trade', f.market, f.key)
  try { await settle(); assert.equal(next.view.tracking.hash, txHash) }
  finally { next.stop() }
})
test('a confirmed action wins over a slower background account read', async () => {
  const old = deferred(), f = fixture('trade', { account: () => old.promise })
  try {
    await f.view.send(async () => txHash)
    assert.deepEqual(f.view.account.value(), account)
    old.resolve({ ...account, supply: 0n }); await settle()
    assert.deepEqual(f.view.account.value(), account)
  } finally { f.stop() }
})
test('a guard stops sending after navigation and a rejected prompt releases the lock', async () => {
  const f = fixture(), ready = deferred(); await settle()
  const send = f.view.send(async guard => { await ready.promise; guard(); assert.fail('must not send') })
  f.stop(); ready.resolve(); await send; assert.equal(f.view.tracking.busy, false)
  const next = fixture('trade', f.market, f.key)
  try {
    await next.view.send(async () => { throw Error('wallet rejected') })
    assert.equal(next.view.tracking.busy, false)
    assert.match(next.view.error, /wallet rejected/)
  } finally { next.stop() }
})


test('a transfer event is checked before clearing tracking or applying receipt state', async () => {
  let reads = 0
  const f = fixture('trade', { settledAccount: async () => { reads++; return account } })
  try {
    await settle()
    await f.view.send(async () => txHash, () => { throw Error('transfer event mismatch') })
    assert.equal(f.view.tracking.hash, txHash)
    assert.equal(reads, 0)
    assert.match(f.view.error, /transfer event mismatch/)
    assert.equal(f.view.phase, '')
    // A later explicit check resolves this hash's outcome from chain state.
    f.market.findReceipt = async () => ({ blockNumber: 17n })
    await f.view.check()
    assert.equal(reads, 1)
    assert.equal(f.view.tracking.hash, null)
  } finally { f.stop() }
})

for (const action of ['activation', 'trade']) {
  test(`${action} confirmation updates the page reopened during its send`, async () => {
    const receipt = deferred()
    let current = { ...account, active: action !== 'activation', holdings: 0n }
    const updated = { ...account, active: true, holdings: 2n }
    const f = fixture(action, { account: async () => current,
      receipt: async () => receipt.promise, settledAccount: async () => current })
    await settle()
    const sending = f.view.send(async () => txHash)
    await settle(); f.stop()
    const next = fixture(action, f.market, f.key)
    try {
      await settle()
      assert.equal(next.view.tracking.busy, true)
      current = updated
      receipt.resolve({ blockNumber: 17n })
      await sending; await settle()
      assert.equal(next.view.tracking.hash, null)
      assert.equal(next.view.tracking.busy, false)
      assert.deepEqual(next.view.account.value(), updated)
      assert.match(next.view.phase, action === 'activation' ? /activated/ : /confirmed/)
      assert.equal(f.view.account.value().holdings, 0n, 'the disposed page is not updated')
    } finally { next.stop() }
  })
}

test('a stalled pre-sign account read releases the lock and never sends late', async t => {
  const { guarded } = await load('lib/signer.ts')
  const stalled = deferred()
  let sent = false
  const provider = { request: async ({ method }) => {
    if (method === 'eth_accounts') return stalled.promise
    sent = true; return txHash
  } }
  const f = fixture(); await settle()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sending = f.view.send(async () => guarded(provider, holder).request({ method: 'eth_sendTransaction', params: [{}] }))
    await settle(); t.mock.timers.tick(6001); await sending
    assert.equal(f.view.tracking.busy, false)
    assert.match(f.view.error, /try again/)
    stalled.resolve([holder]); await settle()
    assert.equal(sent, false)
  } finally { t.mock.timers.reset(); f.stop() }
})

for (const action of ['activation', 'trade']) test(`${action} reverts reach a page reopened during the send`, async () => {
  const receipt = deferred()
  const first = fixture(action, { receipt: () => receipt.promise })
  await settle()
  const sending = first.view.send(async () => txHash)
  await settle(); first.stop()
  const next = fixture(action, first.market, first.key)
  try {
    await settle()
    receipt.reject(action === 'trade' ? new KeyTransactionReverted() : new KeyActivationReverted())
    await sending
    assert.equal(next.view.tracking.hash, null)
    assert.equal(next.view.tracking.busy, false)
    assert.match(next.view.error, /revert/)
    assert.equal(next.view.phase, '')
  } finally { next.stop() }
})

test('a transaction confirmed on recovery tells the page, just as a confirmed send does', async () => {
  const f = fixture('trade', { findReceipt: async () => ({ blockNumber: 17n, status: 'success' }) })
  let confirmed = 0
  const stop = f.view.onConfirmed(() => { confirmed++ })
  try {
    await settle()
    // Receipt polling failed after the send; "check transaction" finds it later.
    f.view.tracking.save(txHash)
    await f.view.check()
    assert.equal(f.view.tracking.hash, null)
    assert.equal(confirmed, 1)
    await f.view.send(async guard => { guard(); return txHash })
    assert.equal(confirmed, 2)
    stop()
    f.view.tracking.save(txHash)
    await f.view.check()
    assert.equal(confirmed, 2, 'a stopped listener hears nothing')
  } finally { f.stop() }
})

for (const action of ['activation', 'trade']) {
  test(`${action} distinguishes wallet approval, pending receipt, and confirmed balance reads`, async () => {
    const prompt = deferred(), receipt = deferred(), balances = deferred()
    const f = fixture(action, { receipt: () => receipt.promise, settledAccount: () => balances.promise })
    try {
      await settle()
      const sending = f.view.send(() => prompt.promise)
      assert.equal(f.view.phase, 'check your wallet…')
      prompt.resolve(txHash); await settle()
      assert.equal(f.view.phase, 'transaction pending…')
      receipt.resolve({ blockNumber: 17n }); await settle()
      assert.equal(f.view.phase, 'transaction confirmed. updating balances…')
      assert.equal(f.view.tracking.busy, true)
      assert.equal(f.view.tracking.hash, txHash)
      balances.resolve({ ...account, supply: 3n, holdings: 2n }); await sending
      assert.equal(f.view.account.value().holdings, 2n)
      assert.equal(f.view.tracking.busy, false)
      assert.equal(f.view.tracking.hash, null)
      assert.equal(f.view.phase, action === 'activation' ? 'account keys activated' : 'transaction confirmed')
    } finally { f.stop() }
  })
}

// Use the real market reader, replacing only the RPC boundary.
async function laggingMarket() {
  const { keyMarket } = await load('features/keys/account-keys.ts')
  const { accountKeysAbi } = await load('lib/abi/accountKeys.ts')
  const { decodeFunctionData, encodeFunctionResult } = await import('viem')
  const chain = { id: 84532, name: 'Base Sepolia', contract: address('33'), public_rpc_url: 'https://review.invalid', start_block: 0, confirmations: 2 }
  const dev = address('44')
  let head = 16n
  const blocks = []
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(init.body)
    const result = await answerCall(req, req => {
      let result
      if (req.method === 'eth_chainId') result = '0x14a34'
      else if (req.method === 'eth_getCode') result = '0x6000'
      else if (req.method === 'eth_blockNumber') result = `0x${head.toString(16)}`
      else if (req.method === 'eth_call') {
        const { functionName } = decodeFunctionData({ abi: accountKeysAbi, data: req.params[0].data })
        const block = req.params[1] === 'latest' ? head : BigInt(req.params[1])
        if (functionName === 'claimableFees') blocks.push(block)
        const values = { DEV_FUND: dev, CREATOR_FEE_BPS: 450n, DEV_FEE_BPS: 50n,
          reserveAt: 40001n * 10n ** 17n, active: true, supply: block, balanceOf: 1n,
          claimableFees: block === 16n ? 5n : block === 17n ? 10n : 20n }
        result = encodeFunctionResult({ abi: accountKeysAbi, functionName, result: values[functionName] })
      } else throw Error(`unexpected RPC ${req.method}`)
      return result
    })
    return Response.json({ jsonrpc: '2.0', id: req.id, result })
  }
  const deployment = { address: `0x${(++sequence).toString(16).padStart(40, '0')}`, devFund: dev, rpcUrl: 'https://review.invalid' }
  const create = () => keyMarket(chain, deployment)
  return { api: create(), create, blocks, setHead: n => { head = n } }
}
async function readFinished(view) {
  for (let i = 0; i < 100 && view.account.pending; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(view.account.pending, false)
}
test('refresh cannot replace confirmed fees with a lagging head', async () => {
  const rpc = await laggingMarket()
  const f = fixture('trade', rpc.api)
  let stop
  try {
    await readFinished(f.view)
    // The receipt is known at 17, but the RPC head still reports 16.
    f.market.receipt = async () => ({ blockNumber: 17n })
    await f.view.send(async () => txHash)
    assert.equal(f.view.account.value().fees, 10n)
    stop = f.view.watch()
    await readFinished(f.view)
    assert.equal(f.view.account.value().fees, 10n, `read blocks ${rpc.blocks}`)
  } finally { stop?.(); f.stop() }
})
test('recovery cannot replace newer fees with the old receipt snapshot', async () => {
  const rpc = await laggingMarket()
  rpc.setHead(18n)
  const f = fixture('trade', rpc.api)
  try {
    await readFinished(f.view)
    assert.equal(f.view.account.value().fees, 20n)
    // A saved transaction from block 17 is checked after a fresh page read at 18.
    f.view.tracking.save(txHash)
    f.market.findReceipt = async () => ({ blockNumber: 17n })
    await f.view.check()
    assert.equal(f.view.account.value().fees, 20n, `read blocks ${rpc.blocks}`)
  } finally { f.stop() }
})

test('navigation remembers the confirmed block with a fresh market reader', async () => {
  const rpc = await laggingMarket()
  const first = fixture('trade', rpc.api)
  await readFinished(first.view)
  first.market.receipt = async () => ({ blockNumber: 17n })
  await first.view.send(async () => txHash)
  first.stop()
  const next = fixture('trade', rpc.create())
  try {
    await readFinished(next.view)
    assert.equal(next.view.account.value().fees, 10n)
    assert.equal(rpc.blocks.at(-1), 17n)
  } finally { next.stop() }
})

test('an unavailable confirmed block keeps the displayed balances and the read floor', async () => {
  const rpc = await laggingMarket()
  const f = fixture('trade', rpc.api)
  let stop
  try {
    await readFinished(f.view)
    rpc.setHead(18n)
    stop = f.view.watch(); await readFinished(f.view); stop()
    const known = f.view.account.value()
    const fetch = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      if (JSON.parse(init.body).method === 'eth_call') throw Error('block unavailable')
      return fetch(_url, init)
    }
    // The receipt establishes 19 as the minimum even when its balances cannot be read.
    await assert.rejects(rpc.api.account(creator, 19n, holder), /block unavailable/)
    rpc.setHead(16n)
    stop = f.view.watch(); await readFinished(f.view)
    assert.equal(f.view.account.value(), known)
    assert.ok(f.view.account.failure())
    globalThis.fetch = fetch
    stop(); stop = f.view.watch(); await readFinished(f.view)
    assert.equal(f.view.account.value().blockNumber, 19n)
  } finally { stop?.(); f.stop() }
})

test('account read floors separate creators, holders and markets and normalize address case', async () => {
  const rpc = await laggingMarket()
  const { getAddress } = await import('viem')
  const named = address('ab'), owner = address('cd')
  await rpc.api.account(named, 19n, owner)
  assert.equal((await rpc.create().account(getAddress(named), undefined, owner)).blockNumber, 19n)
  assert.equal((await rpc.api.account(creator, undefined, owner)).blockNumber, 16n)
  assert.equal((await rpc.api.account(named, undefined, holder)).blockNumber, 16n)
  const other = await laggingMarket()
  assert.equal((await other.api.account(named, undefined, owner)).blockNumber, 16n)
})

test('a slow balance read catches up if another read advances its block', async () => {
  const rpc = await laggingMarket()
  const fetch = globalThis.fetch, released = deferred(), started = deferred()
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body)
    if (request.method === 'eth_call' && request.params[1] === '0x10') {
      started.resolve(); await released.promise
    }
    return fetch(url, init)
  }
  const slow = rpc.api.account(creator, undefined, holder)
  await started.promise
  const newer = await rpc.api.account(creator, 18n, holder)
  released.resolve()
  assert.deepEqual(await slow, newer)
})

test('a delayed confirmation cannot overwrite a newer displayed snapshot', async () => {
  const balances = deferred()
  const f = fixture('trade', { settledAccount: () => balances.promise })
  let stop
  try {
    await settle()
    const send = f.view.send(async () => txHash)
    await settle()
    const newer = { ...account, blockNumber: 19n, fees: 0n, holdings: 0n }
    f.market.account = async () => newer
    stop = f.view.watch(); await settle()
    balances.resolve(account); await send
    assert.deepEqual(f.view.account.value(), newer, 'a later claim or sale can reduce values')
    assert.equal(f.view.tracking.hash, null)
  } finally { stop?.(); f.stop() }
})


test('a receipt-specific confirmation waits for success and is never reused by a later transaction', async () => {
  const receipt = deferred(), balances = deferred()
  const f = fixture('trade', { receipt: () => receipt.promise, settledAccount: () => balances.promise })
  try {
    await settle()
    let checked = false
    const sending = f.view.send(async () => txHash, () => {
      checked = true
      return 'transferred 2 keys to alice.eth'
    })
    await settle()
    assert.equal(checked, false)
    assert.equal(f.view.phase, 'transaction pending…')
    receipt.resolve({ blockNumber: 17n }); await settle()
    assert.equal(checked, true)
    assert.equal(f.view.phase, 'transaction confirmed. updating balances…')
    balances.resolve(account); await sending
    assert.equal(f.view.phase, 'transferred 2 keys to alice.eth')
    await f.view.send(async () => txHash)
    assert.equal(f.view.phase, 'transaction confirmed', 'a later buy or claim cannot repeat the transfer message')
    f.market.receipt = async () => { throw new KeyTransactionReverted() }
    await f.view.send(async () => txHash, () => assert.fail('a reverted transfer must not be confirmed'))
    assert.equal(f.view.phase, '')
    assert.ok(f.view.error)
  } finally { f.stop() }
})


test("confirmation reports its own hash even when tracking adopts another tab's pending transaction", async () => {
  const f = fixture('trade', { findReceipt: async () => ({ blockNumber: 17n }) }), otherHash = '0x' + 'ab'.repeat(32), confirmed = []
  try {
    await settle()
    f.view.onConfirmed(hash => confirmed.push(hash))
    f.view.tracking.save(txHash)
    saved.set(f.key, JSON.stringify(otherHash))
    await f.view.check()
    assert.deepEqual(confirmed, [txHash])
    assert.equal(f.view.tracking.hash, otherHash)
  } finally { f.stop() }
})

import { answerCall } from './multicall.mjs'
import assert from 'node:assert/strict'
import { test, beforeEach, after } from 'node:test'
import { ContractFunctionExecutionError, UnknownRpcError, InternalRpcError, getContractError, multicall3Abi, decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters } from 'viem'
import { load, install, teardown, mock, address, author, txHash, renderComponent } from '../../../../scripts/harness.mjs'
const { keyDeployment, keyMarket, initialKeyAmount, tradeKeyAmount, KeyActivationReverted, KeyTransactionReverted } = await load('features/keys/account-keys.ts')
const { MAX_KEY_SUPPLY, keyReserve, keyPrice } = await load('features/keys/key-curve.ts')
const { accountKeysAbi } = await load('lib/abi/accountKeys.ts')
const { parse, href } = await load('features/navigation/router.svelte.ts')
const dev = address('33')
let marketAddress = address('77'), marketSequence = 0
let answer, chain, calls, rpcChain, active, treasury, sendingAccount, walletChain, beforeCall, ethBalance
const deployment = { address: marketAddress, devFund: dev, rpcUrl: 'https://keys.invalid' }
const quote = { curveValue: 1_000_000_000_000n, creatorFee: 45_000_000_000n, devFee: 5_000_000_000n, total: 1_050_000_000_000n }
const provider = { request: async ({ method, params }) => {
  if (method === 'eth_accounts') return [sendingAccount]
  if (method === 'eth_chainId') return `0x${walletChain.toString(16)}`
  if (method === 'eth_sendTransaction') { calls.push({ method, params }); return txHash }
  return answerCall({ method, params }, answer)
} }
beforeEach(() => {
  marketAddress = `0x${(++marketSequence).toString(16).padStart(40, '0')}`; deployment.address = marketAddress
  install(); chain = { ...mock.chain, id: 84532 }; calls = []; rpcChain = 84532; walletChain = 84532
  ethBalance = 10n ** 18n; active = false; treasury = dev; sendingAccount = author; beforeCall = () => {}
  answer = request => {
    calls.push(request)
    let result
    if (request.method === 'eth_chainId') result = `0x${rpcChain.toString(16)}`
    else if (request.method === 'eth_getBalance') result = `0x${ethBalance.toString(16)}`
    else if (request.method === 'eth_getCode') result = '0x6000'
    else if (request.method === 'eth_blockNumber') result = '0x10'
    else if (request.method === 'eth_call') {
      const { functionName, args } = decodeFunctionData({ abi: accountKeysAbi, data: request.params[0].data })
      beforeCall(functionName, request.params[1])
      const values = { DEV_FUND: treasury, CREATOR_FEE_BPS: 450n, DEV_FEE_BPS: 50n, active, supply: 0n, balanceOf: 0n, claimableFees: 0n, quoteAtSupply: quote, quoteBuy: quote, quoteTransfer: { ...quote, total: quote.creatorFee + quote.devFee }, quoteSell: { ...quote, total: quote.curveValue - quote.creatorFee - quote.devFee } }
      const value = functionName === 'reserveAt' ? args[0] === 10000n ? 40001n * 10n ** 17n : 0n : values[functionName]
      result = ['activate', 'buy', 'sell', 'transfer', 'claimFees'].includes(functionName) ? '0x' : encodeFunctionResult({ abi: accountKeysAbi, functionName, result: value })
    } else throw new Error(`unexpected RPC ${request.method}`)
    return result
  }
  globalThis.fetch = async (_, init) => {
    const request = JSON.parse(init.body)
    return Response.json({ jsonrpc: '2.0', id: request.id, result: await answerCall(request, answer) })
  }
})
after(teardown)

test('rollout requires a supported chain and valid configuration', () => {
  const env = { VITE_ACCOUNT_KEYS_ADDRESS: marketAddress, VITE_ACCOUNT_KEYS_DEV_FUND: dev }
  for (const id of [8453, 84532]) {
    const public_rpc_url = `https://rpc-${id}.invalid/`
    const configured = keyDeployment({ ...chain, id, public_rpc_url }, env)
    assert.equal(configured.address.toLowerCase(), marketAddress)
    assert.equal(configured.rpcUrl, public_rpc_url)
  }
  for (const id of [1, 11155111]) assert.equal(keyDeployment({ ...chain, id }, env), null)
  assert.equal(keyDeployment(chain, {}), null)
  assert.equal(keyDeployment(chain, { ...env, VITE_ACCOUNT_KEYS_ADDRESS: address('00') }), null)
  assert.equal(keyDeployment({ ...chain, public_rpc_url: 'file:///tmp/rpc' }, env), null)
  assert.throws(() => keyMarket({ ...chain, id: 1 }, deployment), /only available on Base and Base Sepolia/)
})
test('Base verifies its own RPC and refuses a wallet on Sepolia before sending', async () => {
  chain = { ...chain, id: 8453 }
  rpcChain = 8453; walletChain = 8453
  const api = keyMarket(chain, deployment)
  await api.verify()
  assert.equal(await api.activate(provider, author, 1n, quote), txHash)
  calls.length = 0
  walletChain = 84532
  await assert.rejects(api.claim(provider, author, author), /chain|network/i)
  assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
  rpcChain = 84532
  await assert.rejects(api.verify(), /wrong chain/)
})
test('initial purchase accepts only bounded whole quantities', () => {
  for (const amount of [0n, 100n, 101n, 1000n, MAX_KEY_SUPPLY]) assert.equal(initialKeyAmount(String(amount)), amount)
  for (const bad of ['', '-1', '1.1', '1e2', String(MAX_KEY_SUPPLY + 1n), '01', '1 2', 'NaN', '9007199254740993']) assert.throws(() => initialKeyAmount(bad))
})
test('quantities trim surrounding whitespace without loosening integer or supply validation', () => {
  for (const text of [' 2 ', '\t2\n', '\u00a02\u00a0']) {
    assert.equal(initialKeyAmount(text), 2n)
    assert.equal(tradeKeyAmount(text), 2n)
  }
  assert.equal(initialKeyAmount(' 0 '), 0n)
  assert.throws(() => tradeKeyAmount(' 0 '), /choose at least one key/)
  assert.equal(tradeKeyAmount(` ${MAX_KEY_SUPPLY} `), MAX_KEY_SUPPLY)
  for (const text of ['   ', ' 1 2 ', ' -1 ', ' 1.5 ', ' 01 ', ` ${MAX_KEY_SUPPLY + 1n} `]) {
    assert.throws(() => initialKeyAmount(text), /enter a whole number of keys/)
    assert.throws(() => tradeKeyAmount(text), /enter a whole number of keys/)
  }
})
test('key route preserves its chain independently of the feed selector', () => {
  assert.deepEqual(parse(href.keys(84532)), { kind: 'keys', chainId: 84532 })
  for (const bad of ['#/keys/0', '#/keys/84532?extra', '#/keys/9007199254740993']) assert.equal(parse(bad).kind, 'unknown')
})
test('unconfigured and unsupported pages do not read RPCs', async () => {
  assert.match(await renderComponent('features/keys/AccountKeys.svelte', { chain }), /not configured yet/)
  assert.match(await renderComponent('features/keys/AccountKeys.svelte', { chain: { ...chain, id: 1 } }), /available on Base and Base Sepolia/)
  assert.equal(calls.length, 0)
})
test('the about page renders on its own, without the market or any RPC read', async () => {
  const page = await renderComponent('features/keys/AccountKeysAbout.svelte', { chain })
  assert.match(page, /<h2 class="about-title[^"]*">account keys<\/h2>/)
  assert.match(page, /class="keys-banner/)
  assert.match(page, /back to account keys/)
  assert.equal(calls.length, 0)
})
test('deployment checks and account reads use the intended chain and one block', async () => {
  const api = keyMarket(chain, deployment)
  await api.verify()
  assert.deepEqual(await api.account(author), { blockNumber: 16n, active: false, supply: 0n, holdings: 0n, fees: 0n })
  const reads = calls.filter(c => c.method === 'eth_call' && ['active', 'supply', 'balanceOf', 'claimableFees'].includes(decodeFunctionData({ abi: accountKeysAbi, data: c.params[0].data }).functionName))
  assert.ok(reads.every(c => c.params[1] === '0x10'))
  treasury = address('99'); await assert.rejects(api.verify(), /does not match/)
  rpcChain = 8453; await assert.rejects(api.verify(), /wrong chain/)
})
test('zero-key quote requires no ETH; purchases include both fees', async () => {
  const api = keyMarket(chain, deployment)
  assert.deepEqual((await api.quote(0n)).quote, { curveValue: 0n, creatorFee: 0n, devFee: 0n, total: 0n })
  assert.equal((await api.quote(1n)).quote.total, quote.total)
  assert.equal((await api.quote(1000n)).quote.total, quote.total)
  await assert.rejects(api.quote(MAX_KEY_SUPPLY + 1n), /whole number/)
})
test('activation sends the reviewed amount to the configured market', async () => {
  const api = keyMarket(chain, deployment)
  assert.equal(await api.activate(provider, author, 1000n, quote), txHash)
  const send = calls.find(c => c.method === 'eth_sendTransaction').params[0]
  assert.equal(send.to.toLowerCase(), marketAddress); assert.equal(send.from.toLowerCase(), author)
  assert.equal(BigInt(send.value), quote.total)
  const decoded = decodeFunctionData({ abi: accountKeysAbi, data: send.data })
  assert.equal(decoded.functionName, 'activate'); assert.equal(decoded.args[0], 1000n); assert.equal(decoded.args[1], quote.total)
})
test('active accounts, stale quotes and wallet switches cannot send', async () => {
  const api = keyMarket(chain, deployment)
  active = true; await assert.rejects(api.activate(provider, author, 1n, quote), /already active/)
  active = false; await assert.rejects(api.activate(provider, author, 1n, { ...quote, total: 0n }), /quote changed/)
  beforeCall = name => { if (name === 'activate') sendingAccount = address('88') }
  await assert.rejects(api.activate(provider, author, 1n, quote), /different account/)
  beforeCall = name => { if (name === 'activate') walletChain = 8453 }; sendingAccount = author
  await assert.rejects(api.activate(provider, author, 1n, quote), /chain|network/i)
  assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
})

test('post-confirmation account reads use the receipt block even when the RPC head lags', async () => {
  beforeCall = (name, block) => { if (name === 'active') active = block === '0x11' }
  const result = await keyMarket(chain, deployment).account(author, 17n)
  assert.equal(result.active, true)
  assert.ok(!calls.some(c => c.method === 'eth_blockNumber'))
  assert.ok(calls.filter(c => c.method === 'eth_call').every(c => c.params[1] === '0x11'))
})

test('confirmed activation retries state reads automatically', async () => {
  let attempts = 0
  beforeCall = name => {
    if (name !== 'active') return
    attempts++
    if (attempts === 1) throw new Error('block not available yet')
    active = attempts >= 3
  }
  assert.equal((await keyMarket(chain, deployment).settledAccount(author, 17n, author, 'activation')).active, true)
  assert.equal(attempts, 3)
  assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
})
test('confirmed activation stops retrying and preserves a clear recovery message', async () => {
  await assert.rejects(keyMarket(chain, deployment).settledAccount(author, 17n, author, 'activation'), /transaction is confirmed.*check the transaction again/)
  assert.equal(calls.filter(c => c.method === 'eth_call' && decodeFunctionData({ abi: accountKeysAbi, data: c.params[0].data }).functionName === 'active').length, 6)
})

test('profile activation lookup reads only the viewed account status', async () => {
  const api = keyMarket(chain, deployment)
  assert.equal(await api.isActive(author), false)
  active = true
  const other = address('88')
  assert.equal(await api.isActive(other), true)
  assert.equal(calls.length, 2)
  const decoded = decodeFunctionData({ abi: accountKeysAbi, data: calls[1].params[0].data })
  assert.equal(decoded.functionName, 'active')
  assert.equal(decoded.args[0].toLowerCase(), other)
})

test('trade quantities exclude zero and viewer holdings are read for the viewer', async () => {
  assert.throws(() => tradeKeyAmount('0'))
  assert.throws(() => tradeKeyAmount(String(MAX_KEY_SUPPLY + 1n)))
  assert.equal(tradeKeyAmount(String(MAX_KEY_SUPPLY)), MAX_KEY_SUPPLY)
  assert.equal(tradeKeyAmount('100'), 100n)
  const viewer = address('88')
  await keyMarket(chain, deployment).account(author, 17n, viewer)
  const read = calls.filter(c => c.method === 'eth_call').map(c => decodeFunctionData({ abi: accountKeysAbi, data: c.params[0].data })).find(c => c.functionName === 'balanceOf')
  assert.deepEqual(read.args.map(a => a.toLowerCase()), [author, viewer])
})
test('buy and sell preserve reviewed payment bounds and pay the correct market', async () => {
  const api = keyMarket(chain, deployment), creator = address('88')
  for (const side of ['buy', 'sell']) {
    const q = await api.tradeQuote(creator, side, 1000n)
    await api.trade(provider, author, creator, side, 1000n, q.total)
    const send = calls.filter(c => c.method === 'eth_sendTransaction').at(-1).params[0]
    const decoded = decodeFunctionData({ abi: accountKeysAbi, data: send.data })
    assert.equal(decoded.functionName, side)
    assert.equal(decoded.args[0].toLowerCase(), creator)
    assert.equal(decoded.args[1], 1000n)
    assert.equal(decoded.args[2], q.total)
    assert.ok(decoded.args[3] > BigInt(Math.floor(Date.now() / 1000)))
    assert.equal(BigInt(send.value ?? '0x0'), side === 'buy' ? q.total : 0n)
    assert.equal(send.to.toLowerCase(), marketAddress)
  }
})
test('adverse quote changes and wallet or view changes never send a trade', async () => {
  const api = keyMarket(chain, deployment)
  await assert.rejects(api.trade(provider, author, author, 'buy', 1n, 0n), /price changed/)
  await assert.rejects(api.trade(provider, author, author, 'sell', 1n, quote.total), /price changed/)
  beforeCall = name => { if (name === 'buy') sendingAccount = address('88') }
  await assert.rejects(api.trade(provider, author, author, 'buy', 1n, quote.total), /different account/)
  sendingAccount = author; beforeCall = name => { if (name === 'buy') walletChain = 8453 }
  await assert.rejects(api.trade(provider, author, author, 'buy', 1n, quote.total), /chain|network/i)
  walletChain = 84532; beforeCall = () => {}
  await assert.rejects(api.trade(provider, author, author, 'buy', 1n, quote.total, () => { throw new Error('view changed') }), /view changed/)
  assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
})
test('claims pay the creator address and confirmed reads remain pinned to the receipt block', async () => {
  const api = keyMarket(chain, deployment), creator = address('88')
  await api.claim(provider, author, creator)
  const send = calls.find(c => c.method === 'eth_sendTransaction').params[0]
  const decoded = decodeFunctionData({ abi: accountKeysAbi, data: send.data })
  assert.equal(decoded.functionName, 'claimFees')
  assert.equal(decoded.args[0].toLowerCase(), creator)
  calls.length = 0
  await api.settledAccount(creator, 17n, author)
  assert.ok(calls.every(c => c.method === 'eth_call' && c.params[1] === '0x11'))
})

test('a page left during the final wallet network check cannot submit a transaction', async () => {
  let present = true
  const delayedWallet = { request: async args => {
    const result = await provider.request(args)
    if (args.method === 'eth_chainId') present = false
    return result
  } }
  await assert.rejects(keyMarket(chain, deployment).trade(delayedWallet, author, author, 'buy', 1n, quote.total,
    () => { if (!present) throw new Error('page left') }), /page left/)
  assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
})

test('zero-key activation quotes need no RPC and paid quotes read only their total', async () => {
  const api = keyMarket(chain, deployment)
  assert.equal((await api.quote(0n)).quote.total, 0n)
  assert.equal(calls.length, 0)
  await api.quote(2n)
  assert.equal(calls.length, 1)
  assert.equal(decodeFunctionData({ abi: accountKeysAbi, data: calls[0].params[0].data }).functionName, 'quoteAtSupply')
})

test('remote market RPCs require HTTPS while local development may use HTTP', () => {
  const env = { VITE_ACCOUNT_KEYS_ADDRESS: marketAddress, VITE_ACCOUNT_KEYS_DEV_FUND: dev }
  for (const url of ['http://keys.invalid', 'http://localhost.evil.invalid', 'ftp://localhost']) {
    assert.equal(keyDeployment({ ...chain, public_rpc_url: url }, env), null)
  }
  for (const url of ['https://keys.invalid', 'http://localhost:8545', 'http://127.0.0.1:8545', 'http://[::1]:8545']) {
    assert.ok(keyDeployment({ ...chain, public_rpc_url: url }, env))
  }
})


test('saved trades use one receipt lookup without starting a confirmation poll', async () => {
  let result = null
  globalThis.fetch = async (_, init) => {
    const request = JSON.parse(init.body)
    calls.push(request)
    assert.equal(request.method, 'eth_getTransactionReceipt')
    assert.deepEqual(request.params, [txHash])
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  }
  const api = keyMarket(chain, deployment)
  assert.equal(await api.findReceipt(txHash), null)
  assert.equal(calls.length, 1, 'no polling or transaction lookup for a missing receipt')
  result = { transactionHash: txHash, transactionIndex: '0x0', blockHash: txHash, blockNumber: '0x11',
    from: author, to: marketAddress, cumulativeGasUsed: '0x100', gasUsed: '0x100', effectiveGasPrice: '0x1',
    contractAddress: null, logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2' }
  const receipt = await api.findReceipt(txHash)
  assert.equal(receipt.blockNumber, 17n)
  assert.equal(receipt.status, 'success')
  assert.equal(calls.length, 2)
  result.status = '0x0'
  await assert.rejects(api.findReceipt(txHash), KeyTransactionReverted)
  assert.equal(calls.length, 3)
  await assert.rejects(api.findReceipt(txHash, 'activation'), KeyActivationReverted)
  result = null
  assert.equal(await api.findReceipt(txHash, 'activation'), null)
  assert.equal(calls.length, 5, 'activation recovery also performs one lookup per check')
})

test('receipt RPC failures remain errors rather than implying a dropped trade', async () => {
  globalThis.fetch = async (_, init) => {
    const request = JSON.parse(init.body)
    calls.push(request)
    return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'upstream unavailable' } })
  }
  await assert.rejects(keyMarket(chain, deployment).findReceipt(txHash), /upstream unavailable/)
  assert.equal(calls.length, 1, 'the quick lookup does not retry or poll on failure')
})


test('display curve matches contract prices and the reserve anchor', () => {
  assert.equal(keyReserve(0n), 0n)
  assert.equal(keyReserve(10000n), 40001n * 10n ** 17n)
  for (const [n, price] of [
    [1n, 400000000000n], [2n, 1862741699796n], [10n, 29291106406735n],
    [100n, 992512515672072n], [2500n, 124962502500125016n], [10000n, 999925001250015626n],
  ]) assert.equal(keyPrice(n), price + 10_000_000_000_000n)
  for (const bad of [-1n, MAX_KEY_SUPPLY + 1n]) assert.throws(() => keyReserve(bad))
  for (const bad of [-1n, 0n, MAX_KEY_SUPPLY + 1n]) assert.throws(() => keyPrice(bad))
})

test('display reserves use the integer square root through the supply bound', () => {
  const supplies = [0n, 1n, 2n, 3n, 99n, 100n, 101n, 10000n, MAX_KEY_SUPPLY - 1n, MAX_KEY_SUPPLY]
  let seed = 123456n
  for (let i = 0; i < 100; i++) {
    seed = (1664525n * seed + 1013904223n) & MAX_KEY_SUPPLY
    supplies.push(seed)
  }
  for (const supply of supplies) {
    const reserve = keyReserve(supply) - 10_000_000_000_000n * supply, radicand = 160000000000000000000000n * supply ** 5n
    assert.ok(reserve ** 2n <= radicand)
    assert.ok((reserve + 1n) ** 2n > radicand)
    if (supply > 1n) assert.ok(keyPrice(supply) > keyPrice(supply - 1n))
  }
})


test('a reverted transaction gives advice that also applies to fee claims', () => {
  const error = new KeyTransactionReverted()
  assert.match(error.message, /check its details in your wallet/)
  assert.doesNotMatch(error.message, /quote/)
})


test('display verification shares success across pages but isolates configuration and retries failures', async () => {
  const cfg = { ...deployment, rpcUrl: 'https://cached-keys.invalid' }
  const first = keyMarket(chain, cfg), second = keyMarket(chain, cfg)
  await Promise.all([first.verify({ cached: true }), second.verify({ cached: true })])
  assert.equal(calls.length, 6)
  await second.verify({ cached: true }); assert.equal(calls.length, 6)
  await keyMarket(chain, { ...cfg, rpcUrl: 'https://other-keys.invalid' }).verify({ cached: true })
  assert.equal(calls.length, 12, 'another RPC must be checked')
  await keyMarket(chain, { ...cfg, address: address('78') }).verify({ cached: true })
  assert.equal(calls.length, 18, 'another market must be checked')
  await assert.rejects(keyMarket(chain, { ...cfg, devFund: address('99') }).verify({ cached: true }), /does not match/)
  assert.equal(calls.length, 24, 'another expected treasury must be checked')
  treasury = address('99')
  await assert.rejects(first.verify(), /does not match/)
  assert.equal(calls.length, 30, 'fresh checks do not reuse display verification')
  assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
  treasury = dev
  await first.verify({ cached: true }); assert.equal(calls.length, 36, 'failed checks are retryable and invalidate earlier success')
})


test('signing checks the wallet RPC even after successful public display verification', async () => {
  const api = keyMarket(chain, { ...deployment, rpcUrl: 'https://preflight-keys.invalid' })
  await api.verify({ cached: true })
  const count = calls.length
  globalThis.fetch = async () => { throw new Error('public RPC must not be used') }
  treasury = address('99')
  await assert.rejects(api.claim(provider, author, author), /does not match/)
  assert.equal(calls.length, count + 5)
  assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
  treasury = dev
  assert.equal(await api.claim(provider, author, author), txHash)
})

test('pending key receipts back off, stop at two minutes, and never scan blocks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const times = []
  globalThis.fetch = async (_, init) => {
    const request = JSON.parse(init.body)
    assert.equal(request.method, 'eth_getTransactionReceipt')
    times.push(Date.now())
    return Response.json({ jsonrpc: '2.0', id: request.id, result: null })
  }
  const waiting = assert.rejects(keyMarket(chain, deployment).receipt(txHash), /has not landed yet/)
  const flush = () => new Promise(resolve => setImmediate(resolve))
  await flush()
  for (let n = 0; n < 120; n++) { t.mock.timers.tick(1000); await flush() }
  await waiting
  assert.deepEqual(times.slice(0, 5), [0, 2000, 4000, 6000, 9000])
  assert.ok(times.length <= 16, `only ${times.length} receipt reads in two minutes`)
  const count = times.length
  t.mock.timers.tick(60_000); await flush()
  assert.equal(times.length, count)
})


test('transfer pays only the reviewed fee and binds recipient, quantity and deadline', async () => {
  const api = keyMarket(chain, deployment), to = address('88')
  const fee = quote.creatorFee + quote.devFee
  assert.equal((await api.tradeQuote(author, 'transfer', 3n)).total, fee)
  await api.transfer(provider, author, author, to, 3n, fee)
  const quoteReads = calls.filter(c => c.method === 'eth_call')
    .map(c => decodeFunctionData({ abi: accountKeysAbi, data: c.params[0].data }).functionName)
    .filter(name => name.startsWith('quote'))
  assert.deepEqual(quoteReads, ['quoteTransfer', 'quoteTransfer'], 'display and signing both read transfer fees')
  const send = calls.find(c => c.method === 'eth_sendTransaction').params[0]
  const decoded = decodeFunctionData({ abi: accountKeysAbi, data: send.data })
  assert.equal(decoded.functionName, 'transfer')
  assert.deepEqual(decoded.args.slice(0, 4).map(v => typeof v === 'string' ? v.toLowerCase() : v), [author, to, 3n, fee])
  assert.equal(BigInt(send.value), fee)
  const seconds = decoded.args[4] - BigInt(Math.floor(Date.now() / 1000))
  assert.ok(seconds >= 1198n && seconds <= 1200n)
})

test('invalid transfer recipients, stale fees and changed wallets cannot send', async () => {
  const api = keyMarket(chain, deployment), fee = quote.creatorFee + quote.devFee, to = address('88')
  for (const recipient of ['', 'name.eth', address('00'), author, marketAddress]) {
    await assert.rejects(api.transfer(provider, author, author, recipient, 1n, fee), /recipient/)
  }
  await assert.rejects(api.transfer(provider, author, author, to, 1n, fee - 1n), /fee changed/)
  await assert.rejects(api.transfer(provider, author, author, to, 0n, fee), /choose at least one key/)
  beforeCall = name => { if (name === 'transfer') sendingAccount = to }
  await assert.rejects(api.transfer(provider, author, author, to, 1n, fee), /different account/)
  sendingAccount = author
  beforeCall = name => { if (name === 'transfer') walletChain = 8453 }
  await assert.rejects(api.transfer(provider, author, author, to, 1n, fee), /chain|network/i)
  walletChain = 84532; beforeCall = () => {}
  await assert.rejects(api.transfer(provider, author, author, to, 1n, fee, () => { throw new Error('view changed') }), /view changed/)
  assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
})

test('transfer confirmation requires the correct market and all balance-moving fields', () => {
  const api = keyMarket(chain, deployment), to = address('88')
  const log = { address: marketAddress,
    topics: encodeEventTopics({ abi: accountKeysAbi, eventName: 'KeysTransferred', args: { creator: author, from: author, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [3n, 100n, 4n, 0n]) }
  api.confirmTransfer({ logs: [log] }, author, author, to, 3n)
  for (const args of [[to, author, to, 3n], [author, to, to, 3n], [author, author, author, 3n], [author, author, to, 2n]]) {
    assert.throws(() => api.confirmTransfer({ logs: [log] }, ...args), /does not confirm/)
  }
  for (const logs of [[], [{ ...log, address: to }], [{ ...log, data: '0x' }]]) {
    assert.throws(() => api.confirmTransfer({ logs }, author, author, to, 3n), /does not confirm/)
  }
})

test('unsupported wallet reads fall back for transfer preflight but the wallet alone sends', async () => {
  const fee = quote.creatorFee + quote.devFee
  let publicCalls = 0, sends = 0
  const fetch = globalThis.fetch
  globalThis.fetch = async (...args) => { publicCalls++; return fetch(...args) }
  const limited = { request: async args => {
    if (['eth_chainId', 'eth_accounts', 'eth_sendTransaction'].includes(args.method)) {
      if (args.method === 'eth_sendTransaction') sends++
      return provider.request(args)
    }
    throw Object.assign(new Error('read unsupported'), { code: 4200 })
  } }
  const api = keyMarket(chain, deployment)
  assert.equal(await api.transfer(limited, author, author, address('88'), 1n, fee), txHash)
  assert.ok(publicCalls > 0)
  assert.equal(sends, 1)
  assert.equal(calls.filter(c => c.method === 'eth_sendTransaction').length, 1)
})

test('receipt polling reselects the endpoint after a wallet network change', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const { wallet } = await load('lib/wallet.svelte.ts')
  let walletReceipts = 0, publicReceipts = 0
  wallet.account = author; wallet.chainId = chain.id
  wallet.provider = { request: async ({ method }) => {
    if (method === 'eth_chainId') return '0x14a34'
    assert.equal(method, 'eth_getTransactionReceipt'); walletReceipts++; return null
  } }
  globalThis.fetch = async (_, init) => {
    const request = JSON.parse(init.body)
    assert.equal(request.method, 'eth_getTransactionReceipt'); publicReceipts++
    return Response.json({ jsonrpc: '2.0', id: request.id, result: {
      transactionHash: txHash, transactionIndex: '0x0', blockHash: txHash, blockNumber: '0x11',
      from: author, to: marketAddress, cumulativeGasUsed: '0x100', gasUsed: '0x100', effectiveGasPrice: '0x1',
      contractAddress: null, logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2',
    } })
  }
  try {
    const waiting = keyMarket(chain, deployment).receipt(txHash, 'trade')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(walletReceipts, 1)
    wallet.chainId = 8453
    t.mock.timers.tick(2000)
    assert.equal((await waiting).blockNumber, 17n)
    assert.equal(walletReceipts, 1); assert.equal(publicReceipts, 1)
  } finally { wallet.provider = undefined; wallet.account = null; wallet.chainId = null }
})


test('the final network read times out without sending after a late answer', async t => {
  let accountChecked = false, arrived, release
  const reached = new Promise(resolve => { arrived = resolve })
  const late = new Promise(resolve => { release = resolve })
  const slow = { request: async args => {
    if (args.method === 'eth_accounts') accountChecked = true
    if (args.method === 'eth_chainId' && accountChecked) { arrived(); return late }
    return provider.request(args)
  } }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sending = keyMarket(chain, deployment).activate(slow, author, 1n, quote)
    const rejected = assert.rejects(sending, /network check timed out/)
    await reached
    t.mock.timers.tick(6001)
    await rejected
    release('0x14a34')
    for (let i = 0; i < 20; i++) await Promise.resolve()
    assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
  } finally { t.mock.timers.reset() }
})

test('exact reviewed quotes reach the signed call and payment unchanged', async () => {
  const api = keyMarket(chain, deployment)
  for (const side of ['buy', 'sell', 'transfer']) {
    const reviewed = await api.tradeQuote(author, side, 1n)
    const limit = reviewed.total
    if (side === 'transfer') await api.transfer(provider, author, author, address('99'), 1n, limit)
    else await api.trade(provider, author, author, side, 1n, limit)
    const sent = calls.filter(c => c.method === 'eth_sendTransaction').at(-1).params[0]
    const decoded = decodeFunctionData({ abi: accountKeysAbi, data: sent.data })
    assert.equal(decoded.args[side === 'transfer' ? 3 : 2], limit)
    if (side !== 'sell') assert.equal(BigInt(sent.value), limit)
  }
})
test('key failures explain price limits and funding without suggesting sponsorship', async () => {
  const { explainKeyError } = await load('lib/errors.ts')
  assert.match(explainKeyError({ cause: { data: { errorName: 'Slippage' } } }), /beyond your limit/)
  assert.match(explainKeyError(new Error('insufficient funds')), /transaction and the network fee/)
  assert.doesNotMatch(explainKeyError(new Error('insufficient funds')), /sponsor/)
})


test('a wallet timeout is distinct from a network outage in key actions', async () => {
  const { explainKeyError } = await load('lib/errors.ts')
  assert.match(explainKeyError({ cause: new Error('the wallet read timed out') }), /wallet did not answer/)
  assert.doesNotMatch(explainKeyError(new Error('insufficient funds')), /fewer keys|sponsor/)
})

test('posting and moderation explain wallet timeouts consistently with key trades', async () => {
  const { explain, explainKeyError } = await load('lib/errors.ts')
  for (const error of [new Error('the wallet network check timed out'), { cause: new Error('the wallet RPC timed out') }]) {
    assert.match(explain(error), /wallet did not answer/)
    assert.equal(explain(error), explainKeyError(error))
  }
  assert.match(explain(new Error('HTTP request failed')), /connection/)
})

for (const action of ['activate', 'buy', 'transfer']) {
  test(`${action} checks the full ETH payment before asking the wallet and reads again on retry`, async () => {
    const api = keyMarket(chain, deployment)
    const payment = action === 'transfer' ? quote.creatorFee + quote.devFee : quote.total
    const send = () => action === 'activate' ? api.activate(provider, author, 1n, quote)
      : action === 'buy' ? api.trade(provider, author, address('88'), 'buy', 1n, payment)
      : api.transfer(provider, author, address('88'), address('99'), 1n, payment)
    ethBalance = payment - 1n
    await assert.rejects(send(), /not enough ETH for this payment/)
    assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
    ethBalance = payment
    assert.equal(await send(), txHash, 'exact payment is enough when the wallet can sponsor gas')
    assert.deepEqual(calls.filter(c => c.method === 'eth_getBalance').map(c => c.params), [[author, 'latest'], [author, 'latest']])
    ethBalance = 0n
    await assert.rejects(send(), /not enough ETH for this payment/)
    assert.equal(calls.filter(c => c.method === 'eth_sendTransaction').length, 1)
  })
}

test('gas-only key actions do not require an ETH balance', async () => {
  ethBalance = 0n
  const api = keyMarket(chain, deployment)
  await api.activate(provider, author, 0n, { curveValue: 0n, creatorFee: 0n, devFee: 0n, total: 0n })
  await api.trade(provider, author, address('88'), 'sell', 1n, 0n)
  await api.claim(provider, author, author)
  assert.equal(calls.filter(c => c.method === 'eth_sendTransaction').length, 3)
  assert.ok(!calls.some(c => c.method === 'eth_getBalance'))
})

test('an unavailable ETH balance never opens a payment approval', async () => {
  const prior = answer
  answer = request => {
    if (request.method === 'eth_getBalance') throw new Error('balance read unavailable')
    return prior(request)
  }
  await assert.rejects(keyMarket(chain, deployment).trade(provider, author, address('88'), 'buy', 1n, quote.total), /balance read unavailable/)
  assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
})


test('a named transfer sends the reviewed address without resolving again during signing', async () => {
  const { resolveRecipient } = await load('features/keys/recipient.ts')
  const rpcFetch = globalThis.fetch
  let nameReads = 0, destination = address('88')
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('/api/names/resolve/')) {
      nameReads++
      return Response.json({ name: 'alice.eth', address: destination })
    }
    return rpcFetch(url, init)
  }
  const reviewed = await resolveRecipient('alice.eth')
  destination = address('99')
  const api = keyMarket(chain, deployment)
  await api.transfer(provider, author, author, reviewed.address, 1n, quote.creatorFee + quote.devFee)
  const send = calls.find(c => c.method === 'eth_sendTransaction').params[0]
  const decoded = decodeFunctionData({ abi: accountKeysAbi, data: send.data })
  assert.equal(decoded.args[1].toLowerCase(), address('88'))
  assert.equal(nameReads, 1)
})

test('the price chart places supply now and after the chosen trade, and clamps at the ends', async () => {
  const { keyCurveChart, MAX_KEY_SUPPLY } = await load('features/keys/key-curve.ts')
  const buy = keyCurveChart(10n, 'buy', 5)
  assert.deepEqual([buy.supply, buy.after, buy.max], [10, 15, 23], 'the axis runs half again past the larger end, at least to 20')
  assert.ok(buy.path.startsWith('M24,148 '), 'the curve starts at zero keys and zero price')
  assert.equal(buy.x, 24 + 10 / 23 * 552)
  assert.ok(buy.endY < buy.y, 'a purchase moves up the curve')
  assert.equal(keyCurveChart(3n, 'sell', 9).after, 0, 'a sale cannot go below no keys')
  assert.equal(keyCurveChart(7n, 'transfer', 4).after, 7, 'a transfer leaves supply where it is')
  assert.equal(keyCurveChart(MAX_KEY_SUPPLY, 'buy', 1).max, Number(MAX_KEY_SUPPLY), 'the axis never passes the supply limit')
})


test('opening a market stays below the public RPC burst limit', async () => {
  const upstream = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (url, init) => {
    if (++requests > 8) return Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body).id,
      error: { code: -32016, message: 'over rate limit' } }, { status: 429 })
    return upstream(url, init)
  }
  const api = keyMarket({ ...chain, id: 8453 }, deployment)
  rpcChain = 8453
  await api.verify()
  assert.equal((await api.account(author)).active, false)
  assert.equal(requests, 5, 'chain, code, deployment values, head and account values')
})


test('unknown key batch failures explain recovery without hiding specific errors', async () => {
  const { explainKeyError } = await load('lib/errors.ts')
  const batchError = cause => new ContractFunctionExecutionError(cause, {
    abi: multicall3Abi, functionName: 'aggregate3', args: [[]],
  })
  assert.equal(explainKeyError(batchError(new Error('upstream unavailable'))),
    'could not read account keys. refresh the page to try again · upstream unavailable')
  assert.match(explainKeyError(batchError(new Error('the wallet RPC timed out'))), /wallet did not answer/)
  assert.match(explainKeyError(batchError(Object.assign(new Error('disconnected'), { code: 4900 }))), /wallet is disconnected/)
  assert.match(explainKeyError(batchError(Object.assign(new Error('reverted'), { data: { errorName: 'Slippage' } }))), /price moved/)
})


test('unknown wallet errors retain the original code and message through viem wrappers', async () => {
  const { explain, explainKeyError } = await load('lib/errors.ts')
  const original = Object.assign(new Error('backend temporarily unavailable'), { code: 12345 })
  const wrapped = new UnknownRpcError(original)
  assert.equal(wrapped.code, -1, 'viem replaces an unfamiliar provider code on its wrapper')
  for (const format of [explain, explainKeyError]) {
    assert.match(format(wrapped), /RPC code 12345/)
    assert.match(format(wrapped), /backend temporarily unavailable/)
    assert.doesNotMatch(format(wrapped), /code -1/)
  }
  const batch = new ContractFunctionExecutionError(wrapped, {
    abi: multicall3Abi, functionName: 'aggregate3', args: [[]],
  })
  assert.match(explainKeyError(batch), /could not complete the wallet RPC request/)
  assert.match(explainKeyError(batch), /RPC code 12345/)
  assert.match(explainKeyError(batch), /backend temporarily unavailable/)
  assert.match(explain(new UnknownRpcError(Object.assign(new Error('disconnected'), { code: 4900 }))), /wallet is disconnected/)
  assert.match(explain({ code: 4001, cause: { code: -32603 } }), /you rejected the request/)
})

test('wallet diagnostics omit URLs and request dumps and bound untrusted messages', async () => {
  const { explainKeyError } = await load('lib/errors.ts')
  const error = new UnknownRpcError(Object.assign(new Error(
    'backend rejected https://rpc.example/private-secret?token=hidden\nRequest body: secret calldata'), { code: 12345 }))
  const text = explainKeyError(error)
  assert.match(text, /RPC code 12345/)
  assert.match(text, /backend rejected/)
  assert.doesNotMatch(text, /private-secret|token=hidden|calldata|rpc.example/)
  assert.ok(explainKeyError(new UnknownRpcError(new Error('x'.repeat(10_000)))).length < 400)
  const cycle = new UnknownRpcError(new Error('backend error'))
  cycle.cause = cycle
  assert.doesNotThrow(() => explainKeyError(cycle))
  assert.doesNotMatch(explainKeyError(cycle), /code -1/)
})


test('internal RPC errors labelled as contract reverts still show the provider code', async () => {
  const { explainKeyError } = await load('lib/errors.ts')
  const providerError = Object.assign(new Error('Internal error'), { code: -32603 })
  const error = getContractError(new InternalRpcError(providerError), {
    abi: multicall3Abi, functionName: 'aggregate3', args: [[]],
  })
  assert.equal(error.shortMessage,
    'The contract function "aggregate3" reverted with the following reason:\nInternal error')
  assert.match(explainKeyError(error), /RPC code -32603/)
  assert.match(explainKeyError(error), /Internal error/)
  assert.equal((explainKeyError(error).match(/RPC code/g) ?? []).length, 1)
})


test('market display fallback never supplies activation preflight', async () => {
  const { wallet } = await load('lib/wallet.svelte.ts')
  const upstream = globalThis.fetch
  let publicReads = 0
  globalThis.fetch = (...args) => { publicReads++; return upstream(...args) }
  wallet.account = author; wallet.chainId = chain.id
  wallet.provider = { request: async request => {
    if (request.method === 'eth_call') throw Object.assign(new Error('Internal error'), { code: -32603 })
    return provider.request(request)
  } }
  try {
    const api = keyMarket(chain, deployment)
    await api.verify({ cached: true })
    assert.equal((await api.account(author)).active, false)
    assert.ok(publicReads > 0)
    const before = publicReads
    await assert.rejects(api.activate(wallet.provider, author, 1n, quote), /Internal error/)
    assert.equal(publicReads, before, 'preflight cannot reuse a display fallback or its deployment verification')
    assert.ok(!calls.some(c => c.method === 'eth_sendTransaction'))
  } finally { wallet.provider = undefined; wallet.account = null; wallet.chainId = null }
})

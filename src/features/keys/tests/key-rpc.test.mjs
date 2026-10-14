import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, mock, author, deferred } from '../../../../scripts/harness.mjs'
const { keyRpc, keyReadRpc } = await load('features/keys/key-rpc.ts')
const { wallet } = await load('lib/wallet.svelte.ts')
let chain, publicReads, walletReads, provider, walletChain, fail
beforeEach(() => {
  install(); chain = { ...mock.chain, id: 84532 }
  publicReads = 0; walletReads = 0; walletChain = chain.id; fail = false
  provider = { request: async ({ method }) => {
    if (method === 'eth_chainId') return `0x${walletChain.toString(16)}`
    walletReads++
    if (fail) throw new Error('wallet RPC unavailable')
    assert.equal(method, 'eth_blockNumber')
    return '0x10'
  } }
  wallet.provider = provider; wallet.account = null; wallet.chainId = null
  globalThis.fetch = async (_, init) => {
    publicReads++
    const request = JSON.parse(init.body)
    assert.equal(request.method, 'eth_blockNumber')
    return Response.json({ jsonrpc: '2.0', id: request.id, result: '0x20' })
  }
})
after(() => { wallet.provider = undefined; wallet.account = null; wallet.chainId = null; teardown() })
const read = () => keyRpc(chain, 'https://fallback.invalid').getBlockNumber({ cacheTime: 0 })

test('browsing follows wallet connection and chain without using public RPC on the correct chain', async () => {
  assert.equal(await read(), 32n)
  wallet.account = author; wallet.chainId = 8453
  assert.equal(await read(), 32n)
  wallet.chainId = chain.id
  assert.equal(await read(), 16n)
  assert.equal(walletReads, 1); assert.equal(publicReads, 2)
  wallet.account = null
  assert.equal(await read(), 32n)
  assert.equal(publicReads, 3)
})

test('wallet errors and silent network changes cannot fall back to public RPC', async () => {
  wallet.account = author; wallet.chainId = chain.id
  fail = true
  await assert.rejects(read(), /wallet RPC unavailable/)
  assert.equal(walletReads, 1, 'no automatic retries')
  fail = false; walletChain = 8453
  await assert.rejects(read(), /wallet changed networks/)
  assert.equal(publicReads, 0)
  wallet.account = null
  await assert.rejects(keyRpc(chain, 'https://fallback.invalid', provider).getBlockNumber(), /wallet changed networks/)
  assert.equal(publicReads, 0, 'explicit preflight provider cannot fall back either')
})

test('simultaneous public reads are shared but later reads and failures are not cached', async () => {
  const gate = deferred(), upstream = globalThis.fetch
  globalThis.fetch = async (...args) => { await gate.promise; return upstream(...args) }
  const a = read(), b = read()
  gate.resolve()
  assert.deepEqual(await Promise.all([a, b]), [32n, 32n])
  assert.equal(publicReads, 1)
  assert.equal(await read(), 32n); assert.equal(publicReads, 2)
  globalThis.fetch = async (_, init) => {
    publicReads++
    const request = JSON.parse(init.body)
    return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'unavailable' } })
  }
  await assert.rejects(read(), /unavailable/)
  assert.equal(publicReads, 3)
  globalThis.fetch = upstream
  assert.equal(await read(), 32n); assert.equal(publicReads, 4)
})

test('a stalled wallet read times out without fallback and can be retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred()
  wallet.account = author; wallet.chainId = chain.id
  wallet.provider = { request: () => gate.promise }
  const failed = assert.rejects(read(), /wallet RPC timed out/)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(10_000)
  await failed
  assert.equal(publicReads, 0)
  wallet.provider = provider
  assert.equal(await read(), 16n)
  assert.equal(walletReads, 1)
  gate.resolve('0x14a34')
})

for (const code of [4100, 4200, -32601]) {
  test(`unsupported wallet reads (${code}) use the public endpoint even during preflight`, async () => {
    const unsupported = { request: async ({ method }) => {
      if (method === 'eth_chainId') return '0x14a34'
      walletReads++
      throw Object.assign(new Error('read unsupported'), { code })
    } }
    wallet.account = author; wallet.chainId = chain.id; wallet.provider = unsupported
    assert.equal(await read(), 32n)
    assert.equal(await keyRpc(chain, 'https://fallback.invalid', unsupported).getBlockNumber({ cacheTime: 0 }), 32n)
    assert.equal(walletReads, 2); assert.equal(publicReads, 2)
  })
}

test('fallback preserves call data and block tags and isolates public endpoint configuration', async () => {
  const seen = []
  const unsupported = { request: async ({ method }) => {
    if (method === 'eth_chainId') return '0x14a34'
    throw Object.assign(new Error('unsupported'), { code: 4200 })
  } }
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body); seen.push({ url, method: request.method, params: request.params })
    return Response.json({ jsonrpc: '2.0', id: request.id, result: '0x' })
  }
  const params = [{ to: author, from: author, data: '0x12345678' }, '0x42']
  for (const url of ['https://first.invalid', 'https://second.invalid']) {
    await keyRpc(chain, url, unsupported).request({ method: 'eth_call', params })
  }
  assert.deepEqual(seen, ['https://first.invalid', 'https://second.invalid'].map(url => ({ url: new URL(url).href, method: 'eth_call', params })))
})

test('wallet authorization, rejection and network guards cannot fall back as read failures', async () => {
  for (const method of ['eth_chainId', 'eth_accounts', 'eth_sendTransaction', 'wallet_sendCalls', 'personal_sign']) {
    const unsupported = { request: async args => {
      if (args.method === 'eth_chainId' && method !== 'eth_chainId') return '0x14a34'
      throw Object.assign(new Error('unsupported'), { code: 4200 })
    } }
    await assert.rejects(keyRpc(chain, 'https://fallback.invalid', unsupported).request({ method, params: [] }))
  }
  for (const code of [4001, 4900, -32000, 3]) {
    const failed = { request: async ({ method }) => {
      if (method === 'eth_chainId') return '0x14a34'
      throw Object.assign(new Error('read failed'), { code })
    } }
    await assert.rejects(keyRpc(chain, 'https://fallback.invalid', failed).getBlockNumber({ cacheTime: 0 }))
  }
  assert.equal(publicReads, 0)
})

test('late unsupported errors after the wallet timeout never start a public request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = deferred()
  const slow = { request: ({ method }) => method === 'eth_chainId' ? Promise.resolve('0x14a34') : pending.promise }
  const failed = assert.rejects(keyRpc(chain, 'https://fallback.invalid', slow).getBlockNumber(), /timed out/)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(10_000); await failed
  pending.reject(Object.assign(new Error('unsupported'), { code: 4200 }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(publicReads, 0)
})

for (const code of [4100, 4200, -32601]) {
  test(`unsupported balance reads (${code}) preserve the payer and block on public fallback`, async () => {
    const unsupported = { request: async ({ method }) => {
      if (method === 'eth_chainId') return '0x14a34'
      assert.equal(method, 'eth_getBalance')
      throw Object.assign(new Error('unsupported'), { code })
    } }
    globalThis.fetch = async (_, init) => {
      publicReads++
      const request = JSON.parse(init.body)
      assert.equal(request.method, 'eth_getBalance')
      assert.deepEqual(request.params, [author, 'latest'])
      return Response.json({ jsonrpc: '2.0', id: request.id, result: '0x42' })
    }
    assert.equal(await keyRpc(chain, 'https://fallback.invalid', unsupported).getBalance({ address: author }), 66n)
    assert.equal(publicReads, 1)
  })
}


const displayRead = () => keyReadRpc(chain, 'https://fallback.invalid').getBlockNumber({ cacheTime: 0 })

for (const failure of [new Error('rpc error'), Object.assign(new Error('Internal error'), { code: -32603 }),
  Object.assign(new Error('Rate limit exceeded'), { code: 429 })]) {
  test(`display reads fall back once for ${failure.message}, while preflight still fails`, async () => {
    wallet.account = author; wallet.chainId = chain.id
    provider.request = async ({ method }) => {
      if (method === 'eth_chainId') return '0x14a34'
      walletReads++; throw failure
    }
    assert.equal(await displayRead(), 32n)
    assert.equal(walletReads, 1); assert.equal(publicReads, 1)
    await assert.rejects(keyRpc(chain, 'https://fallback.invalid', provider).getBlockNumber({ cacheTime: 0 }))
    assert.equal(walletReads, 2); assert.equal(publicReads, 1, 'display fallback cannot leak into a signing client')
  })
}

test('display fallback shares simultaneous failures and leaves later requests uncached', async () => {
  wallet.account = author; wallet.chainId = chain.id; fail = true
  const gate = deferred(), upstream = globalThis.fetch
  globalThis.fetch = async (...args) => { await gate.promise; return upstream(...args) }
  const a = displayRead(), b = displayRead()
  await new Promise(resolve => setImmediate(resolve))
  gate.resolve()
  assert.deepEqual(await Promise.all([a, b]), [32n, 32n])
  assert.equal(walletReads, 1); assert.equal(publicReads, 1)
  fail = false
  assert.equal(await displayRead(), 16n)
  assert.equal(publicReads, 1)
})

test('display fallback preserves the exact call and block, and never retries the public endpoint', async () => {
  wallet.account = author; wallet.chainId = chain.id; fail = true
  const params = [{ to: author, data: '0x12345678' }, '0x42']
  globalThis.fetch = async (_, init) => {
    publicReads++
    const request = JSON.parse(init.body)
    assert.equal(request.method, 'eth_call'); assert.deepEqual(request.params, params)
    return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'public endpoint unavailable' } })
  }
  await assert.rejects(keyReadRpc(chain, 'https://fallback.invalid').request({ method: 'eth_call', params }), /public endpoint unavailable/)
  assert.equal(walletReads, 1); assert.equal(publicReads, 1)
})

test('display fallback refuses rejection, disconnection and actual contract reverts', async () => {
  wallet.account = author; wallet.chainId = chain.id
  for (const error of [
    { code: 4001 }, { code: 4900 }, { code: 4901 }, { code: 4902 }, { code: -32002 },
    { code: 3, message: 'execution reverted' }, { code: -32000, message: 'execution reverted' },
    { code: -32603, data: '0x12345678' },
    { cause: { data: { errorName: 'Slippage' } } },
    { code: -32603, data: { originalError: { data: '0x12345678' } } },
  ]) {
    provider.request = async ({ method }) => {
      if (method === 'eth_chainId') return '0x14a34'
      throw error
    }
    await assert.rejects(displayRead())
  }
  assert.equal(publicReads, 0)
})

test('display clients do not send signing requests to public RPC', async () => {
  wallet.account = author; wallet.chainId = chain.id; fail = true
  for (const method of ['eth_accounts', 'eth_sendTransaction', 'wallet_sendCalls', 'personal_sign']) {
    await assert.rejects(keyReadRpc(chain, 'https://fallback.invalid').request({ method, params: [] }))
  }
  assert.equal(publicReads, 0)
})

test('display fallback stops on an account change or a silent network change', async () => {
  wallet.account = author; wallet.chainId = chain.id
  provider.request = async ({ method }) => {
    if (method === 'eth_chainId') return `0x${walletChain.toString(16)}`
    walletChain = 8453
    throw new Error('rpc error')
  }
  await assert.rejects(displayRead(), /wallet changed networks/)
  assert.equal(publicReads, 0)
  walletChain = chain.id
  provider.request = async ({ method }) => {
    if (method === 'eth_chainId') return '0x14a34'
    wallet.account = null
    throw new Error('rpc error')
  }
  await assert.rejects(displayRead(), /wallet.*changed/)
  assert.equal(publicReads, 0)
})

test('a display fallback result is discarded after the wallet changes', async () => {
  wallet.account = author; wallet.chainId = chain.id; fail = true
  const gate = deferred(), started = deferred(), upstream = globalThis.fetch
  globalThis.fetch = async (...args) => { started.resolve(); await gate.promise; return upstream(...args) }
  const pending = assert.rejects(displayRead(), /wallet.*changed/)
  await started.promise
  wallet.account = null
  gate.resolve()
  await pending
})

test('a stalled display read falls back once, without a second fallback when the wallet finishes late', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  wallet.account = author; wallet.chainId = chain.id
  const gate = deferred()
  provider.request = ({ method }) => method === 'eth_chainId' ? Promise.resolve('0x14a34') : gate.promise
  const pending = displayRead()
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(10_000)
  assert.equal(await pending, 32n)
  assert.equal(publicReads, 1)
  gate.reject(new Error('late failure'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(publicReads, 1)
})


test('cyclic or excessive provider error nesting cannot bypass fallback exclusions', async () => {
  wallet.account = author; wallet.chainId = chain.id
  const cyclic = {}; cyclic.cause = cyclic
  let deep = { code: 4001 }
  for (let i = 0; i < 30; i++) deep = { cause: deep }
  for (const error of [cyclic, deep]) {
    provider.request = async ({ method }) => {
      if (method === 'eth_chainId') return '0x14a34'
      throw error
    }
    await assert.rejects(displayRead())
  }
  assert.equal(publicReads, 0)
})


test('preflight keeps its original deadline across an unsupported-read fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const walletReply = deferred(), publicReply = deferred(), publicStarted = deferred()
  provider.request = ({ method }) => method === 'eth_chainId' ? Promise.resolve('0x14a34') : walletReply.promise
  const upstream = globalThis.fetch
  globalThis.fetch = async (...args) => { publicStarted.resolve(); await publicReply.promise; return upstream(...args) }
  const pending = assert.rejects(keyRpc(chain, 'https://fallback.invalid', provider).getBlockNumber(), /wallet RPC timed out/)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(9000)
  walletReply.reject(Object.assign(new Error('unsupported'), { code: 4200 }))
  await publicStarted.promise
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(1000)
  await pending
  publicReply.resolve()
  await new Promise(resolve => setImmediate(resolve))
})

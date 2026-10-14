import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, address, author, deferred } from './harness.mjs'
const { Wallet } = await load('lib/wallet.svelte.ts')
const { mobileWallet, loadMobileWallet } = await load('lib/mobile-wallet.ts')
const { host } = await load('lib/host.svelte.ts')
const { assertActive } = await load('lib/signer.ts')
beforeEach(install)
after(teardown)
const tick = () => new Promise(setImmediate)
function storage(t, entries = []) {
  const values = new Map(entries), saved = globalThis.localStorage
  globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }
  t.after(() => { if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved })
  return values
}
function remote() {
  const listeners = new Map(), calls = []
  let accounts = [], chain = '0x14a34'
  const emit = (name, value) => { for (const fn of listeners.get(name) ?? []) fn(value) }
  const restore = (next = [author], network = '0x14a34') => {
    accounts = next; chain = network
    emit('chainChanged', chain); emit('accountsChanged', accounts)
  }
  const provider = {
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) }, removeListener() {},
    async request({ method, params }) {
      calls.push(method)
      if (method === 'eth_accounts') return accounts
      if (method === 'eth_chainId') return chain
      if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; emit('chainChanged', chain); return null }
      if (method === 'eth_blockNumber') return '0x123'
      throw new Error(`unexpected method: ${method}`)
    },
  }
  const connection = { provider,
    async connect(chainInfo) { calls.push(['connect', chainInfo?.id]); restore(); return accounts },
    async disconnect() { calls.push('disconnect'); restore([]) },
  }
  return { connection, calls, restore }
}

test('the wallet app connector is lazy, shares the prompt lock, and supplies the signing provider', async t => {
  storage(t)
  const r = remote(), initializing = deferred()
  let loads = 0
  const w = new Wallet(undefined, 100, 0, { mobile: () => { loads++; return initializing.promise } })
  assert.equal(w.canConnect, true)
  assert.equal(loads, 0, 'reading without a prior session must not load the connector')
  const connecting = w.connect(mock.chain)
  assert.equal(w.busy, true)
  await assert.rejects(w.connect(), /previous request/)
  initializing.resolve(r.connection)
  await connecting
  assert.equal(loads, 1)
  assert.equal(w.provider, r.connection.provider)
  assert.equal(w.account, author)
  assert.equal(w.chainId, 84532)
  assert.ok(!r.calls.includes('eth_requestAccounts'), 'use the connector\'s connect method')
  assert.ok(r.calls.some(c => Array.isArray(c) && c[1] === mock.chain.id))
  await assertActive(w.provider, author)
  r.restore([address('77')])
  assert.equal(w.account, address('77'))
  await assert.rejects(assertActive(w.provider, author), /different account/)
  await w.ensureChain(mock.chain)
  assert.equal(w.chainId, mock.chain.id)
})

test('injected wallets take precedence over loading the connector', async t => {
  storage(t, [])
  const r = remote()
  const w = new Wallet(r.connection.provider, 100, 0, { mobile: () => { throw new Error('the connector must not load') } })
  await w.resync()
  assert.equal(w.provider, r.connection.provider)
})

test('a rejected mobile prompt releases the button and can be retried', async t => {
  storage(t)
  const r = remote(), connect = r.connection.connect
  r.connection.connect = async () => { throw Object.assign(new Error('user rejected'), { code: 4001 }) }
  const w = new Wallet(undefined, 100, 0, { mobile: async () => r.connection })
  await assert.rejects(w.connect(), /rejected/)
  assert.equal(w.busy, false)
  assert.equal(w.account, null)
  r.connection.connect = connect
  await w.connect()
  assert.equal(w.account, author)
})

test('timed-out initialization stays shared; failed initialization can retry', async t => {
  storage(t)
  const r = remote(), pending = deferred()
  let loads = 0
  const w = new Wallet(undefined, 10, 0, { mobile: () => { loads++; return pending.promise } })
  await assert.rejects(w.connect(), /try again/)
  await assert.rejects(w.connect(), /try again/)
  assert.equal(w.busy, false)
  assert.equal(loads, 1)
  pending.resolve(r.connection)
  await tick()
  assert.equal(w.account, null, 'late initialization alone never opens a prompt')
  await w.connect()
  assert.equal(w.account, author)
  let fail = true
  const v = new Wallet(undefined, 100, 0, { mobile: async () => {
    if (fail) throw new Error('offline')
    return remote().connection
  } })
  await assert.rejects(v.connect(), /offline/)
  fail = false
  await v.connect()
  assert.equal(v.account, author)
})

test('saved sessions restore silently, including a session arriving after initialization', async t => {
  storage(t, [['blohard.wallet.remote', '"mobile"'], ['blohard.wallet.connected', 'true']])
  const r = remote(), init = deferred()
  const w = new Wallet(undefined, 100, 0, { mobile: () => init.promise })
  assert.equal(w.restoring, true)
  assert.equal(w.account, null, 'storage is only a hint')
  init.resolve(r.connection)
  await tick()
  r.restore()
  assert.equal(w.account, author)
  assert.equal(w.chainId, 84532)
  assert.equal(w.restoring, false)
  assert.ok(!r.calls.some(c => Array.isArray(c)), 'no connection prompt')
  r.restore([address('77')], '0x2105')
  assert.equal(w.account, address('77'))
  assert.equal(w.chainId, 8453)
})

test('disconnect closes the connector\'s session and prevents late events or reload restoring it', async t => {
  const stored = storage(t), r = remote()
  const w = new Wallet(undefined, 100, 0, { mobile: async () => r.connection })
  await w.connect()
  const closing = deferred()
  r.connection.disconnect = () => { r.calls.push('disconnect'); return closing.promise }
  const disconnect = w.disconnect()
  assert.equal(w.account, null)
  await assert.rejects(w.connect(), /previous request/, 'do not race session revocation')
  r.restore()
  assert.equal(w.account, null)
  closing.resolve()
  await disconnect
  assert.ok(r.calls.includes('disconnect'))
  assert.ok(!r.calls.includes('wallet_revokePermissions'))
  assert.equal(stored.get('blohard.wallet.disconnected'), 'true')
  let loads = 0
  const reloaded = new Wallet(undefined, 100, 0, { mobile: async () => { loads++; return remote().connection } })
  await tick()
  assert.equal(loads, 0)
  assert.equal(reloaded.account, null)
  await reloaded.connect()
  assert.equal(loads, 1)
  assert.equal(reloaded.account, author)
})

test('the connector comes from the build, on this origin only', () => {
  const origin = 'https://client.invalid'
  const given = (name, module, notice) => mobileWallet({ VITE_MOBILE_WALLET_NAME: name, VITE_MOBILE_WALLET_MODULE: module,
    ...(notice === undefined ? {} : { VITE_MOBILE_WALLET_NOTICE: notice }) }, origin)
  assert.equal(mobileWallet({}, origin), null, 'a public build names no connector')
  assert.deepEqual(given(' Wallet · app ', '/wallets/w.js'), { name: 'Wallet · app', module: '/wallets/w.js', notice: null })
  assert.deepEqual(given('w', '/wallets/w.js', '/licenses/w.txt'), { name: 'w', module: '/wallets/w.js', notice: '/licenses/w.txt' })
  assert.equal(given('w', '/wallets/w.js', '').notice, null)
  assert.equal(given('w', 'https://other.invalid/w.js'), null, 'another origin')
  assert.equal(given('w', 'https://user:pw@client.invalid/w.js'), null, 'credentials')
  assert.equal(given('w', '/wallets/w.js', 'https://other.invalid/n'), null, 'a notice elsewhere')
  assert.equal(given('x'.repeat(41), '/w.js'), null, 'too long a name')
  assert.equal(given('', '/w.js'), null)
  assert.equal(mobileWallet({ VITE_MOBILE_WALLET_NAME: 'w', VITE_MOBILE_WALLET_MODULE: '/w.js' }, ''), null, 'no origin, no choice')
})

test('the connector is told this site, the chains and the starting chain, and an unusable module is refused', async t => {
  storage(t, [['blohard.chain', String(mock.chain.id)]])
  const old = host.status
  host.status = { chains: [mock.chain, { ...mock.chain, id: 8453, public_rpc_url: null }] }
  t.after(() => { host.status = old })
  const r = remote()
  let loaded, config
  const connection = await loadMobileWallet({ name: 'w', module: '/wallets/w.js', notice: null },
    async url => { loaded = url; return { default: async given => { config = given; return r.connection } } })
  assert.equal(loaded, 'https://client.invalid/wallets/w.js')
  assert.equal(config.dapp.url, 'https://client.invalid')
  assert.deepEqual(config.rpcUrls, { [mock.chain.id]: new URL(mock.chain.public_rpc_url).href }, 'a chain without a public RPC is left out')
  assert.equal(config.chainId, mock.chain.id, 'the remembered chain')
  assert.equal(connection, r.connection)
  await assert.rejects(loadMobileWallet({ name: 'w', module: '/w.js', notice: null }, async () => ({})), /not usable/)
})

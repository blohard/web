import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, address, deferred } from './harness.mjs'

const { Wallet } = await load('lib/wallet.svelte.ts')
beforeEach(install)
after(teardown)
const tick = () => new Promise(setImmediate)

function storage(t, entries = []) {
  const values = new Map(entries), saved = globalThis.localStorage
  globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }
  t.after(() => { if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved })
  return values
}

function remote(who) {
  const listeners = new Map(), calls = []
  let accounts = []
  const emit = next => { accounts = next; for (const fn of listeners.get('accountsChanged') ?? []) fn(next) }
  const provider = {
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    async request({ method }) {
      calls.push(method)
      if (method === 'eth_accounts') return accounts
      if (method === 'eth_requestAccounts') { emit([who]); return accounts }
      if (method === 'eth_chainId') return '0x14a34'
      if (method === 'wallet_revokePermissions') { emit([]); return null }
      throw new Error(`unexpected ${method}`)
    },
  }
  return { provider, calls, emit,
    connect: () => provider.request({ method: 'eth_requestAccounts' }),
    async disconnect() { calls.push('disconnect'); emit([]) },
  }
}

test('choosing Coinbase uses that account even when a browser wallet is installed', async t => {
  storage(t)
  const browser = remote(address('11')), coinbase = remote(address('22'))
  let loads = 0
  const w = new Wallet(browser.provider, 100, 0, { coinbase: async () => { loads++; return coinbase } })
  await w.resync()
  assert.equal(loads, 0, 'reading does not contact Coinbase')
  await w.connect(undefined, 'coinbase')
  assert.equal(w.account, address('22'))
  assert.equal(w.provider, coinbase.provider)
  assert.ok(!browser.calls.includes('eth_requestAccounts'))
  browser.emit([address('33')])
  assert.equal(w.account, address('22'), 'events from the other wallet cannot replace the chosen account')
  await w.disconnect()
  assert.ok(coinbase.calls.includes('disconnect'))
  await w.connect(undefined, 'browser')
  assert.equal(w.account, address('11'))
  coinbase.emit([address('44')])
  assert.equal(w.account, address('11'))
})

test('the chosen remote wallet restores without a prompt, ahead of an injected wallet', async t => {
  storage(t, [['blohard.wallet.remote', '"coinbase"'], ['blohard.wallet.connected', 'true']])
  const browser = remote(address('11')), coinbase = remote(address('22'))
  coinbase.emit([address('22')])
  const w = new Wallet(browser.provider, 100, 0, {
    coinbase: async () => coinbase,
    mobile: async () => { throw new Error('the other connector must stay unloaded') },
  })
  await tick(); await w.resync()
  assert.equal(w.account, address('22'))
  assert.ok(!coinbase.calls.includes('eth_requestAccounts'))
  await w.disconnect()
  let loads = 0
  const reloaded = new Wallet(undefined, 100, 0, { coinbase: async () => { loads++; return coinbase } })
  await tick()
  assert.equal(loads, 0)
  assert.equal(reloaded.account, null)
  await reloaded.connect(undefined, 'coinbase')
  assert.equal(reloaded.account, address('22'))
})

test('a timed-out SDK load cannot adopt its account after another wallet was selected', async t => {
  storage(t)
  const old = deferred(), coinbase = remote(address('22')), mobile = remote(address('33'))
  coinbase.emit([address('22')])
  const w = new Wallet(undefined, 10, 0, { coinbase: () => old.promise, mobile: async () => mobile })
  await assert.rejects(w.connect(undefined, 'coinbase'), /try again/)
  await w.connect(undefined, 'mobile')
  old.resolve(coinbase)
  await tick()
  assert.equal(w.account, address('33'))
  assert.equal(w.provider, mobile.provider)
})

function browserWindow(t) {
  const saved = { window: globalThis.window, document: globalThis.document }
  const win = new EventTarget()
  globalThis.window = win
  globalThis.document = { addEventListener() {}, visibilityState: 'visible' }
  t.after(() => {
    for (const key of ['window', 'document']) {
      if (saved[key] === undefined) delete globalThis[key]; else globalThis[key] = saved[key]
    }
  })
  return win
}
const info = (n, name = 'MetaMask', rdns = 'io.metamask') => ({
  uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name, rdns,
})
function announce(win, details, provider) {
  win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: details, provider } }))
}

test('discovery selects the named provider, deduplicates announcements and ignores other wallet events', async t => {
  storage(t)
  const win = browserWindow(t), first = remote(address('11')), mm = remote(address('22'))
  win.ethereum = first.provider
  win.addEventListener('eip6963:requestProvider', () => {
    announce(win, info(1, 'Other', 'com.other'), first.provider)
    announce(win, info(2), mm.provider)
    announce(win, info(2), mm.provider)
  })
  const w = new Wallet(first.provider, 50, 0)
  await tick()
  assert.equal(w.choices.length, 2)
  assert.equal(w.choiceName(w.choices[1]), 'MetaMask · browser wallet')
  await w.connect(undefined, w.choices[1])
  assert.equal(w.account, address('22'))
  assert.ok(!first.calls.includes('eth_requestAccounts'))
  first.emit([address('33')])
  assert.equal(w.account, address('22'))
  await w.disconnect()
  await w.connect()
  assert.equal(w.account, address('22'), 'reconnect uses the selected provider')
})

test('a remembered browser wallet restores when it announces late, without adopting window.ethereum', async t => {
  storage(t, [['blohard.wallet.browser', '"io.metamask"'], ['blohard.wallet.connected', 'true']])
  const win = browserWindow(t), other = remote(address('11')), mm = remote(address('22'))
  other.emit([address('11')]); mm.emit([address('22')])
  win.ethereum = other.provider
  const w = new Wallet(other.provider, 50, 100)
  await tick()
  assert.equal(w.account, null)
  announce(win, info(3), mm.provider)
  await tick(); await w.resync()
  assert.equal(w.account, address('22'))
  assert.equal(mm.calls.includes('eth_requestAccounts'), false)
  assert.equal(other.calls.length, 0)
})

test('late discovery cannot replace an explicit selection or undo a disconnect', async t => {
  storage(t, [['blohard.wallet.browser', '"io.metamask"'], ['blohard.wallet.connected', 'true']])
  const win = browserWindow(t), browser = remote(address('11')), mm = remote(address('22'))
  mm.emit([address('22')])
  const w = new Wallet(browser.provider, 50, 20)
  await w.connect(undefined, 'browser')
  announce(win, info(4), mm.provider)
  await tick()
  assert.equal(w.account, address('11'))
  await w.disconnect()
  announce(win, info(5, 'Third', 'com.third'), remote(address('33')).provider)
  assert.equal(w.account, null)
})

test('connection errors distinguish refused account access from the network check', async t => {
  storage(t)
  const { explain } = await load('lib/errors.ts')
  for (const method of ['eth_requestAccounts', 'eth_chainId']) {
    const p = { on() {}, request: async ({ method: asked }) => {
      if (asked === method) throw Object.assign(new Error('unauthorized'), { code: 4100 })
      return asked === 'eth_chainId' ? '0x2105' : asked === 'eth_accounts' ? [] : [address('11')]
    } }
    const w = new Wallet(p, 50, 0)
    await assert.rejects(w.connect(undefined, 'browser'), e => {
      const text = explain(e)
      assert.match(text, method === 'eth_requestAccounts' ? /account access/ : /network check/)
      assert.match(text, /4100/)
      assert.doesNotMatch(text, /connect it first/)
      return true
    })
    assert.equal(w.busy, false)
  }
})

test('discovery ignores malformed and repeated announcements and bounds the list', async t => {
  storage(t)
  const win = browserWindow(t), w = new Wallet(undefined, 50, 0)
  const p = remote(address('11')).provider
  for (const detail of [null, {}, { info: info(1), provider: {} },
    { info: info(1, 'bad\u202ename'), provider: p },
    { get info() { throw new Error('getter'); } }]) {
    win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
  }
  assert.equal(w.choices.length, 0)
  announce(win, info(1), p)
  announce(win, info(1), remote(address('22')).provider)
  announce(win, info(2), p)
  assert.equal(w.choices.length, 1, 'neither a UUID nor a provider can be registered twice')
  for (let i = 2; i <= 40; i++) announce(win, info(i), remote(address('22')).provider)
  assert.equal(w.choices.length, 32)
})

test('missing or ambiguous remembered wallets stay disconnected instead of using another provider', async t => {
  storage(t, [['blohard.wallet.browser', '"io.metamask"'], ['blohard.wallet.connected', 'true']])
  const win = browserWindow(t), other = remote(address('11'))
  other.emit([address('11')])
  const w = new Wallet(other.provider, 20, 10)
  const a = remote(address('22')), b = remote(address('33'))
  a.emit([address('22')]); b.emit([address('33')])
  announce(win, info(1), a.provider)
  announce(win, info(2), b.provider)
  await new Promise(r => setTimeout(r, 25))
  assert.equal(w.account, null)
  assert.equal(w.restoring, false)
  assert.equal(other.calls.length, 0)
  await w.connect(undefined, w.choices[1])
  assert.equal(w.account, address('33'), 'an explicit choice still works')
})

test('a remembered wallet arriving after the restore deadline stays a choice without changing accounts', async t => {
  storage(t, [['blohard.wallet.browser', '"io.metamask"'], ['blohard.wallet.connected', 'true']])
  const win = browserWindow(t), mm = remote(address('22'))
  mm.emit([address('22')])
  const w = new Wallet(undefined, 20, 5)
  await new Promise(r => setTimeout(r, 15))
  announce(win, info(1), mm.provider)
  await tick()
  assert.equal(w.account, null)
  assert.equal(w.restoring, false)
  assert.equal(w.choices.length, 1)
  assert.equal(mm.calls.length, 0)
})

test('an account event during connect cannot hide a failed network check', async t => {
  storage(t)
  const mm = remote(address('22')), read = mm.provider.request
  let refused = true
  mm.provider.request = args => args.method === 'eth_chainId' && refused
    ? Promise.reject(Object.assign(new Error('unauthorized'), { code: 4100 })) : read(args)
  const w = new Wallet(mm.provider, 50, 0)
  await w.resync()
  await assert.rejects(w.connect(undefined, 'browser'), /network check/)
  assert.equal(w.account, null, 'keep the connect control and its error visible')
  refused = false
  await w.connect(undefined, 'browser')
  assert.equal(w.account, address('22'))
})

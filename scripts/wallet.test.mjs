// The wallet: the faucet's answers, chain switching and adding, the RPC probe, and re-reading the account on return.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, address, author, response, sign, walletOn, chainHex, rejects, deferred } from './harness.mjs'

const pending = await load('features/publishing/pending.ts')
const { Wallet } = await load('lib/wallet.svelte.ts')

beforeEach(install)
after(teardown)

test('a faucet answer that is lost, late or unreadable is an unknown outcome, not a refusal', async () => {
  const { requestFaucet, FAUCET_OUTCOME_UNKNOWN } = await load('features/publishing/relay.ts')
  const cases = [
    ['no answer', () => { throw new Error('network unavailable') }],
    ['a relayer timeout', () => response({ error: 'sending failed. the ether may still arrive' }, 504)],
    ['a proxy busy answer', () => response({ error: 'upstream unavailable' }, 503)],
    ['a proxy timeout', () => new Response('Request Timeout', { status: 408 })],
    ['a malformed success', () => response({}, 200)],
    ['a cut-off answer', () => new Response('{"tx_hash":"0x', { status: 200, headers: { 'content-type': 'application/json' } })],
  ]
  const before = globalThis.fetch
  try {
    for (const [name, answer] of cases) {
      globalThis.fetch = async () => answer()
      await assert.rejects(requestFaucet(mock.chain.id, author), (e) => e.message.includes(FAUCET_OUTCOME_UNKNOWN), name)
    }
    // A plain refusal stays a refusal.
    globalThis.fetch = async () => response({ error: 'this address has test ether already', outcome: 'refused' }, 429)
    await assert.rejects(requestFaucet(mock.chain.id, author), (e) => e.status === 429 && !e.message.includes(FAUCET_OUTCOME_UNKNOWN))
  } finally {
    globalThis.fetch = before
  }
})

test('relayer errors are decoded once, and an oversized refusal remains unknown', async () => {
  const { relayPost, RelayError } = await load('features/publishing/relay.ts')
  const signed = { author, contentHash: '0x' + 'aa'.repeat(32), parentId: '0', replyGate: address('00'), nonce: '1', deadline: '1', sig: '0x', gateData: '0x' }
  const answer = response({ error: 'busy', outcome: 'refused' }, 503)
  answer.clone = () => { throw new Error('the answer must not be cloned to decode its error twice') }
  globalThis.fetch = async () => answer
  await assert.rejects(relayPost(mock.chain.id, signed), (e) => e instanceof RelayError && e.outcome === 'refused' && e.message === 'busy')
  assert.equal(answer.bodyUsed, true)

  let cancelled = false
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"outcome":"refused","error":"'))
    },
    pull(controller) { controller.enqueue(new Uint8Array(700000).fill(32)) },
    cancel() { cancelled = true },
  }), { status: 503 })
  await assert.rejects(relayPost(mock.chain.id, signed), (e) => e instanceof RelayError && e.outcome === 'unknown')
  assert.equal(cancelled, true)
})

test('a wallet that serves no reads is not a broken wallet: a sponsored post needs no wallet RPC, and paying gas is not warned about', async () => {
  // Reads refused as unsupported: a smart-account wallet on a chain it does not know.
  const { w, asked } = walletOn(chainHex(), { reads: rejects(4200, 'method not supported'), update: rejects(4001, 'user rejected') })
  await w.ensureChain(mock.chain, 'optional')
  assert.equal(asked.includes('eth_blockNumber'), false, 'a signature-only action never probes the wallet RPC')
  await w.ensureChain(mock.chain, 'required')
  assert.equal(w.rpcHealthy, null, 'unsupported reads are not a broken RPC')
  assert.equal(asked.includes('wallet_addEthereumChain'), false, 'nothing to fix, nothing offered')
  await w.checkRpc()
  assert.equal(w.rpcHealthy, null, 'and the quiet check shows no warning either')
})

test('a broken wallet RPC blocks only a transaction the wallet would send, and a refused update ends in the manual hint', async () => {
  const { w, asked } = walletOn(chainHex(), { reads: rejects(-32603, 'fetch failed'), update: rejects(4001, 'user rejected') })
  await w.ensureChain(mock.chain, 'optional')
  assert.equal(asked.includes('eth_blockNumber'), false, 'a sponsored post goes ahead')
  await assert.rejects(w.ensureChain(mock.chain, 'required'), (e) =>
    e.message.includes('still does not respond') && e.message.includes(mock.chain.public_rpc_url) && e.message.includes('sponsored posts') && !e.message.includes('rejected'))
  assert.equal(w.rpcHealthy, false)
  assert.equal(asked.filter((m) => m === 'wallet_addEthereumChain').length, 1, 'the host’s URL was offered once')
  // A wallet that takes the offer and answers afterwards is fine again.
  let fixed = false
  const repaired = walletOn(chainHex(), { reads: () => (fixed ? '0x10' : rejects(-32603, 'fetch failed')()), update: () => { fixed = true; return null } })
  await repaired.w.ensureChain(mock.chain, 'required')
  assert.equal(repaired.w.rpcHealthy, true)
})

test('a wallet that adds a chain without switching to it is asked to switch', async () => {
  // Starts on chain 1; does not know ours until asked to add it; adding does not switch (EIP-3085 allows that).
  let current = '0x1'
  const known = new Set(['0x1'])
  const asked = []
  const provider = {
    on: () => {},
    request: async (req) => {
      asked.push(req.method)
      switch (req.method) {
        case 'eth_accounts': return [author]
        case 'eth_chainId': return current
        case 'eth_blockNumber': return '0x10'
        case 'wallet_switchEthereumChain': {
          const id = req.params[0].chainId
          if (!known.has(id)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 })
          current = id
          return null
        }
        case 'wallet_addEthereumChain': known.add(req.params[0].chainId); return null
        default: throw new Error(`unexpected ${req.method}`)
      }
    },
  }
  const w = new Wallet(provider)
  w.chainId = 1
  await w.ensureChain(mock.chain, 'optional')
  assert.equal(w.chainId, mock.chain.id)
  assert.deepEqual(asked.filter((m) => m.startsWith('wallet_')), ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain'])
})

test('coming back to the page re-reads the account and chain without a prompt, and respects a disconnect', async () => {
  let accounts = [author]
  let current = chainHex()
  const asked = []
  const provider = { on: () => {}, request: async (req) => {
    asked.push(req.method)
    if (req.method === 'eth_accounts') return accounts
    if (req.method === 'eth_chainId') return current
    throw new Error(`unexpected ${req.method}`)
  } }
  const w = new Wallet(provider)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(w.account, author)
  // The reader switched accounts and chains inside the extension; no event reached the page.
  accounts = [address('77')]
  current = '0x1'
  await w.resync()
  assert.equal(w.account, address('77'))
  assert.equal(w.chainId, 1)
  assert.equal(asked.includes('eth_requestAccounts'), false, 'never a prompt')
  // Signed out on the site: a resync keeps it that way until the reader connects
  // again. The sign-out is remembered in browser storage, shimmed here.
  const store = new Map()
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
  try {
    await w.disconnect()
    accounts = [author]
    await w.resync()
    assert.equal(w.account, null)
    await w.connect().catch(() => {})
  } finally {
    delete globalThis.localStorage
  }
})

test('a slow silent read never overwrites a newer account change or a sign-out, and a sign-out holds without storage', async () => {
  const listeners = {}
  let pendingAccounts = null
  const provider = { on: (event, l) => { listeners[event] = l }, request: async (req) => {
    if (req.method === 'eth_accounts') return pendingAccounts ? await pendingAccounts : [author]
    if (req.method === 'eth_chainId') return chainHex()
    throw new Error(`unexpected ${req.method}`)
  } }
  const w = new Wallet(provider)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(w.account, author)
  // A read starts, the wallet announces a switch to B meanwhile, then the read answers with A.
  let answer
  pendingAccounts = new Promise((r) => (answer = r))
  const slow = w.resync()
  listeners.accountsChanged([address('77')])
  answer([author])
  await slow
  assert.equal(w.account, address('77'), 'the announced account wins over the stale read')
  // A read starts, the reader signs out meanwhile, then the read answers with an account.
  pendingAccounts = new Promise((r) => (answer = r))
  const slower = w.resync()
  await w.disconnect()
  answer([author])
  await slower
  assert.equal(w.account, null, 'the sign-out wins over the stale read')
  // No browser storage in this runner: the sign-out still holds on the next return to the page.
  pendingAccounts = null
  await w.resync()
  assert.equal(w.account, null)
  // Extension account events do not undo a site-side disconnect.
  listeners.accountsChanged([author])
  await w.resync()
  assert.equal(w.account, null)
  await assert.rejects(w.connect())
  await w.resync()
  assert.equal(w.account, null, 'a rejected connect does not clear the disconnect')
})

test('background wallet checks share unanswered requests, including after their wait times out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const held = deferred(), asked = []
  let reply = held.promise
  const provider = { on() {}, request: async ({ method }) => {
    asked.push(method)
    if (method === 'eth_accounts') return reply
    return chainHex()
  } }
  const w = new Wallet(provider)
  const checks = Array.from({ length: 20 }, () => w.resync())
  assert.equal(asked.length, 2, 'startup, focus and visibility share a single check')
  t.mock.timers.tick(6000)
  assert.deepEqual(await Promise.all(checks), Array(20).fill(false))
  await w.resync()
  assert.equal(asked.length, 2, 'a timed-out wait does not release unanswered provider requests')
  assert.equal(w.account, null)
  held.resolve([author])
  await new Promise(setImmediate)
  assert.equal(w.account, author, 'a late answer still restores the account without a newer event')
  reply = Promise.resolve([address('77')])
  await w.resync()
  assert.equal(asked.length, 4, 'a completed check frees the next check')
  assert.equal(w.account, address('77'))
})

for (const synchronous of [false, true]) test(`a failed half of a background check cannot release its unanswered half (${synchronous ? 'throw' : 'rejection'})`, { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const held = deferred()
  let calls = 0
  const w = new Wallet(undefined)
  w.provider = { request: ({ method }) => {
    calls++
    if (method === 'eth_accounts') {
      if (synchronous) throw new Error('unavailable')
      return Promise.reject(new Error('unavailable'))
    }
    return held.promise
  } }
  w.account = author
  try {
    const check = w.resync()
    assert.equal(calls, 2, 'both reads are started even if one throws synchronously')
    t.mock.timers.tick(6000)
    await check
    await w.resync()
    assert.equal(calls, 2)
    assert.equal(w.account, author)
  } finally {
    held.resolve(chainHex())
    await new Promise(setImmediate)
  }
})

test('a hung read after an empty account list is shared and cannot overwrite an announced account', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const held = deferred(), listeners = {}
  let accounts = 0
  const w = new Wallet({ on(event, listener) { listeners[event] = listener }, request: async ({ method }) => {
    if (method === 'eth_chainId') return chainHex()
    return ++accounts === 1 ? [author] : accounts === 2 ? [] : held.promise
  } })
  await w.resync()
  await w.resync()
  assert.equal(w.account, author, 'the empty read keeps browsing')
  const check = w.resync()
  await new Promise(setImmediate)
  assert.equal(accounts, 3)
  t.mock.timers.tick(6000)
  await check
  await w.resync()
  assert.equal(accounts, 3, 'the unanswered read still owns the flight')
  listeners.accountsChanged([address('77')])
  held.resolve([author])
  await new Promise(setImmediate)
  assert.equal(w.account, address('77'))
})

test('a wallet RPC that hangs counts as broken', async () => {
  const { w } = walletOn(chainHex(), { reads: () => new Promise(() => {}), update: rejects(4001, 'user rejected') })
  await w.checkRpc()
  assert.equal(w.rpcHealthy, false)
})

test('wallet restoration is a bounded display hint, never a remembered account', async () => {
  const store = new Map([['blohard.wallet.connected', 'true']])
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  let resolve
  const accounts = new Promise(r => { resolve = r })
  const provider = { on() {}, request: async ({ method }) => method === 'eth_accounts' ? accounts : chainHex() }
  try {
    const w = new Wallet(provider, 20)
    assert.equal(w.restoring, true)
    assert.equal(w.account, null, 'a hint cannot authorize actions')
    resolve([author])
    await new Promise(r => setTimeout(r, 0))
    assert.equal(w.restoring, false)
    assert.equal(w.account, author)
    await w.disconnect()
    assert.equal(store.get('blohard.wallet.connected'), 'false')
    assert.equal(new Wallet(provider, 20).restoring, false)
    store.delete('blohard.wallet.disconnected')
    store.set('blohard.wallet.connected', 'true')
    const stuck = new Wallet({ on() {}, request: () => new Promise(() => {}) }, 20)
    assert.equal(stuck.restoring, true)
    await new Promise(r => setTimeout(r, 40))
    assert.equal(stuck.restoring, false, 'a silent wallet cannot leave a permanent placeholder')
    assert.equal(stuck.account, null)
  } finally { delete globalThis.localStorage }
})

// ---- wallets that arrive late or blink out on return

function fakeWindow() {
  const listeners = new Map()
  const win = {
    ethereum: undefined,
    addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
    removeEventListener: (type, fn) => { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)) },
    dispatchEvent: (event) => { for (const fn of listeners.get(event.type) ?? []) fn(event) },
    fire: (type) => { for (const fn of listeners.get(type) ?? []) fn() },
  }
  return win
}
async function withWindow(run) {
  const saved = { window: globalThis.window, document: globalThis.document }
  const win = fakeWindow()
  globalThis.window = win
  globalThis.document = { addEventListener: () => {}, visibilityState: 'visible' }
  try { await run(win) } finally {
    if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document
  }
}
function metamask(accounts = [author]) {
  const asked = []
  return { asked, provider: {
    on: () => {},
    request: async ({ method }) => {
      asked.push(method)
      if (method === 'eth_accounts') return accounts
      if (method === 'eth_requestAccounts') return [author]
      if (method === 'eth_chainId') return chainHex()
      throw new Error(`unexpected ${method}`)
    },
  } }
}

test('a wallet injected after the page started is adopted when it announces itself or appears', () => withWindow(async (win) => {
  const w = new Wallet(undefined, 50, 2000)
  assert.equal(w.canConnect, false)
  const mm = metamask()
  win.ethereum = mm.provider
  win.fire('ethereum#initialized')
  await w.resync()
  assert.equal(w.canConnect, true)
  assert.equal(w.account, author, 'the late wallet is read like one present at load')

  const polled = metamask([])
  win.ethereum = undefined
  const v = new Wallet(undefined, 50, 2000)
  setTimeout(() => { win.ethereum = polled.provider }, 150)
  await new Promise(r => setTimeout(r, 250))
  await v.connect()
  assert.equal(v.canConnect, true, 'a wallet that sets window.ethereum without the event is found too')
  assert.ok(polled.asked.includes('eth_requestAccounts'), 'an explicit press asks it')
}))

test('with no wallet at all the page gives up waiting and stays without one', () => withWindow(async () => {
  const w = new Wallet(undefined, 50, 20)
  await new Promise(r => setTimeout(r, 40))
  assert.equal(w.canConnect, false)
  assert.equal(w.restoring, false)
}))

test('a page that uses no wallet asks nothing of one, injected, announced, late or remembered', () => withWindow(async (win) => {
  const mm = metamask()
  win.ethereum = mm.provider
  globalThis.localStorage = { getItem: k => k === 'blohard.wallet.remote' ? '"mobile"' : k === 'blohard.wallet.connected' ? 'true' : null, setItem() {} }
  try {
    let loads = 0
    const w = new Wallet(null, 50, 20, { mobile: async () => { loads++; throw new Error('never loaded') } })
    win.fire('ethereum#initialized')
    win.dispatchEvent({ type: 'eip6963:announceProvider', detail: { info: { uuid: '1', name: 'Other', rdns: 'com.other', icon: 'data:image/svg+xml,' }, provider: mm.provider } })
    await new Promise(r => setTimeout(r, 40))
    await w.resync()
    assert.deepEqual(mm.asked, [])
    assert.equal(w.canConnect, false)
    assert.deepEqual(w.choices, [])
    assert.equal(w.account, null)
    assert.equal(w.restoring, false)
    assert.equal(loads, 0)
    await assert.rejects(w.connect(), /no browser wallet/)
    assert.deepEqual(mm.asked, [])
  } finally { delete globalThis.localStorage }
}))

test('silent empty account reads preserve the browsing account without prompting', async () => {
  let answers = [[author], [], [author]]
  const provider = {
    on: () => {},
    request: async ({ method }) => {
      if (method === 'eth_accounts') return answers.length > 1 ? answers.shift() : answers[0]
      if (method === 'eth_chainId') return chainHex()
      throw new Error(`unexpected ${method}`)
    },
  }
  const w = new Wallet(provider)
  await w.resync()
  assert.equal(w.account, author)
  await w.resync()
  assert.equal(w.account, author, 'a wallet waking up from the background is not a sign-out')
  answers = [[]]
  await w.resync()
  assert.equal(w.account, author, 'a locked wallet keeps the browsing account')
})

test('a wallet that blinks out on return still reports the network it changed to in the background', async () => {
  let answers = [[author], [], [author]], chain = chainHex()
  const provider = {
    on: () => {},
    request: async ({ method }) => {
      if (method === 'eth_accounts') return answers.length > 1 ? answers.shift() : answers[0]
      if (method === 'eth_chainId') return chain
      throw new Error(`unexpected ${method}`)
    },
  }
  const w = new Wallet(provider)
  await w.resync()
  assert.equal(w.chainId, Number(chainHex()))
  // The network changed while the page was in the background and its event was missed.
  chain = '0x1'
  await w.resync()
  assert.equal(w.account, author, 'the account came back on the re-read')
  assert.equal(w.chainId, 1, 'the network read on return is applied')
})

test('a chain read that hangs after an approval or a switch gives the button back', async () => {
  const hangs = (answers) => ({ on: () => {}, request: ({ method }) => method in answers ? Promise.resolve(answers[method]) : new Promise(() => {}) })
  const connecting = new Wallet(hangs({ eth_requestAccounts: [author], eth_accounts: [] }))
  connecting.probeTimeoutMs = 20
  await assert.rejects(connecting.connect(), /did not answer/)
  assert.equal(connecting.busy, false, 'the connect button is back')
  const switching = new Wallet(hangs({ wallet_switchEthereumChain: null, eth_accounts: [author] }))
  switching.probeTimeoutMs = 20
  await assert.rejects(switching.ensureChain(mock.chain), /did not answer/)
  assert.equal(switching.busy, false, 'the switch button is back')
})

test('an account arriving where there was none is announced once; a switch between accounts is not', async () => {
  const handlers = {}
  let accounts = []
  const provider = {
    on: (name, fn) => { handlers[name] = fn },
    request: async ({ method }) => method === 'eth_accounts' ? accounts : method === 'eth_requestAccounts' ? [author] : method === 'eth_chainId' ? chainHex() : null,
  }
  const w = new Wallet(provider)
  let arrivals = 0
  const stop = w.onConnected(() => { arrivals++ })
  await w.connect()
  assert.equal(arrivals, 1, 'a connect')
  handlers.accountsChanged([address('77')])
  assert.equal(arrivals, 1, 'another account is not an arrival')
  handlers.accountsChanged([])
  handlers.accountsChanged([author])
  assert.equal(arrivals, 1, 'unlocking is not a fresh site connection')
  stop()
  handlers.accountsChanged([])
  handlers.accountsChanged([author])
  assert.equal(arrivals, 1, 'a stopped listener hears nothing')
})

test('a connect the wallet never answers gives the button back', async () => {
  const provider = {
    on: () => {},
    request: ({ method }) => method === 'eth_requestAccounts' ? new Promise(() => {}) : Promise.resolve(method === 'eth_chainId' ? chainHex() : []),
  }
  const w = new Wallet(provider)
  w.connectTimeoutMs = 20
  await assert.rejects(w.connect(), /did not answer/)
  assert.equal(w.busy, false)
})

test('the silent account and chain reads go out together, and either failing keeps what the page has', async () => {
  const waiting = []
  let fail = null
  const provider = { on() {}, request: (req) => new Promise((resolve, reject) => {
    waiting.push(req.method)
    setTimeout(() => (fail === req.method ? reject(new Error('busy')) : resolve(req.method === 'eth_accounts' ? [author] : chainHex())), 5)
  }) }
  const w = new Wallet(provider)
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(waiting.sort(), ['eth_accounts', 'eth_chainId'], 'both asked before either answered')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(w.account, author)
  assert.equal(w.chainId, mock.chain.id)
  for (const method of ['eth_accounts', 'eth_chainId']) {
    fail = method
    await w.resync()
    assert.equal(w.account, author, `a failed ${method} keeps the account`)
    assert.equal(w.chainId, mock.chain.id)
  }
})

test('is() names the connected account, whatever the letter case, and nothing without a wallet', async () => {
  const { Wallet } = await load('lib/wallet.svelte.ts')
  const w = new Wallet()
  const account = '0x' + 'aB'.repeat(20)
  assert.equal(w.is(account), false, 'no wallet connected')
  w.account = account
  assert.equal(w.is(account.toLowerCase()), true)
  assert.equal(w.is('0x' + '12'.repeat(20)), false)
  assert.equal(w.is(null), false)
  assert.equal(w.is(undefined), false)
  assert.equal(w.is(''), false)
})

test('the relayer decoder classifies each answer once: busy, declined or unknown, keeping status and Retry-After', async t => {
  const { relayPost, RelayError, RelayBusy, RelayDeclined, RelayUnknown } = await load('features/publishing/relay.ts')
  const savedFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = savedFetch })
  const signed = { author, contentHash: '0x' + 'aa'.repeat(32), parentId: '0', replyGate: address('00'), nonce: '1', deadline: '1', sig: '0x', gateData: '0x' }
  const answer = (status, body, headers = {}) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json', ...headers } })
  const cases = [
    [answer(503, { error: 'busy', outcome: 'refused' }), RelayBusy, 503, null],
    [answer(429, { error: 'too fast', outcome: 'refused' }, { 'retry-after': '2' }), RelayBusy, 429, 2000],
    [answer(429, { error: 'quota spent', outcome: 'refused' }), RelayDeclined, 429, null],
    [answer(403, { error: 'not eligible', outcome: 'refused' }), RelayDeclined, 403, null],
    [answer(409, { error: 'in flight', outcome: 'unknown' }), RelayUnknown, 409, null],
    // No explicit refusal is evidence of none, whatever the status: a proxy's error is not the relayer's answer.
    [answer(503, { error: 'unavailable' }), RelayUnknown, 503, null],
    [answer(503, '<html><body>503 Service Unavailable</body></html>'), RelayUnknown, 503, null],
    [answer(200, { nonsense: true }), RelayUnknown, 0, null],
    [async () => { throw new Error('network unavailable') }, RelayUnknown, 0, null],
  ]
  for (const [respond, expected, status, retryAfter] of cases) {
    globalThis.fetch = respond
    const error = await relayPost(mock.chain.id, signed).then(() => null, e => e)
    assert.ok(error instanceof expected, `${status}: ${error?.constructor?.name}`)
    assert.ok(error instanceof RelayError, 'every relayer outcome is a RelayError')
    assert.equal(error.status, status)
    assert.equal(error.retryAfter, retryAfter)
    assert.equal(error.outcome, expected === RelayUnknown ? 'unknown' : 'refused')
    if (expected === RelayBusy) assert.ok(!(error instanceof RelayDeclined), 'busy is not a decline, so the sponsored option stays')
  }
})

test('a network switch or add the wallet never answers gives the wallet back, and a late answer continues nothing', async () => {
  for (const hang of ['wallet_switchEthereumChain', 'wallet_addEthereumChain']) {
    const late = deferred(), asked = []
    const provider = {
      on: () => {},
      request: ({ method }) => {
        asked.push(method)
        if (method === hang) return late.promise
        if (method === 'wallet_switchEthereumChain') return Promise.reject(Object.assign(new Error('unknown chain'), { code: 4902 }))
        return Promise.resolve(method === 'eth_chainId' ? '0x1' : method === 'eth_accounts' ? [author] : null)
      },
    }
    const w = new Wallet(provider)
    w.probeTimeoutMs = 20; w.connectTimeoutMs = 20
    await new Promise((r) => setTimeout(r, 30))
    await assert.rejects(w.ensureChain(mock.chain), /did not answer/, hang)
    assert.equal(w.busy, false, `${hang}: the wallet is free again`)
    const before = asked.length
    late.resolve(null)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(asked.length, before, `${hang}: the abandoned switch asks nothing more`)
  }
})


test('locking preserves browsing, a wallet action unlocks, and explicit disconnect clears the account', async () => {
  const handlers = {}, calls = []
  let accounts = [author], approval = [author]
  const provider = { on(name, fn) { handlers[name] = fn }, async request({ method }) {
    calls.push(method)
    if (method === 'eth_accounts') return accounts
    if (method === 'eth_chainId') return chainHex()
    if (method === 'eth_requestAccounts') {
      accounts = approval
      handlers.accountsChanged(accounts)
      return accounts
    }
    if (method === 'wallet_revokePermissions') { accounts = []; return null }
    throw Error(`unexpected ${method}`)
  } }
  const w = new Wallet(provider)
  await w.resync()
  accounts = []; handlers.accountsChanged([])
  await w.resync()
  assert.equal(w.account, author)
  assert.equal(calls.includes('eth_requestAccounts'), false, 'browsing never opens the wallet')
  await w.ensureChain(mock.chain, 'optional')
  assert.equal(calls.filter(m => m === 'eth_requestAccounts').length, 1)
  assert.equal(w.account, author)
  accounts = []; handlers.accountsChanged([])
  approval = [address('77')]
  await assert.rejects(w.ensureChain(mock.chain, 'optional'), /different account/)
  assert.equal(w.account, address('77'))
  await w.disconnect()
  handlers.accountsChanged([author])
  await w.resync()
  assert.equal(w.account, null)
})

for (const outcome of ['rejected', 'empty', 'timeout']) test(`an unlock that is ${outcome} stops the action and keeps browsing`, async () => {
  let accounts = [author]
  const calls = [], handlers = {}
  const w = new Wallet({ on(name, fn) { handlers[name] = fn }, async request({ method }) {
    calls.push(method)
    if (method === 'eth_accounts') return accounts
    if (method === 'eth_chainId') return chainHex()
    if (method === 'eth_requestAccounts') {
      if (outcome === 'empty') return []
      if (outcome === 'timeout') return new Promise(() => {})
      throw Object.assign(Error('user rejected'), { code: 4001 })
    }
    throw Error(`unexpected ${method}`)
  } })
  await w.resync()
  accounts = []; handlers.accountsChanged([])
  w.connectTimeoutMs = 10
  await assert.rejects(w.ensureChain(mock.chain), /rejected|no connected account|did not answer/)
  assert.equal(w.account, author)
  assert.equal(w.busy, false)
  assert.equal(calls.includes('eth_blockNumber'), false, 'no transaction preparation without account access')
})


for (const event of [false, true]) test(`a different account discovered during an action stops it (${event ? 'event' : 'silent read'})`, async () => {
  const handlers = {}, held = deferred(), calls = []
  let hold = false
  const w = new Wallet({ on(name, fn) { handlers[name] = fn }, async request({ method }) {
    calls.push(method)
    if (method === 'eth_chainId') return chainHex()
    if (method === 'eth_accounts') return hold ? held.promise : [author]
    throw Error(`unexpected ${method}`)
  } })
  await w.resync()
  hold = true
  const action = w.ensureChain(mock.chain)
  await new Promise(setImmediate)
  if (event) handlers.accountsChanged([address('77')])
  held.resolve(event ? [author] : [address('77')])
  await assert.rejects(action, /different account/)
  assert.equal(w.account, address('77'), 'a stale read cannot overwrite the account switch')
  assert.equal(calls.includes('eth_blockNumber'), false)
})

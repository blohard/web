import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { decodeFunctionData, zeroAddress } from 'viem'
process.env.VITE_ACCOUNT_KEYS_ADDRESS = '0x1111111111111111111111111111111111111111'
process.env.VITE_ACCOUNT_KEYS_DEV_FUND = '0x3333333333333333333333333333333333333333'
const { load, install, teardown, mock, author, address, txHash, authorGateChanged, renderComponent } = await import('../../../../scripts/host-harness.mjs')
const { host } = await load('lib/host.svelte.ts')
const { keyReplyDeployment } = await load('features/keys/account-keys-config.ts')

const { hasBlockedAccounts, saveAuthorGate } = await load('features/account/author-gate.ts')
const { authorGateChoice, otherGateLabel, gateForChoice } = await load('features/publishing/reply-rules.ts')
const { TOMBSTONE } = await load('lib/board.ts')
const { boardAbi } = await load('lib/abi/board.ts')
const { gates } = await load('lib/gates.svelte.ts')
const { wallet: connected } = await load('lib/wallet.svelte.ts')
const { Reverted } = await load('lib/transactions.ts')

beforeEach(() => {
  install()
  mock.chain.contract = `0x${mock.chain.id.toString(16).padStart(40, "0")}`
  mock.chain.id = 84532
  host.status = { keyrings: [{ chain: mock.chain.id, market: process.env.VITE_ACCOUNT_KEYS_ADDRESS }] }
  mock.authorGate = zeroAddress
  mock.chain.key_gates = { holders: address('98'), holders_blocklist: address('99') }
  connected.account = null
})
after(teardown)

function wallet() {
  const sent = []
  const state = { account: author, provider: { request: async ({ method, params }) => {
    if (method === 'eth_chainId') return `0x${mock.chain.id.toString(16)}`
    if (method === 'eth_accounts') return [state.account]
    if (method === 'eth_estimateGas') return '0x52000'
    if (method === 'eth_sendTransaction') { sent.push(params[0]); return txHash }
    throw new Error(`unexpected ${method}`)
  } }, ensureChain: async () => {}, sent }
  return state
}

test('both selectable reply policies enforce the blocklist', () => {
  assert.equal(gateForChoice(mock.chain, 'all'), mock.chain.blocking.gate)
  assert.equal(gateForChoice(mock.chain, 'keys'), mock.chain.key_gates.holders_blocklist)
  assert.equal(gateForChoice(mock.chain, 'deactivated'), TOMBSTONE)
  mock.chain.key_gates.holders_blocklist = null
  assert.throws(() => gateForChoice(mock.chain, 'keys'), /not available/, 'never fall back to the plain key gate')
  mock.chain.blocking = null
  assert.throws(() => gateForChoice(mock.chain, 'all'), /not available/, 'never fall back to an open gate')
  assert.equal(gateForChoice(mock.chain, 'deactivated'), TOMBSTONE)
})

test('unset, plain key and custom gates are not mislabeled as blocking', () => {
  for (const gate of [zeroAddress, mock.chain.key_gates.holders, address('aa')]) {
    assert.equal(authorGateChoice(mock.chain, gate), 'other')
  }
  assert.match(otherGateLabel(mock.chain, zeroAddress), /without block enforcement/)
  assert.match(otherGateLabel(mock.chain, mock.chain.key_gates.holders), /without block enforcement/)
  assert.equal(otherGateLabel(mock.chain, address('aa')), 'custom gate')
  for (const choice of ['all', 'keys', 'deactivated']) assert.equal(authorGateChoice(mock.chain, gateForChoice(mock.chain, choice)), choice)
})

test('an empty blocklist simplifies the current choice without changing the gate saved', () => {
  assert.equal(authorGateChoice(mock.chain, zeroAddress, true), 'all')
  assert.equal(authorGateChoice(mock.chain, mock.chain.key_gates.holders, true), 'keys')
  assert.equal(authorGateChoice(mock.chain, address('aa'), true), 'other', 'custom gates remain explicit')
  assert.equal(authorGateChoice(mock.chain, zeroAddress, false), 'other', 'a nonempty or unread list cannot imply block enforcement')
  assert.equal(gateForChoice(mock.chain, 'all'), mock.chain.blocking.gate)
  assert.equal(gateForChoice(mock.chain, 'keys'), mock.chain.key_gates.holders_blocklist)
})

test('blocklist labels need only one indexed member, never the full list', async () => {
  let page = { items: [], next: null }
  const asks = []
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/list$/)
    asks.push(JSON.parse(init.body))
    return new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } })
  }
  assert.equal(await hasBlockedAccounts(mock.chain, author), false)
  page = { items: [address('88')], next: address('88') }
  assert.equal(await hasBlockedAccounts(mock.chain, author), true)
  assert.equal(asks.length, 2, 'one request for each profile read, even when more members exist')
  assert.ok(asks.every(ask => ask.limit === 1 && ask.list.owner === author && ask.list.registry === mock.chain.blocking.registry))
  page = { items: [], next: address('88') }
  await assert.rejects(hasBlockedAccounts(mock.chain, author), /invalid list page/)
  page = { items: [address('88'), address('99')], next: null }
  await assert.rejects(hasBlockedAccounts(mock.chain, author), /invalid list page/)
})

for (const choice of ['all', 'keys', 'deactivated']) {
  test(`saving ${choice} writes the expected gate and uses the receipt ahead of the index`, async () => {
    await gates.ensureAuthor(mock.chain, author)
    const target = gateForChoice(mock.chain, choice)
    authorGateChanged(author, target, 2n)
    mock.receiptLogs = [mock.logs.at(-1)]
    mock.authorGate = zeroAddress; mock.head = 1n
    const w = wallet()
    assert.equal(await saveAuthorGate(w, mock.chain, author, choice), target)
    assert.equal(w.sent.length, 1)
    assert.equal(w.sent[0].to.toLowerCase(), mock.chain.contract)
    assert.equal(w.sent[0].from.toLowerCase(), author)
    assert.deepEqual(decodeFunctionData({ abi: boardAbi, data: w.sent[0].data }), { functionName: 'setAuthorGate', args: [target] })
    assert.equal(gates.author(mock.chain, author), target)
  })
}

test('another profile or a wallet switch cannot submit a gate change', async () => {
  const w = wallet()
  await assert.rejects(saveAuthorGate(w, mock.chain, address('77'), 'all'), /wallet for this profile/)
  w.ensureChain = async () => { w.account = address('88') }
  await assert.rejects(saveAuthorGate(w, mock.chain, author, 'all'), /changed accounts/)
  assert.deepEqual(w.sent, [])
})

test('a rejected wallet or reverted receipt leaves the current gate intact', async () => {
  await gates.ensureAuthor(mock.chain, author)
  const w = wallet()
  w.ensureChain = async () => { throw new Error('rejected by wallet') }
  await assert.rejects(saveAuthorGate(w, mock.chain, author, 'deactivated'), /rejected by wallet/)
  assert.deepEqual(w.sent, [])
  w.ensureChain = async () => {}
  mock.receiptStatus = '0x0'
  await assert.rejects(saveAuthorGate(w, mock.chain, author, 'deactivated'), Reverted)
  assert.equal(gates.author(mock.chain, author), zeroAddress)
})

test('the account reply rule is in settings for the connected account, without requiring keys, and not on the profile', async () => {
  const props = { chain: mock.chain, address: author }
  assert.doesNotMatch(await renderComponent('features/account/Settings.svelte', { ...props, address: null }), /who can reply/)
  assert.match(await renderComponent('features/account/Settings.svelte', props), /who can reply/)
  connected.account = author
  assert.doesNotMatch(await renderComponent('features/account/Profile.svelte', props), /who can reply/)
})

test('the combined key option is hidden before activation or gate deployment', async () => {
  await gates.ensureAuthor(mock.chain, author)
  const props = { chain: mock.chain, address: author, keyStatus: 'active' }
  let html = await renderComponent('features/account/AuthorGate.svelte', props)
  assert.match(html, /<option value="keys"[^>]*>key holders except blocked/)
  assert.doesNotMatch(html, /<option value="keys"[^>]*disabled/)
  for (const keyStatus of ['inactive', 'loading', 'failed', 'unavailable']) {
    html = await renderComponent('features/account/AuthorGate.svelte', { ...props, keyStatus })
    assert.doesNotMatch(html, /<option value="keys"/)
  }
  mock.chain.key_gates.holders_blocklist = null
  html = await renderComponent('features/account/AuthorGate.svelte', props)
  assert.doesNotMatch(html, /<option value="keys"/)
  assert.doesNotMatch(html, /not available on this chain yet/)
  assert.match(html, /all without block enforcement/)
})

test('settings without a configured key market never claims to be checking it', async () => {
  mock.chain.id = 8453
  connected.account = author
  const html = await renderComponent('features/account/Settings.svelte', { chain: mock.chain, address: author })
  assert.equal(html.includes('checking account keys…'), false)
  assert.equal(html.includes('activate account keys to use the key holder rule'), false)
  assert.match(html, /who can reply/)
  assert.doesNotMatch(html, /<option value="keys"/)
})

test('a failed key check hides the option without claiming to still be loading', async () => {
  await gates.ensureAuthor(mock.chain, author)
  const html = await renderComponent('features/account/AuthorGate.svelte', {
    chain: mock.chain, address: author, keyStatus: 'failed',
  })
  assert.equal(html.includes('checking account keys…'), false)
  assert.doesNotMatch(html, /<option value="keys"/)
})

test('the key option requires the same indexed market used by the verified combined gate', async () => {
  await gates.ensureAuthor(mock.chain, author)
  const props = { chain: mock.chain, address: author, keyStatus: 'active' }
  assert.equal(keyReplyDeployment(mock.chain, host.status.keyrings[0])?.address.toLowerCase(), process.env.VITE_ACCOUNT_KEYS_ADDRESS.toLowerCase())
  for (const indexed of [null, { chain: 8453, market: process.env.VITE_ACCOUNT_KEYS_ADDRESS }, { chain: mock.chain.id, market: address('77') }]) {
    host.status.keyrings = indexed ? [indexed] : []
    assert.equal(keyReplyDeployment(mock.chain, indexed), null)
    const html = await renderComponent('features/account/AuthorGate.svelte', props)
    assert.doesNotMatch(html, /<option value="keys"/)
    assert.doesNotMatch(html, /checking account keys/)
  }
})

test('a matching market alone does not enable a reply rule without both verified gates', () => {
  const indexed = host.status.keyrings[0]
  assert.ok(keyReplyDeployment(mock.chain, indexed))
  for (const changed of [
    { ...mock.chain, blocking: null },
    { ...mock.chain, key_gates: null },
    { ...mock.chain, key_gates: { holders: address('98') } },
  ]) assert.equal(keyReplyDeployment(changed, indexed), null)
  assert.equal(keyReplyDeployment(mock.chain, indexed, null), null)
})


test('an existing key rule stays visible while verification is unavailable', async () => {
  mock.authorGate = mock.chain.key_gates.holders_blocklist
  await gates.ensureAuthor(mock.chain, author)
  const html = await renderComponent('features/account/AuthorGate.svelte', {
    chain: mock.chain, address: author, keyStatus: 'failed',
  })
  assert.match(html, /<option value="keys"[^>]*disabled[^>]*>key holders except blocked/)
  assert.match(html, /<option value="all"/)
})


test('profile section links select Replies from the route, without saved tab state', async () => {
  const { router, parseLocation, href } = await load('features/navigation/router.svelte.ts')
  const previous = router.route
  const account = address('aa')
  try {
    for (const section of ['posts', 'replies']) {
      const path = section === 'posts' ? href.user(mock.chain.id, account) : href.userReplies(mock.chain.id, account)
      router.route = parseLocation(path)
      const html = await renderComponent('features/account/Profile.svelte', { chain: mock.chain, address: account })
      assert.match(html, new RegExp(`aria-current="page" href="${path}"[^>]*>${section}</a>`))
      assert.ok(html.includes(`href="${href.userReplies(mock.chain.id, account)}"`))
      assert.ok(html.includes(`href="${href.user(mock.chain.id, account)}"`))
    }
  } finally { router.route = previous }
})

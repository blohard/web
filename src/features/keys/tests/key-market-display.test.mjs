import assert from 'node:assert/strict'
import { test, after } from 'node:test'
process.env.VITE_ACCOUNT_KEYS_ADDRESS = '0x7777777777777777777777777777777777777777'
process.env.VITE_ACCOUNT_KEYS_DEV_FUND = '0x3333333333333333333333333333333333333333'
const { load, install, teardown, mock, author, address, txHash, renderComponent } = await import('../../../../scripts/harness.mjs')
const { Resource } = await load('shared/resource.svelte.ts')
const { wallet } = await load('lib/wallet.svelte.ts')
const { keyTransaction } = await load('features/keys/key-transaction.svelte.ts')
after(teardown)

test('a remounted trade keeps its quote and progress visible without presenting a live quote as reviewed', async t => {
  install(); mock.chain.id = 84532
  const previousAccount = wallet.account
  wallet.account = author
  const creator = address('33')
  const account = { active: true, supply: 5n, holdings: 2n, fees: 0n, blockNumber: 10n }
  const quote = { side: 'buy', amount: 1n, value: { total: 1000000000000000n } }
  let currentQuote = quote
  t.mock.method(Resource.prototype, 'value', (key = null) => key === null ? account : currentQuote)
  t.after(() => { wallet.account = previousAccount })
  const render = () => renderComponent('features/keys/KeyMarket.svelte', { chain: mock.chain, creator })
  const trade = html => html.match(/<button class="trade[^]*?<\/button>/)[0]
  const text = html => html.replace(/<[^>]*>/g, '')
  const resting = trade(await render())
  assert.match(text(resting), /buy 1 key[^]*~[^]*0\.001 ETH/)
  assert.doesNotMatch(resting, / disabled/)
  assert.doesNotMatch(resting, /class="[^"]*signing/)
  currentQuote = null
  const unavailable = trade(await render())
  assert.match(unavailable, / disabled/)
  assert.doesNotMatch(unavailable, /class="[^"]*signing/)
  assert.match(unavailable, /aria-busy="false"/)
  currentQuote = quote
  const tracking = keyTransaction(`blohard.account-keys.trade/84532/${process.env.VITE_ACCOUNT_KEYS_ADDRESS}/${creator}/${author}`)
  const release = tracking.acquire()
  t.after(() => { release(); tracking.hash = null })
  for (const hash of [null, txHash]) {
    tracking.hash = hash
    const html = await render()
    const button = trade(html)
    assert.equal(text(button), text(resting))
    assert.match(button, / disabled/)
    assert.doesNotMatch(button, /class="[^"]*signing/)
    assert.match(button, /aria-busy="true"/)
    assert.match(html, /<input[^>]*id="trade-keys"[^>]*disabled/)
    assert.match(html, /<button[^>]*aria-label="one fewer key"[^>]*disabled/)
    assert.match(html, /<button[^>]*aria-label="one more key"[^>]*disabled/)
    assert.match(html, /<p[^>]*transaction-status[^>]*working[^>]*role="status"[^>]*>transaction in progress/)
  }
})

test('circulation links to the creator holders only for the indexed market, without requiring a wallet', async t => {
  install(); mock.chain.id = 84532
  const { host } = await load('lib/host.svelte.ts')
  const { href } = await load('features/navigation/router.svelte.ts')
  const saved = { account: wallet.account, status: host.status }
  t.after(() => { wallet.account = saved.account; host.status = saved.status })
  wallet.account = null
  const creator = address('33')
  t.mock.method(Resource.prototype, 'value', function(key = null) {
    return key === null ? { active: true, supply: 5n, holdings: 0n, fees: 0n, blockNumber: 10n } : null
  })
  const render = () => renderComponent('features/keys/KeyMarket.svelte', { chain: mock.chain, creator })
  host.status = { keyrings: [{ chain: 84532, market: process.env.VITE_ACCOUNT_KEYS_ADDRESS }] }
  const html = await render()
  assert.ok(html.includes(`href="${href.keyHolders(84532, creator)}"`))
  assert.ok(html.includes(`href="${href.keyring(84532, creator)}"`))
  assert.match(html, /keys in circulation<\/dt><dd[^>]*>[^]*?title="view key holders"[^>]*>5<\/a>/)
  for (const keyring of [null, { chain: 8453, market: process.env.VITE_ACCOUNT_KEYS_ADDRESS }, { chain: 84532, market: address('88') }]) {
    host.status = { keyrings: keyring ? [keyring] : [] }
    const unavailable = await render()
    assert.doesNotMatch(unavailable, /view key holders/)
    assert.match(unavailable, /keys in circulation<\/dt><dd[^>]*>[^]*?5/)
  }
})


test('an idle market has no recovery status', async t => {
  install(); mock.chain.id = 84532
  const saved = { account: wallet.account }
  t.after(() => { wallet.account = saved.account })
  wallet.account = author
  t.mock.method(Resource.prototype, 'value', function(key = null) {
    return key === null ? { active: true, supply: 5n, holdings: 2n, fees: 1n, blockNumber: 10n } : null
  })
  const html = await renderComponent('features/keys/KeyMarket.svelte', { chain: mock.chain, creator: author })
  assert.doesNotMatch(html, /transaction-status/)
})

test('a recovered transaction is shown independently of buy, sell, transfer and claim controls', async t => {
  install(); mock.chain.id = 84532
  const saved = { account: wallet.account }
  t.after(() => { wallet.account = saved.account })
  wallet.account = author
  t.mock.method(Resource.prototype, 'value', function(key = null) {
    return key === null ? { active: true, supply: 5n, holdings: 2n, fees: 1n, blockNumber: 10n } : null
  })
  const tracking = keyTransaction(`blohard.account-keys.trade/84532/${process.env.VITE_ACCOUNT_KEYS_ADDRESS}/${author}/${author}`)
  tracking.hash = txHash
  t.after(() => { tracking.hash = null })
  const html = await renderComponent('features/keys/KeyMarket.svelte', { chain: mock.chain, creator: author })
  const status = html.indexOf('transaction-status'), tabs = html.indexOf('aria-label="trade direction"')
  assert.ok(status >= 0 && status < tabs, 'recovery status is above the tabs, not attached to buy')
  assert.equal((html.match(/transaction-status/g) ?? []).length, 1)
})


test('profiles expose keys for an indexed market before the account activates', async t => {
  install(); mock.chain.id = 84532
  const { host } = await load('lib/host.svelte.ts')
  const { href } = await load('features/navigation/router.svelte.ts')
  const saved = { account: wallet.account, status: host.status }
  t.after(() => { wallet.account = saved.account; host.status = saved.status })
  wallet.account = null
  t.mock.method(Resource.prototype, 'value', () => false)
  const creator = address('33')
  const render = () => renderComponent('features/account/Profile.svelte', { chain: mock.chain, address: creator })
  const keysLink = `href="${href.userKeys(84532, creator)}"`
  host.status = { keyrings: [{ chain: 84532, market: process.env.VITE_ACCOUNT_KEYS_ADDRESS }] }
  assert.ok((await render()).includes(keysLink), 'activation is not required to find holdings')
  for (const keyring of [null, { chain: 8453, market: process.env.VITE_ACCOUNT_KEYS_ADDRESS }, { chain: 84532, market: address('88') }]) {
    host.status = { keyrings: keyring ? [keyring] : [] }
    assert.ok(!(await render()).includes(keysLink), 'an unrelated index cannot enable holdings')
  }
})

test('an inactive account exposes its keyring without offering trades, with or without a wallet', async t => {
  install(); mock.chain.id = 84532
  const { host } = await load('lib/host.svelte.ts')
  const { href } = await load('features/navigation/router.svelte.ts')
  const saved = { account: wallet.account, status: host.status }
  t.after(() => { wallet.account = saved.account; host.status = saved.status })
  host.status = { keyrings: [{ chain: 84532, market: process.env.VITE_ACCOUNT_KEYS_ADDRESS }] }
  const creator = address('33')
  t.mock.method(Resource.prototype, 'value', (key = null) => key === null
    ? { active: false, supply: 0n, holdings: 0n, fees: 0n, blockNumber: 10n } : null)
  const render = () => renderComponent('features/keys/KeyMarket.svelte', { chain: mock.chain, creator })
  for (const account of [null, author, creator]) {
    wallet.account = account
    const html = await render()
    assert.ok(html.includes(`href="${href.keyring(84532, creator)}"`))
    assert.match(html, /this account has not activated keys/)
    assert.doesNotMatch(html, /aria-label="trade direction"/)
  }
  host.status = { keyrings: [{ chain: 84532, market: address('88') }] }
  assert.doesNotMatch(await render(), /view keyring/)
})

for (const [id, explorer] of [[8453, 'https://basescan.org'], [84532, 'https://sepolia.basescan.org']]) {
  test(`key market and pending transaction links use chain ${id}'s explorer`, async () => {
    install()
    const chain = { ...mock.chain, id }
    const about = await renderComponent('features/keys/AccountKeysAbout.svelte', { chain })
    assert.ok(about.includes(`href="${explorer}/address/${process.env.VITE_ACCOUNT_KEYS_ADDRESS}"`))
    for (const action of ['activation', 'trade']) {
      const page = { action, phase: 'transaction pending…', tracking: { hash: txHash, busy: false, saved: true } }
      const html = await renderComponent('features/keys/KeyTransactionStatus.svelte', { chain, page, error: '' })
      assert.ok(html.includes(`href="${explorer}/tx/${txHash}"`))
    }
  })
}

test('an unknown chain never links a pending key transaction to another network', async () => {
  install()
  const page = { action: 'trade', phase: '', tracking: { hash: txHash, busy: false, saved: true } }
  const html = await renderComponent('features/keys/KeyTransactionStatus.svelte', { chain: { ...mock.chain, id: 999 }, page, error: '' })
  assert.doesNotMatch(html, /href=/)
  assert.ok(html.includes(txHash))
})

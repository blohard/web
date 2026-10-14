import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { zeroAddress } from 'viem'
import { load, install, teardown, mock, address, renderComponent } from '../../../../scripts/harness.mjs'
const { KeyControls, keyControls } = await load('features/keys/key-controls.svelte.ts')
const { forgetKeyrings } = await load('features/keys/keyring.ts')
const { host } = await load('lib/host.svelte.ts')
const { wallet } = await load('lib/wallet.svelte.ts')
const alice = address('22'), bob = address('33'), market = address('77')
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
let active, holding, calls
beforeEach(() => {
  install()
  forgetKeyrings()
  wallet.account = null
  host.status = { chains: [mock.chain], keyrings: [{ chain: mock.chain.id, market }] }
  active = false; holding = []; calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({ market, active, holding, holders: [], truncated: { holding: false, holders: false } })
  }
})
after(teardown)

test('hidden controls cost no requests without a wallet or an indexed chain', async () => {
  const controls = new KeyControls()
  controls.watch(mock.chain, null)()
  controls.watch({ ...mock.chain, id: mock.chain.id + 1 }, alice)()
  await settle()
  assert.equal(calls, 0)
  assert.equal(controls.available(mock.chain, null), false)
  assert.equal(controls.available(mock.chain, alice), false)
})

test('activation or an existing holding reveals management', async () => {
  const controls = new KeyControls()
  for (const [activated, holdings, available] of [[false, [], false], [false, [bob], true], [true, [], true]]) {
    // Each change is seen after a refresh or a confirmed key transaction.
    forgetKeyrings()
    active = activated; holding = holdings
    const stop = controls.watch(mock.chain, alice)
    await settle()
    assert.equal(controls.available(mock.chain, alice), available)
    for (let i = 0; i < 20; i++) controls.available(mock.chain, alice)
    stop()
  }
  assert.equal(calls, 3, 'navigation controls share the result instead of making individual reads')
  controls.watch(mock.chain, alice)()
  await settle()
  assert.equal(calls, 3, 'the next page visit reuses the recent read')
  assert.equal(controls.available(mock.chain, bob), false)
  assert.equal(controls.available(mock.chain, null), false)
  host.status.keyrings[0].market = address('88')
  assert.equal(controls.available(mock.chain, alice), false)
})

test('late and failed lookups cannot enable a different wallet', async () => {
  const controls = new KeyControls()
  let finish
  globalThis.fetch = () => new Promise(resolve => { finish = resolve })
  const stop = controls.watch(mock.chain, alice)
  stop()
  finish(Response.json({ market, active: true, holding: [], holders: [], truncated: { holding: false, holders: false } }))
  await settle()
  assert.equal(controls.available(mock.chain, alice), false)
  globalThis.fetch = async () => Response.json({ error: 'keyring_syncing' }, { status: 503 })
  controls.watch(mock.chain, bob)
  await settle()
  assert.equal(controls.available(mock.chain, bob), false)
})

test('reply pickers and settings management appear only when useful and hide on disconnect', async () => {
  const props = { chain: mock.chain, address: alice, gate: zeroAddress, onsave() {} }
  for (const [activated, holdings] of [[false, []], [false, [bob]], [true, []]]) {
    forgetKeyrings()
    wallet.account = alice; active = activated; holding = holdings
    const stop = keyControls.watch(mock.chain, alice)
    await settle()
    const picker = await renderComponent('features/account/PostReplyRule.svelte', props)
    assert.equal(picker.includes('aria-expanded='), true, 'ordinary reply rules do not require keys')
    const settings = await renderComponent('features/account/Settings.svelte', { chain: mock.chain, address: alice })
    assert.equal(settings.includes('manage keyring'), activated || holdings.length > 0)
    const sidebar = await renderComponent('features/navigation/Sidebar.svelte', { selected: mock.chain })
    assert.equal(sidebar.includes(`href="/u/${mock.chain.id}/${alice}/keyring"`), activated || holdings.length > 0)
    stop()
  }
  wallet.account = null
  assert.doesNotMatch(await renderComponent('features/account/PostReplyRule.svelte', props), /aria-expanded=/)
  assert.doesNotMatch(await renderComponent('features/account/Settings.svelte', { chain: mock.chain, address: null }), /manage keyring|account key activation/)
  assert.doesNotMatch(await renderComponent('features/navigation/Sidebar.svelte', { selected: mock.chain }), /href="\/u\/[^" ]+\/keyring"/)
})


test('reply controls remain available on Base mainnet without any indexed key market', async () => {
  host.status.keyrings = []
  wallet.account = alice
  const chain = { ...mock.chain, id: 8453 }
  const props = { chain, address: alice, gate: zeroAddress, onsave() {} }
  for (const postId of [null, 12n]) {
    assert.match(await renderComponent('features/account/PostReplyRule.svelte', { ...props, postId }), /aria-expanded=/)
  }
  wallet.account = bob
  assert.doesNotMatch(await renderComponent('features/account/PostReplyRule.svelte', props), /aria-expanded=/)
})


test("a post's own reply rule marks its picker, which keeps the full summary as its name", async () => {
  wallet.account = alice
  const props = { chain: mock.chain, address: alice, onsave() {} }
  const button = html => html.replace(/<!--[^]*?-->/g, '').match(/<button[^>]*aria-expanded=[^>]*>.*?<\/button>/s)?.[0] ?? ''
  const inherited = button(await renderComponent('features/account/PostReplyRule.svelte', { ...props, gate: zeroAddress }))
  assert.doesNotMatch(inherited, /own-rule/, 'the account default is no rule of its own')
  assert.match(inherited, /aria-label="reply rule"[^>]*>reply rule<\/button>/)
  const own = button(await renderComponent('features/account/PostReplyRule.svelte', { ...props, gate: mock.chain.blocking.gate }))
  assert.match(own, /class="[^"]*\bown-rule\b/)
  assert.match(own, /aria-label="reply rule · all"/)
  assert.match(own, />reply rule<span class="rule-detail[^"]*"> · all<\/span><\/button>/)
  wallet.account = null
})

test('the selected keyring remains selected while the wallet restores', async t => {
  const previous = globalThis.localStorage
  globalThis.localStorage = { getItem: key => key === 'blohard.home.tab' ? '"keyring"' : null }
  t.after(() => { globalThis.localStorage = previous; wallet.restoring = false; wallet.account = null })
  wallet.restoring = true
  let page = await renderComponent('features/streams/Home.svelte', { chain: mock.chain })
  assert.match(page, /keyring views/)
  assert.match(page, /connecting to your wallet/)
  assert.doesNotMatch(page, /curated accounts/)
  wallet.restoring = false
  page = await renderComponent('features/streams/Home.svelte', { chain: mock.chain })
  assert.match(page, /keyring views/)
  assert.match(page, /connect your wallet to see your keyring/)
  wallet.account = alice
  page = await renderComponent('features/streams/Home.svelte', { chain: mock.chain })
  assert.match(page, /keyring views/)
  // The keyring is loading; its spinner waits 300 ms (tests/ui/keyring.spec.mjs).
  assert.match(page, /class="keyring-start[^"]*" aria-busy="true"/)
  assert.doesNotMatch(page, /loading your keyring/)
})

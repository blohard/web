import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, mock, address, hash, deferred, renderComponent } from '../../../../scripts/harness.mjs'
const { KeyBadges } = await load('features/keys/key-badges.ts')
const { host } = await load('lib/host.svelte.ts')
const { wallet } = await load('lib/wallet.svelte.ts')
const { href } = await load('features/navigation/router.svelte.ts')
const alice = address('22'), market = address('77')
let calls, active
const answer = () => Response.json({ market, view: 'holding', active, own_balance: 0,
  entries: [], total: 0, next: null, checkpoint: { block: '12', hash: hash('aa') } })
beforeEach(() => {
  install()
  calls = []; active = true
  wallet.account = null
  host.status = { chains: [mock.chain], keyrings: [{ chain: mock.chain.id, market }] }
  globalThis.fetch = async url => { calls.push(String(url)); return answer() }
})
after(teardown)

test('many signed out cards for one author share a one row indexed read', async () => {
  const cache = new KeyBadges()
  assert.deepEqual(await Promise.all(Array.from({ length: 40 }, () => cache.read(mock.chain, market, alice))), Array(40).fill(true))
  assert.equal(await cache.read(mock.chain, market, alice), true)
  assert.deepEqual(calls, [`/api/chains/${mock.chain.id}/keyring/${alice}/balances?view=holding&limit=1`])
})

test('negative answers refresh after five minutes and an activation holds for the session', async t => {
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  t.after(() => { Date.now = realNow })
  const cache = new KeyBadges()
  active = false
  assert.equal(await cache.read(mock.chain, market, alice), false)
  active = true
  assert.equal(await cache.read(mock.chain, market, alice), false)
  now += 300_001
  assert.equal(await cache.read(mock.chain, market, alice), true)
  // Activation is one-way on chain, so a yes is never asked again.
  now += 24 * 3_600_000
  globalThis.fetch = async () => { calls.push('failed'); throw new Error('offline') }
  for (let i = 0; i < 20; i++) assert.equal(await cache.read(mock.chain, market, alice), true)
  assert.equal(calls.length, 2)
})

test('failed initial reads back off and never invent activation', async () => {
  const cache = new KeyBadges()
  globalThis.fetch = async () => { calls.push('failed'); return Response.json({ error: 'syncing' }, { status: 503 }) }
  for (let i = 0; i < 20; i++) assert.equal(await cache.read(mock.chain, market, alice), false)
  assert.equal(calls.length, 1)
})

test('a late answer cannot give a new market the old activation', async () => {
  const cache = new KeyBadges(), waiting = deferred()
  globalThis.fetch = () => waiting.promise
  const old = cache.read(mock.chain, market, alice)
  globalThis.fetch = async () => answer()
  assert.equal(await cache.read(mock.chain, address('88'), alice), false)
  waiting.resolve(answer())
  assert.equal(await old, true)
  assert.equal(await cache.read(mock.chain, address('88'), alice), false)
  active = false
  assert.equal(await cache.read({ ...mock.chain, contract: address('99') }, market, alice), false)
})

test('the badge reserves its slot while hidden and links to the author market without a wallet', async () => {
  const props = { chain: mock.chain, address: alice, compact: true }
  const hidden = await renderComponent('features/keys/AccountKeyBadge.svelte', { ...props, active: false })
  const shown = await renderComponent('features/keys/AccountKeyBadge.svelte', { ...props, active: true })
  assert.match(hidden, /key-slot/)
  assert.doesNotMatch(hidden, /<a /)
  assert.match(shown, /key-slot/)
  assert.ok(shown.includes(`href="${href.userKeys(mock.chain.id, alice)}"`))
  assert.match(shown, /account keys active · view keys/)
  const otherChain = { ...mock.chain, id: mock.chain.id + 1 }
  assert.doesNotMatch(await renderComponent('features/keys/StreamKeyBadge.svelte', { ...props, chain: otherChain }), /key-slot/)
  assert.equal(calls.length, 0)
})

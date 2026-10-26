import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, mock, address, hash, deferred, renderComponent } from '../../../../scripts/harness.mjs'
const { readKeyringPage, holdsKey, byQuantity, keyringPageChanged } = await load('features/keys/keyring-balances.ts')
const { KeyringBalancesView } = await load('features/keys/keyring-balances-view.svelte.ts')
const { parse, href } = await load('features/navigation/router.svelte.ts')
const market = address('77'), account = address('22'), creator = address('33')
const raw = () => ({ market, view: 'holding', active: true, own_balance: 3, total: 1,
  entries: [{ address: creator, balance: 2 }], next: null, checkpoint: { block: '100', hash: hash('55') } })
const page = () => ({ active: true, ownBalance: 3, total: 1,
  entries: [{ address: creator, balance: 2 }], next: null, checkpoint: { block: 100n, hash: hash('55') } })
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
beforeEach(install)
after(teardown)

test('keyring tabs have public paths and reject hash and malformed routes', () => {
  const path = `/u/84532/${account}/keyring`
  assert.equal(href.keyring(84532, account), path)
  assert.equal(href.keyHolders(84532, account), path + '/holders')
  assert.deepEqual(parse(path), { kind: 'keyring', chainId: 84532, address: account })
  assert.deepEqual(parse(path + '/holders'), { kind: 'keyring', chainId: 84532, address: account, holders: true })
  for (const bad of [path + '/extra', path + '/holders/extra', path.replace('84532', '0'), path.replace(account, 'bad'),
    '#/keyring/84532', `#/keyring/84532/${account}`, `#/keyring/84532/${account}/holders`, '#' + path]) {
    assert.equal(parse(bad).kind, 'unknown', bad)
  }
})
test('profile discovery requests one indexed holding and accepts its cursor', async () => {
  let seen
  globalThis.fetch = async url => { seen = url; return Response.json({ ...raw(), total: 2, next: creator }) }
  const result = await readKeyringPage(mock.chain, account, market, 'holding', null, 1)
  assert.equal(result.total, 2)
  assert.equal(result.next, creator)
  assert.match(seen, /view=holding&limit=1$/)
  for (const limit of [0, 257, 1.5]) {
    await assert.rejects(readKeyringPage(mock.chain, account, market, 'holding', null, limit), /page size/)
  }
})
test('balance reads use only the paged host endpoint and keep self separate', async () => {
  let seen
  globalThis.fetch = async url => { seen = url; return Response.json(raw()) }
  assert.deepEqual(await readKeyringPage(mock.chain, account, market, 'holding', null), page())
  assert.equal(seen, `/api/chains/${mock.chain.id}/keyring/${account}/balances?view=holding&limit=64`)
  globalThis.fetch = async url => { seen = url; return Response.json({ ...raw(), view: 'holders' }) }
  await readKeyringPage(mock.chain, account, market, 'holders', address('11'))
  assert.match(seen, /view=holders&limit=64&after=0x11/)
})
test('invalid market, quantities, ordering, cursor and checkpoint never become a usable list', async () => {
  const entry = raw().entries[0]
  for (const change of [
    { market: address('88') }, { view: 'holders' }, { active: 1 }, { own_balance: -1 }, { own_balance: 2 ** 32 },
    { total: 0 }, { total: 1.5 }, { entries: null }, { entries: [entry, entry], total: 2 },
    { entries: [{ ...entry, address: account }] }, { entries: [{ ...entry, address: 'bad' }] },
    ...[0, -1, 1.5, 2 ** 32, '1'].map(balance => ({ entries: [{ ...entry, balance }] })),
    { next: creator }, { next: 'bad' }, { next: undefined },
    { checkpoint: null }, { checkpoint: { block: '-1', hash: hash('55') } },
    { checkpoint: { block: '18446744073709551616', hash: hash('55') } },
    { checkpoint: { block: '1', hash: '0x00' } },
  ]) {
    globalThis.fetch = async () => Response.json({ ...raw(), ...change })
    await assert.rejects(readKeyringPage(mock.chain, account, market, 'holding', null), /invalid keyring/)
  }
  globalThis.fetch = async () => Response.json(raw())
  await assert.rejects(readKeyringPage(mock.chain, account, market, 'holding', creator), /invalid keyring/)
  globalThis.fetch = async () => Response.json({ error: 'keyring_syncing' }, { status: 503 })
  await assert.rejects(readKeyringPage(mock.chain, account, market, 'holding', null), /keyring syncing/)
})
test('sorting stays within the page and never changes the address cursor', async () => {
  const entries = Array.from({ length: 64 }, (_, i) => ({ address: `0x${(100 + i).toString(16).padStart(40, '0')}`, balance: i + 1 }))
  globalThis.fetch = async () => Response.json({ ...raw(), total: 70, entries, next: entries.at(-1).address })
  const result = await readKeyringPage(mock.chain, account, market, 'holding', null)
  const sorted = byQuantity(result.entries)
  assert.equal(sorted[0].balance, 64)
  assert.equal(result.entries[0].balance, 1)
  assert.equal(result.next.toLowerCase(), entries.at(-1).address)
  assert.equal(keyringPageChanged(result, { ...result, checkpoint: { block: 101n, hash: hash('66') } }), false)
  assert.equal(keyringPageChanged(result, { ...result, total: 71 }), true)
})

async function withPolling(run) {
  const saved = { window: globalThis.window, document: globalThis.document, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  const timers = new Map(); let id = 0
  globalThis.window = new EventTarget()
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  globalThis.setInterval = (callback, delay) => { assert.equal(delay, 30000); timers.set(++id, callback); return id }
  globalThis.clearInterval = id => timers.delete(id)
  try { await run(timers) } finally { Object.assign(globalThis, saved) }
}
test('polls cue refresh without replacing balances or unfolding failed refreshes', async () => withPolling(async timers => {
  let latest = page(), fail = false, reads = 0
  const view = new KeyringBalancesView(async () => { reads++; if (fail) throw Error('offline'); return latest })
  let stop = view.watch(); await settle()
  const shown = view.shown
  assert.equal(reads, 1, 'opening does not duplicate the first read')
  latest = { ...page(), entries: [{ address: creator, balance: 9 }] }
  await [...timers.values()][0]()
  assert.equal(view.changed, true)
  assert.equal(view.shown, shown)
  fail = true
  await [...timers.values()][0]()
  assert.equal(view.changed, true)
  stop(); stop = view.watch(); await settle()
  assert.equal(view.shown, shown)
  assert.match(view.page.failure(view.key).cause.message, /offline/)
  fail = false; stop(); stop = view.watch(); await settle()
  assert.equal(view.shown.entries[0].balance, 9)
  assert.equal(view.changed, false)
  stop()
}))
test('pagination and tab remounts use explicit cursors and ignore old requests', async () => withPolling(async () => {
  const calls = [], pending = deferred()
  const read = async (side, after) => {
    calls.push([side, after])
    return after ? pending.promise : { ...page(), total: 65, next: creator }
  }
  let view = new KeyringBalancesView(read)
  let stop = view.watch(); await settle()
  view.next(); stop(); stop = view.watch()
  assert.deepEqual(calls, [['holding', null], ['holding', creator]])
  assert.equal(view.shown, null)
  stop()
  const departed = view
  view = new KeyringBalancesView(read, { side: 'holders', after: null, previous: [] })
  stop = view.watch(); await settle()
  pending.resolve({ ...page(), entries: [{ address: address('44'), balance: 99 }] }); await settle()
  assert.equal(departed.shown, null, 'a departed tab ignores its late page')
  assert.equal(view.side, 'holders')
  assert.equal(view.previous.length, 0)
  assert.equal(view.shown.entries[0].balance, 2)
  stop()
}))
test('Back returns to the tab and page being read', async () => withPolling(async () => {
  const calls = []
  const view = new KeyringBalancesView(async (side, after) => { calls.push([side, after]); return { ...page(), next: creator } },
    { side: 'holders', after: creator, previous: [null] })
  const stop = view.watch(); await settle()
  assert.deepEqual(calls, [['holders', creator]], 'the saved page is read, not the first')
  view.next()
  const place = view.place
  assert.deepEqual(place, { side: 'holders', after: creator, previous: [null, creator] })
  view.back()
  assert.deepEqual(place.previous, [null, creator], 'the saved place is a copy')
  stop()
}))
test('leaving or switching accounts ignores in-flight results', async () => withPolling(async () => {
  const old = deferred()
  const oldView = new KeyringBalancesView(() => old.promise)
  const stopOld = oldView.watch(); stopOld()
  const newView = new KeyringBalancesView(async () => ({ ...page(), ownBalance: 0, entries: [], total: 0 }))
  const stopNew = newView.watch(); await settle()
  old.resolve(page()); await settle()
  assert.equal(oldView.shown, null)
  assert.equal(newView.shown.ownBalance, 0)
  assert.deepEqual(newView.shown.entries, [])
  stopNew()
}))
test('rows show quantities and own keys with links to the existing markets', async () => {
  const html = await renderComponent('features/keys/KeyringBalances.svelte', { chain: mock.chain, account, page: page(), side: 'holding' })
  assert.match(html, /your own keys/)
  assert.ok(html.indexOf(href.keysAbout(mock.chain.id)) > html.indexOf(href.userKeys(mock.chain.id, account)))
  assert.match(html, /3 keys/)
  assert.match(html, /2 keys/)
  assert.ok(html.includes(href.userKeys(mock.chain.id, creator)))
  assert.ok(html.includes(href.userKeys(mock.chain.id, account)))
  const holders = await renderComponent('features/keys/KeyringBalances.svelte', { chain: mock.chain, account, page: page(), side: 'holders' })
  assert.ok(holders.includes(href.user(mock.chain.id, creator)))
  assert.ok(!holders.includes(href.userKeys(mock.chain.id, creator)), 'a holder is not the creator of the held keys')
})
test('signed-out and unsupported management pages do not fetch', async () => {
  globalThis.fetch = async () => { assert.fail('no lookup without account and market') }
  const signedOut = await renderComponent('features/keys/KeyringManagement.svelte', { chain: mock.chain, account: null, market })
  assert.match(signedOut, /connect your wallet/)
  const unsupported = await renderComponent('features/keys/KeyringManagement.svelte', { chain: mock.chain, account, market: null })
  assert.match(unsupported, /not available on this chain/)
})
test('public keyrings render without a wallet and label markets as viewing another account', async () => {
  const { wallet } = await load('lib/wallet.svelte.ts')
  const saved = wallet.account
  try {
    for (const viewer of [null, address('99')]) {
      wallet.account = viewer
      const html = await renderComponent('features/keys/KeyringManagement.svelte', { chain: mock.chain, account, market })
      assert.match(html, /keys they hold/)
      assert.match(html, /their key holders/)
      assert.doesNotMatch(html, /view profile/)
      assert.doesNotMatch(html, /connect your wallet|activate account keys/)
    }
    wallet.account = account
    const own = await renderComponent('features/keys/KeyringManagement.svelte', { chain: mock.chain, account, market })
    assert.match(own, /keys I hold/)
    assert.match(own, /my key holders/)
    const rows = await renderComponent('features/keys/KeyringBalances.svelte', { chain: mock.chain, account, page: page(), side: 'holding', own: false })
    assert.match(rows, /their own keys/)
    assert.match(rows, /view market/)
    assert.doesNotMatch(rows, /your own keys|manage your keys/)
    assert.ok(rows.includes(href.userKeys(mock.chain.id, creator)))
  } finally { wallet.account = saved }
})

test('a keyring URL selects its pane without a wallet even if a different pane was saved', async t => {
  const { router } = await load('features/navigation/router.svelte.ts')
  const { Visit } = await load('features/navigation/visits.ts')
  const { wallet } = await load('lib/wallet.svelte.ts')
  const saved = { visit: router.visit, account: wallet.account }
  t.after(() => { router.visit = saved.visit; wallet.account = saved.account })
  wallet.account = null
  router.visit = new Visit(100)
  const render = () => renderComponent('features/keys/KeyringManagement.svelte', { chain: mock.chain, account, market, initialSide: 'holders' })
  assert.match(await render(), /aria-current="page"[^>]*>their key holders/)
  const place = router.visit.state(`keyring/${mock.chain.id}/${account}`, () => assert.fail('visit must already be saved'))
  assert.equal(place.side, 'holders')
  place.side = 'holding'
  assert.match(await render(), /aria-current="page"[^>]*>their key holders/)
})

test('profile key holding seeks one creator beyond truncated membership, with no wallet read', async () => {
  const calls = []
  globalThis.fetch = async url => {
    calls.push(url)
    return Response.json({ ...raw(), total: 1000, next: creator })
  }
  assert.equal(await holdsKey(mock.chain, account, market, creator), true)
  const url = new URL(calls[0], 'https://host.invalid')
  assert.equal(url.pathname, `/api/chains/${mock.chain.id}/keyring/${account}/balances`)
  assert.equal(url.searchParams.get('view'), 'holding')
  assert.equal(url.searchParams.get('limit'), '1')
  assert.equal(BigInt(url.searchParams.get('after')), BigInt(creator) - 1n)
  assert.equal(calls.length, 1)
  globalThis.fetch = async () => Response.json({ ...raw(), entries: [{ address: address('44'), balance: 1 }] })
  assert.equal(await holdsKey(mock.chain, account, market, creator), false)
  globalThis.fetch = async () => Response.json({ ...raw(), entries: [], total: 0 })
  assert.equal(await holdsKey(mock.chain, account, market, creator), false)
  globalThis.fetch = async () => Response.json({ error: 'keyring_syncing' }, { status: 503 })
  await assert.rejects(holdsKey(mock.chain, account, market, creator), /keyring syncing/)
})

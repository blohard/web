import { test, expect, author, stranger, deferred } from './host.mjs'

const other = '0x4444444444444444444444444444444444444444'

async function setup(page, host, { viewer = author, indexed = true } = {}) {
  const market = host.chain.contract
  await page.route('**/api/status', async route => {
    const status = await (await host.answer(route.request())).json()
    if (indexed) status.keyrings = [{ chain: host.chain.id, market, start_block: 0 }]
    await route.fulfill({ json: status })
  })
  await page.route('**/keyring/*', route => route.fulfill({ json: {
    market, active: true, holding: [], holders: [], truncated: { holding: false, holders: false },
  } }))
  await page.route('**/keyring/*/trades?*', route => route.fulfill({ json: {
    market, active: true, items: [], next: null, truncated: false, checkpoint: host.at.checkpoint,
  } }))
  await page.addInitScript(viewer => {
    let account = viewer
    const listeners = new Map()
    window.walletCalls = []
    window.switchAccount = who => {
      account = who
      for (const fn of listeners.get('accountsChanged') ?? []) fn([who])
    }
    window.ethereum = {
      on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]) },
      removeListener() {},
      async request({ method }) {
        window.walletCalls.push(method)
        if (method === 'eth_accounts') return account ? [account] : []
        if (method === 'eth_blockNumber') return '0x100'
        if (method === 'eth_chainId') return '0x14a34'
        if (method === 'wallet_revokePermissions') return null
        throw new Error(`unexpected wallet call: ${method}`)
      },
    }
  }, viewer)
  return (entries = []) => ({ market, view: 'holding', active: false, own_balance: 0,
    entries, total: entries.length, next: null, checkpoint: host.at.checkpoint })
}

for (const width of [1100, 390]) test(`profile identifies a holder of your key at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 850 })
  const answer = await setup(page, host)
  const started = deferred(), release = deferred()
  await page.route('**/keyring/*/balances?*', async route => {
    const url = new URL(route.request().url())
    expect(url.pathname).toContain(`/keyring/${stranger}/balances`)
    expect(url.searchParams.get('limit')).toBe('1')
    expect(BigInt(url.searchParams.get('after'))).toBe(BigInt(author) - 1n)
    started.resolve(); await release.promise
    // The holder need not activate a market of their own, and the result may
    // lie beyond the truncated keyring membership used for feeds.
    await route.fulfill({ json: { ...answer([{ address: author, balance: 2 }]), total: 1000, next: author } })
  })
  const label = page.locator('.profile').getByText('holds your key', { exact: true })
  try {
    await page.goto(`/u/84532/${stranger}`)
    await started.promise
    await expect(label).toHaveCount(0)
    release.resolve()
    await expect(label).toBeVisible()
    const bounds = await label.boundingBox()
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    expect(await page.evaluate(() => window.walletCalls)).not.toContain('eth_call')
    if (width === 390) await page.getByRole('button', { name: 'menu', exact: true }).click()
    await page.getByRole('button', { name: /disconnect/ }).filter({ visible: true }).click()
    await expect(label).toHaveCount(0)
  } finally { release.resolve() }
})

for (const scenario of ['signed out', 'own profile', 'no index', 'not holding', 'unavailable']) {
  test(`profile hides the key-holder label when ${scenario}`, async ({ page, host }) => {
    const answer = await setup(page, host, { viewer: scenario === 'signed out' ? null : author, indexed: scenario !== 'no index' })
    let reads = 0
    await page.route('**/keyring/*/balances?*', async route => {
      reads++
      await route.fulfill(scenario === 'unavailable'
        ? { status: 503, json: { code: 'keyring_syncing', error: 'keyring syncing' } }
        : { json: answer([{ address: other, balance: 1 }]) })
    })
    await page.goto(`/u/84532/${scenario === 'own profile' ? author : stranger}`)
    await expect(page.locator('.profile')).toBeVisible()
    if (scenario === 'not holding' || scenario === 'unavailable') await expect.poll(() => reads).toBe(1)
    else expect(reads).toBe(0)
    await expect(page.getByText('holds your key', { exact: true })).toHaveCount(0)
  })
}

test('a late holding answer cannot label a different connected account', async ({ page, host }) => {
  const answer = await setup(page, host)
  const started = deferred(), release = deferred()
  let otherRead = false
  await page.route('**/keyring/*/balances?*', async route => {
    const after = BigInt(new URL(route.request().url()).searchParams.get('after'))
    if (after === BigInt(author) - 1n) {
      started.resolve(); await release.promise
      await route.fulfill({ json: answer([{ address: author, balance: 1 }]) })
    } else {
      expect(after).toBe(BigInt(other) - 1n)
      otherRead = true
      await route.fulfill({ json: answer() })
    }
  })
  try {
    await page.goto(`/u/84532/${stranger}`)
    await started.promise
    await page.evaluate(who => window.switchAccount(who), other)
    await expect.poll(() => otherRead).toBe(true)
    const completed = page.waitForResponse(response => response.url().includes('/balances?') && response.url().includes((BigInt(author) - 1n).toString(16)))
    release.resolve()
    await completed
    await expect(page.getByText('holds your key', { exact: true })).toHaveCount(0)
  } finally { release.resolve() }
})

test('profile navigation and a failed return read never retain the old holder label', async ({ page, host }) => {
  const answer = await setup(page, host)
  let fail = false, reads = 0
  await page.route('**/keyring/*/balances?*', async route => {
    reads++
    await route.fulfill(fail
      ? { status: 503, json: { code: 'keyring_syncing', error: 'keyring syncing' } }
      : { json: answer([{ address: author, balance: 1 }]) })
  })
  await page.goto(`/u/84532/${stranger}`)
  const label = page.getByText('holds your key', { exact: true })
  await expect(label).toBeVisible()
  await page.locator('.wallet a.account').click()
  await expect(page).toHaveURL(new RegExp(`/u/84532/${author}$`))
  await expect(label).toHaveCount(0)
  expect(reads).toBe(1)
  fail = true
  await page.goBack()
  await expect.poll(() => reads).toBe(2)
  await expect(label).toHaveCount(0)
})

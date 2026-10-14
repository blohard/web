import { test, expect, author, stranger, deferred } from './host.mjs'

// Both panes contain the same accounts, ranked in opposite order by balance.
// A bookmark for the first holder therefore points far down the holdings pane.
test('keyring tab switches leave scrolling alone; Back restores the page', async ({ page, host }) => {
  const market = host.chain.contract
  const entries = Array.from({ length: 40 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}`, balance: i + 1 }))
  await page.route('**/api/status', async route => {
    const status = await (await host.answer(route.request())).json()
    status.keyrings = [{ chain: host.chain.id, market, start_block: 0 }]
    await route.fulfill({ json: status })
  })
  await page.route('**/keyring/*', route => route.fulfill({ json: {
    market, active: true, holding: [], holders: [], truncated: { holding: false, holders: false },
  } }))
  await page.route('**/keyring/*/trades?*', route => route.fulfill({ json: {
    market, active: true, items: [], next: null, truncated: false, checkpoint: host.at.checkpoint,
  } }))
  let balancesWait = null
  await page.route('**/keyring/*/balances?*', async route => {
    const wait = balancesWait
    if (wait) { wait.started.resolve(); await wait.release.promise }
    const side = new URL(route.request().url()).searchParams.get('view')
    return route.fulfill({ json: { market, view: side, active: true, own_balance: 1,
      total: entries.length, next: null, checkpoint: host.at.checkpoint,
      entries: entries.map(row => ({ ...row, balance: side === 'holding' ? row.balance : 41 - row.balance })),
    } })
  })
  await page.addInitScript(who => {
    const scrollTo = window.scrollTo.bind(window)
    window.scrollCalls = []
    window.scrollTo = (...args) => { window.scrollCalls.push(args); scrollTo(...args) }
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method }) {
        if (method === 'eth_accounts') return [who]
        if (method === 'eth_chainId') return '0x14a34'
        throw Object.assign(new Error(`unsupported wallet method ${method}`), { code: 4200 })
      },
    }
  }, author)
  await page.clock.install()
  await page.goto(`/u/84532/${author}/keyring`)
  const tabs = page.getByRole('navigation', { name: 'keyring management views' })
  const holding = tabs.getByRole('link', { name: '[ keys I hold ]', exact: true })
  const holders = tabs.getByRole('link', { name: '[ my key holders ]', exact: true })
  await expect(page.locator('[data-person]')).toHaveCount(entries.length)
  await page.evaluate(() => { window.scrollTo(0, 40); window.scrollCalls = [] })
  await page.clock.runFor(100)
  const top = (await tabs.boundingBox()).y
  for (const [tab, first] of [[holders, entries[0]], [holding, entries.at(-1)], [holders, entries[0]], [holding, entries.at(-1)]]) {
    expect(await page.evaluate(() => scrollY)).toBe(40)
    balancesWait = { started: deferred(), release: deferred() }
    try {
      await tab.click()
      await balancesWait.started.promise
      await page.clock.runFor(100)
      expect(await page.evaluate(() => ({ y: scrollY, calls: window.scrollCalls }))).toEqual({ y: 40, calls: [] })
      expect((await tabs.boundingBox()).y).toBeCloseTo(top, 0)
      balancesWait.release.resolve()
      await expect(page.locator('[data-person]').first()).toHaveAttribute('data-person', first.address)
      await page.clock.runFor(100)
      expect(await page.evaluate(() => ({ y: scrollY, calls: window.scrollCalls }))).toEqual({ y: 40, calls: [] })
      expect((await tabs.boundingBox()).y).toBeCloseTo(top, 0)
    } finally { balancesWait.release.resolve(); balancesWait = null }
  }
  // Ordinary navigation still restores the reading position on Back.
  const row = page.locator('[data-person]').nth(20)
  await row.scrollIntoViewIfNeeded()
  const y = await page.evaluate(() => scrollY)
  const rowTop = (await row.boundingBox()).y
  expect(y).toBeGreaterThan(1000)
  await row.locator('a.identity').click()
  await expect(page).not.toHaveURL(/\/keyring$/)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/u/84532/${author}/keyring$`))
  await expect(page.locator('[data-person]')).toHaveCount(entries.length)
  await page.clock.runFor(100)
  expect(await page.evaluate(() => scrollY)).toBeCloseTo(y, 0)
  expect((await row.boundingBox()).y).toBeCloseTo(rowTop, 0)
})


test('the profile keys spinner waits through the lazy module load', async ({ page, host }) => {
  const started = deferred(), release = deferred()
  await page.route('**/src/features/keys/KeyMarket.svelte*', async route => {
    started.resolve(); await release.promise; await route.continue()
  })
  await page.clock.install({ time: new Date('2026-10-04T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-04T12:00:00Z'))
  await page.goto(`/u/84532/${author}/keys`)
  await started.promise
  await page.clock.runFor(200)
  const spinner = page.getByRole('status').filter({ hasText: 'loading account keys…' })
  try {
    await expect(spinner).toHaveCount(0)
    await page.clock.runFor(101)
    await expect(spinner).toBeVisible()
    release.resolve()
    await expect(page.getByText('the account-key market is not configured on this chain.', { exact: true })).toBeVisible()
    await expect(spinner).toHaveCount(0)
  } finally { release.resolve() }
})

test('the home keyring tab shares one spinner wait with its stream', async ({ page, host }) => {
  const market = host.chain.contract
  host.post(1, 'Post by a held account', { who: stranger })
  await page.route('**/api/status', async route => {
    const status = await (await host.answer(route.request())).json()
    status.keyrings = [{ chain: host.chain.id, market, start_block: 0 }]
    await route.fulfill({ json: status })
  })
  const keyringStarted = deferred(), keyringRelease = deferred(), feedStarted = deferred(), feedRelease = deferred()
  await page.route('**/keyring/*', async route => {
    keyringStarted.resolve(); await keyringRelease.promise
    await route.fulfill({ json: { market, active: true, holding: [stranger], holders: [], truncated: { holding: false, holders: false } } })
  })
  await page.route('**/keyring/*/trades?*', route => route.fulfill({ json: {
    market, active: true, items: [], next: null, truncated: false, checkpoint: host.at.checkpoint,
  } }))
  await page.route('**/keyring/*/balances?*', route => route.fulfill({ json: {
    market, view: 'holding', active: true, own_balance: 1, total: 0, next: null, checkpoint: host.at.checkpoint, entries: [],
  } }))
  await page.route('**/feed', async route => { feedStarted.resolve(); await feedRelease.promise; await route.fallback() })
  await page.addInitScript(who => {
    localStorage.setItem('blohard.home.tab', JSON.stringify('keyring'))
    window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
      if (method === 'eth_accounts') return [who]
      if (method === 'eth_chainId') return '0x14a34'
      throw Object.assign(new Error(`unsupported wallet method ${method}`), { code: 4200 })
    } }
  }, author)
  await page.clock.install({ time: new Date('2026-10-04T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-04T12:00:00Z'))
  const keyringSpinner = page.getByRole('status').filter({ hasText: 'loading your keyring…' })
  const postsSpinner = page.getByRole('status').filter({ hasText: 'loading posts…' })
  try {
    await page.goto('/')
    await keyringStarted.promise
    await page.clock.runFor(200)
    await expect(keyringSpinner).toHaveCount(0)
    await page.clock.runFor(110)
    await expect(keyringSpinner).toBeVisible()
    keyringRelease.resolve()
    await feedStarted.promise
    await expect(postsSpinner).toBeVisible() // The stream continues the keyring's wait instead of starting another.
    feedRelease.resolve()
    await expect(page.getByText('Post by a held account', { exact: true })).toBeVisible()
    await expect(postsSpinner).toHaveCount(0)
  } finally { keyringRelease.resolve(); feedRelease.resolve() }
})

import { test, expect, author } from './host.mjs'

for (const theme of ['light', 'dark']) for (const width of [1100, 390]) {
  test(`Example Chain selection uses the default palette without a testnet watermark (${theme}, ${width}px)`, async ({ page, host }) => {
    await page.setViewportSize({ width, height: 850 })
    await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' })
    await page.addInitScript(theme => localStorage.setItem('blohard.theme', JSON.stringify(theme)), theme)
    await serveChains(page, host)
    await page.goto('/#/settings/8453')
    const picker = page.getByRole('combobox', { name: 'chain', exact: true })
    await expect(picker.locator('option')).toHaveText(['Base', 'Base Sepolia', 'Example Chain'])
    await expect(page.locator('.testnet-mark')).toHaveCount(0)
    const baseAccent = await page.locator('.shell').evaluate(el => getComputedStyle(el).getPropertyValue('--accent').trim())
    await picker.selectOption('424242')
    await expect(page).toHaveURL(/#\/settings\/424242$/)
    await expect(page.locator('.colhead')).toContainText('Example Chain')
    await expect(page.locator('.testnet-mark')).toHaveCount(0)
    expect(await page.locator('.shell').evaluate(el => getComputedStyle(el).getPropertyValue('--accent').trim())).toBe(baseAccent)
    await expect(page.getByRole('region', { name: 'account key settings' })).toHaveCount(0)
    await page.reload()
    await expect(picker).toHaveValue('424242')
    await expect(page.locator('.shell')).toHaveAttribute('data-chain', '424242')
    await picker.selectOption('84532')
    await expect(page.locator('.testnet-mark')).toHaveText('testnet')
    await expect(page.locator('.colhead')).toContainText('Base Sepolia')
    expect(await page.locator('.shell').evaluate(el => getComputedStyle(el).getPropertyValue('--accent').trim())).toBe(baseAccent)
    // A direct link's chain takes precedence over the saved selector.
    await page.goto('/#/settings/424242')
    await expect(page.locator('.shell')).toHaveAttribute('data-chain', '424242')
    await expect(page.locator('.testnet-mark')).toHaveCount(0)
  })
}

async function serveChains(page, host) {
  const chains = [
    { ...host.chain, id: 8453, name: 'Base' },
    { ...host.chain, id: 84532, name: 'Base Sepolia' },
    { ...host.chain, id: 424242, name: 'Example Chain', native_currency: { name: 'COIN', symbol: 'COIN', decimals: 18 } },
  ]
  await page.route('**/api/status', route => route.fulfill({ json: {
    verifier: 'chains', chains, host_policy: null, keyrings: [],
    store: { max_content_size: 4096, envelope: { version: 1 }, attachments: null },
    gateway: { names: true, link_previews: false },
  } }))
}

for (const scenario of [
  { name: 'a first alternate-chain post visit', path: '/p/424242/1', saved: null, expected: 424242 },
  { name: 'a first alternate-chain profile visit', path: `/u/424242/${author}`, saved: null, expected: 424242 },
  { name: 'an alternate-chain link with Base saved', path: '/p/424242/1', saved: 8453, expected: 8453 },
  { name: 'a Base link with the alternate chain saved', path: '/p/8453/1', saved: 424242, expected: 424242 },
  { name: 'a first Base post visit', path: '/p/8453/1', saved: null, expected: 8453 },
  { name: 'a first home visit', path: '/', saved: null, expected: null },
  { name: 'a link to an unserved chain', path: '/p/999/1', saved: null, expected: null },
]) {
  test(`${scenario.name} respects the remembered chain on Home and reload`, async ({ page, host }) => {
    host.chain.id = scenario.path.startsWith('/p/') ? Number(scenario.path.split('/')[2]) : 424242
    host.post(1, 'a post on the linked chain')
    await serveChains(page, host)
    if (scenario.saved !== null) await page.addInitScript(id => localStorage.setItem('blohard.chain', JSON.stringify(id)), scenario.saved)
    await page.goto(scenario.path)
    await expect(page.getByRole('link', { name: 'settings', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('blohard.chain')))).toBe(scenario.expected)
    await page.getByRole('link', { name: 'blohard', exact: true }).click()
    const label = scenario.expected === 424242 ? 'Example Chain' : 'Base'
    await expect(page.locator('.colhead')).toContainText(`· ${label}`)
    await expect(page.locator('.shell')).toHaveAttribute('data-chain', String(scenario.expected ?? 8453))
    await page.reload()
    await expect(page.locator('.shell')).toHaveAttribute('data-chain', String(scenario.expected ?? 8453))
  })
}

test('a chain without curation falls back to everyone without changing the saved curated tab', async ({ page, host }) => {
  await page.addInitScript(() => {
    localStorage.setItem('blohard.chain', '424242')
    localStorage.setItem('blohard.home.tab', JSON.stringify('curated'))
  })
  // Preserve Base's curated feed while the operator disables it on the alternate chain.
  await page.route('**/api/status', async route => {
    await route.fulfill({ json: {
      verifier: 'chains',
      chains: [{ ...host.chain, id: 8453, name: 'Base', curated: true },
        { ...host.chain, id: 424242, name: 'Example Chain', curated: false }],
      host_policy: null, keyrings: [],
      store: { max_content_size: 4096, envelope: { version: 1 }, attachments: null },
      gateway: { names: true, link_previews: false },
    } })
  })
  await page.goto('/')
  await expect(page.locator('.colhead')).toContainText('everyone · Example Chain')
  await expect(page.getByRole('button', { name: '[ curated ]', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '[ everyone ]', exact: true })).toHaveClass(/active/)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('blohard.home.tab')))).toBe('curated')
  await page.getByRole('link', { name: 'settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'chain', exact: true }).selectOption('8453')
  await page.getByRole('link', { name: 'blohard', exact: true }).click()
  await expect(page.locator('.colhead')).toContainText('curated · Base')
  await expect(page.getByRole('button', { name: '[ curated ]', exact: true })).toHaveClass(/active/)
})

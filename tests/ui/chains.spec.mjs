import { test, expect } from './host.mjs'

for (const theme of ['light', 'dark']) for (const width of [1100, 390]) {
  test(`Example Chain selection uses the default palette without a testnet watermark (${theme}, ${width}px)`, async ({ page, host }) => {
    await page.setViewportSize({ width, height: 850 })
    await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' })
    await page.addInitScript(theme => localStorage.setItem('blohard.theme', JSON.stringify(theme)), theme)
    const chains = [
      { ...host.chain, id: 8453, name: 'Base' },
      host.chain,
      { ...host.chain, id: 424242, name: 'Example Chain', native_currency: { name: 'COIN', symbol: 'COIN', decimals: 18 } },
    ]
    await page.route('**/api/status', route => route.fulfill({ json: {
      verifier: 'chains', chains, host_policy: null, keyrings: [],
      store: { max_content_size: 4096, envelope: { version: 1 }, attachments: null },
      gateway: { names: true, link_previews: false },
    } }))
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

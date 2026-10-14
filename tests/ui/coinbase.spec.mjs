import { test, expect, author } from './host.mjs'

// The real picker, adapter and wallet controller; replace only the SDK's
// external boundary, so no wallet, passkey or third-party service is needed.
const sdk = `
export function createCoinbaseWalletSDK(options) {
  const listeners = new Map()
  let accounts = localStorage.getItem('test.coinbase.session') ? ['${author}'] : []
  const emit = () => { for (const fn of listeners.get('accountsChanged') ?? []) fn(accounts) }
  window.coinbaseTest = { options, prompts: 0 }
  const provider = {
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    removeListener() {},
    async request({ method }) {
      if (method === 'eth_accounts') return accounts
      if (method === 'eth_chainId') return '0x14a34'
      if (method === 'eth_blockNumber') return '0x123'
      if (method === 'eth_requestAccounts') {
        window.coinbaseTest.prompts++
        if (localStorage.getItem('test.coinbase.reject')) throw Object.assign(new Error('user rejected'), { code: 4001 })
        accounts = ['${author}']; localStorage.setItem('test.coinbase.session', 'yes'); emit()
        return accounts
      }
      throw new Error('unexpected Coinbase method: ' + method)
    },
    async disconnect() { accounts = []; localStorage.removeItem('test.coinbase.session'); emit() }
  }
  return { getProvider: () => provider }
}
`

for (const mobile of [false, true]) test.describe(mobile ? 'mobile passkey' : 'desktop passkey', () => {
  if (mobile) test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('chooses passkeys, handles cancellation, restores and disconnects', async ({ page, host }) => {
    host.post(1, 'read without a wallet')
    let loads = 0
    await page.route('**/node_modules/.vite/deps/@coinbase_wallet-sdk.js*', async route => {
      loads++
      await route.fulfill({ contentType: 'application/javascript', body: sdk })
    })
    await page.goto('/')
    const connect = page.getByRole('button', { name: /connect a wallet/ })
    const choice = page.getByRole('button', { name: /Coinbase Wallet · passkey/ })
    const dialog = page.getByRole('dialog', { name: 'connect wallet' })
    await expect(connect).toBeVisible()
    expect(loads).toBe(0)
    const top = await connect.boundingBox()
    await connect.click()
    await expect(dialog).toBeVisible()
    expect(loads).toBe(0, 'the chooser itself does not contact a wallet service')
    const bounds = await dialog.boundingBox()
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width)
    await page.screenshot({ path: test.info().outputPath('wallet-choices.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(connect).toBeFocused()
    expect((await connect.boundingBox()).y).toBe(top.y)
    await connect.click()
    await page.getByRole('button', { name: 'close wallet choices' }).click()
    await expect(connect).toBeFocused()
    await page.evaluate(() => localStorage.setItem('test.coinbase.reject', 'yes'))
    await connect.click()
    await choice.click()
    await expect(page.locator('.connect-prompt .err')).toBeVisible()
    await expect(connect).toBeEnabled()
    await page.evaluate(() => localStorage.removeItem('test.coinbase.reject'))
    await connect.click()
    await choice.click()
    await expect(page.getByRole('textbox')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
    expect(loads).toBe(1)
    expect(await page.evaluate(() => window.coinbaseTest.options.preference)).toEqual({ options: 'smartWalletOnly', telemetry: false })
    await page.getByRole('textbox').fill('passkey draft stays in the browser')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByRole('textbox')).toHaveValue('passkey draft stays in the browser')
    await page.reload()
    await expect(page.getByRole('textbox')).toBeVisible()
    expect(await page.evaluate(() => window.coinbaseTest.prompts)).toBe(0)
    if (mobile) await page.getByRole('button', { name: /^menu/ }).click()
    await page.getByRole('button', { name: /disconnect/ }).filter({ visible: true }).click()
    await expect(connect).toBeVisible()
    const before = loads
    await page.reload()
    await expect(connect).toBeVisible()
    expect(loads).toBe(before, 'signed-out reload does not initialize the SDK')
  })
})

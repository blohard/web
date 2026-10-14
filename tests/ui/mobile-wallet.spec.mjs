import { test, expect, author } from './host.mjs'

// Exercise the real mobile UI and wallet controller with the wallet app
// connector this build names (playwright.config.mjs), served as a module the
// test supplies; no injected wallet is installed.
test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

const connector = `
export default async function (config) {
  const listeners = new Map()
  let accounts = localStorage.getItem('test.wallet.session') ? ['${author}'] : []
  const emit = (name, value) => { for (const fn of listeners.get(name) ?? []) fn(value) }
  window.walletTest = { config, prompts: 0, reject: false }
  const provider = {
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    removeListener() {},
    async request({ method }) {
      if (method === 'eth_accounts') return accounts
      if (method === 'eth_chainId') return '0x14a34'
      if (method === 'eth_blockNumber') return '0x123'
      throw new Error('unexpected wallet method: ' + method)
    }
  }
  return {
    provider,
    async connect() {
      window.walletTest.prompts++
      if (window.walletTest.reject) throw Object.assign(new Error('user rejected'), { code: 4001 })
      accounts = ['${author}']
      localStorage.setItem('test.wallet.session', 'yes')
      emit('chainChanged', '0x14a34'); emit('accountsChanged', accounts)
      return accounts
    },
    async disconnect() {
      accounts = []; localStorage.removeItem('test.wallet.session')
      emit('accountsChanged', accounts)
    }
  }
}
`

test('the wallet app connector loads on choice, restores after reload and stays out after disconnect', async ({ page, host, baseURL }) => {
  host.post(1, 'a post to read')
  let loads = 0
  await page.route('**/wallets/test-wallet.js', async route => {
    loads++
    await route.fulfill({ contentType: 'application/javascript', body: connector })
  })
  await page.goto('/')
  const connect = page.getByRole('button', { name: /connect a wallet/ })
  await expect(connect).toBeVisible()
  expect(loads).toBe(0)
  await connect.click()
  await page.getByRole('button', { name: 'Test Wallet · app' }).click()
  await expect(page.getByRole('textbox')).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/')
  expect(loads).toBe(1)
  expect(await page.evaluate(() => window.walletTest.config)).toEqual({ dapp: { name: 'blohard', url: baseURL }, rpcUrls: {}, chainId: 84532 })
  await page.getByRole('textbox').fill('keep this draft while I visit the wallet')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('textbox')).toHaveValue('keep this draft while I visit the wallet')
  await page.reload()
  await expect(page.getByRole('textbox')).toBeVisible()
  expect(await page.evaluate(() => window.walletTest.prompts)).toBe(0)
  await page.getByRole('button', { name: /^menu/ }).click()
  await page.getByRole('button', { name: /disconnect/ }).filter({ visible: true }).click()
  await expect(connect).toBeVisible()
  const before = loads
  await page.reload()
  await expect(connect).toBeVisible()
  expect(loads).toBe(before)
  await connect.click()
  await page.getByRole('button', { name: 'Test Wallet · app' }).click()
  await expect(page.getByRole('textbox')).toBeVisible()
})

test('a connector that fails to load leaves the chooser working and nothing half connected', async ({ page, host }) => {
  host.post(1, 'a post to read')
  await page.route('**/wallets/test-wallet.js', route => route.fulfill({ status: 404, body: 'gone' }))
  await page.goto('/')
  const connect = page.getByRole('button', { name: /connect a wallet/ })
  await connect.click()
  await page.getByRole('button', { name: 'Test Wallet · app' }).click()
  await expect(page.locator('.connection-error')).toBeVisible()
  await expect(connect).toBeEnabled()
  await expect(page.getByRole('textbox')).toHaveCount(0)
})

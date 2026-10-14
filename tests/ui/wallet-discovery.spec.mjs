import { test, expect, author, stranger } from './host.mjs'

async function wallets(page) {
  await page.addInitScript(({ author, stranger }) => {
    const calls = [], listeners = new Map()
    window.walletTest = { calls, fail: null, announcements: 0 }
    function provider(name, who) {
      return {
        on(event, fn) { listeners.set(`${name}:${event}`, [...(listeners.get(`${name}:${event}`) ?? []), fn]) },
        removeListener() {},
        async request({ method }) {
          calls.push(`${name}:${method}`)
          if (name === 'MetaMask' && window.walletTest.fail === method) throw Object.assign(new Error('unauthorized'), { code: 4100 })
          if (method === 'eth_accounts') return localStorage.getItem(`test.${name}`) ? [who] : []
          if (method === 'eth_requestAccounts') {
            localStorage.setItem(`test.${name}`, 'yes')
            for (const fn of listeners.get(`${name}:accountsChanged`) ?? []) fn([who])
            return [who]
          }
          if (method === 'eth_blockNumber') return '0x123'
          if (method === 'eth_chainId') return '0x14a34'
          if (method === 'wallet_revokePermissions') { localStorage.removeItem(`test.${name}`); return null }
          throw new Error(`unexpected ${method}`)
        },
      }
    }
    const other = provider('Other', stranger), mm = provider('MetaMask', author)
    window.ethereum = other
    const announce = () => {
      window.walletTest.announcements++
      for (const [n, name, rdns, p] of [[1, 'Other', 'com.other', other], [2, 'MetaMask', 'io.metamask', mm]]) {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
          info: { uuid: `00000000-0000-4000-8000-00000000000${n}`, name, rdns,
            icon: 'https://must-not-fetch.invalid/wallet.svg' }, provider: p,
        } }))
      }
    }
    window.addEventListener('eip6963:requestProvider', announce)
  }, { author, stranger })
}

test('selecting MetaMask bypasses another injected wallet and remembers the choice on reload', async ({ page, host }) => {
  host.post(1, 'read before connecting')
  await wallets(page)
  await page.goto('/')
  await page.getByRole('button', { name: /connect a wallet/ }).click()
  const dialog = page.getByRole('dialog', { name: 'connect wallet' })
  await expect(dialog.getByRole('button', { name: /Other · browser wallet/ })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^\[ browser wallet \]$/ })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('wallet-picker-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  const bounds = await dialog.boundingBox()
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: test.info().outputPath('wallet-picker-mobile.png') })
  await page.setViewportSize({ width: 1100, height: 800 })
  await dialog.getByRole('button', { name: /MetaMask · browser wallet/ }).click()
  await expect(page.getByRole('textbox')).toBeVisible()
  expect(await page.evaluate(() => window.walletTest.calls)).not.toContain('Other:eth_requestAccounts')
  await page.reload()
  await expect(page.getByRole('textbox')).toBeVisible()
  expect(await page.evaluate(() => window.walletTest.calls)).not.toContain('Other:eth_accounts')
  expect(await page.evaluate(() => window.walletTest.calls)).not.toContain('MetaMask:eth_requestAccounts')
  await page.getByRole('button', { name: /disconnect/ }).filter({ visible: true }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: /connect a wallet/ })).toBeEnabled()
  await expect(page.getByRole('textbox')).toHaveCount(0)
})

test('authorization errors identify the failed step and allow retry with another wallet', async ({ page, host }) => {
  host.post(1, 'read before connecting')
  await wallets(page)
  await page.goto('/')
  for (const [method, step] of [['eth_requestAccounts', 'account access'], ['eth_chainId', 'network check']]) {
    await page.evaluate(method => { window.walletTest.fail = method }, method)
    await page.getByRole('button', { name: /connect a wallet/ }).click()
    await page.getByRole('button', { name: /MetaMask · browser wallet/ }).click()
    await expect(page.locator('.connect-prompt .err')).toContainText(`${step} failed:`)
    await expect(page.locator('.connect-prompt .err')).toContainText('4100')
    await expect(page.locator('.connect-prompt .err')).not.toContainText('connect it first')
  }
  await page.getByRole('button', { name: /connect a wallet/ }).click()
  await page.getByRole('button', { name: /Other · browser wallet/ }).click()
  await expect(page.getByRole('textbox')).toBeVisible()
})

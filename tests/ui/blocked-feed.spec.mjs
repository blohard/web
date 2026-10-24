import { test, expect, author, stranger, card } from './host.mjs'

for (const width of [1100, 390]) test(`Everyone honors the indexed blocklist without browser mutes at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 850 })
  host.post(1, 'A visible post')
  host.post(2, 'A blocked author must not appear', { who: stranger })
  host.block(author, stranger)
  await page.addInitScript(who => {
    localStorage.setItem('blohard.home.tab', JSON.stringify('everyone'))
    localStorage.removeItem('blohard.muted')
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method }) {
        if (method === 'eth_accounts') return [who]
        if (method === 'eth_chainId') return '0x14a34'
        throw Object.assign(new Error(`unsupported wallet method ${method}`), { code: 4200 })
      },
    }
  }, author)
  await page.goto('/')
  await expect(card(page, 1).getByRole('button', { name: '[ delete ]', exact: true })).toBeVisible()
  await expect(card(page, 1)).toBeVisible()
  await expect(card(page, 2)).toHaveCount(0)
  await page.reload()
  await expect(card(page, 1)).toBeVisible()
  await expect(card(page, 2)).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('blohard.muted'))).toBeNull()
  host.block(author, stranger, false)
  await page.reload()
  await expect(card(page, 2)).toBeVisible()
})

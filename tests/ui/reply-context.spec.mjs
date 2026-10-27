import { test, expect, stranger, card } from './host.mjs'

for (const width of [1100, 390]) for (const named of [true, false]) test(`reply context shows the parent's ${named ? 'name' : 'address'} at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 800 })
  const name = 'a-very-long-parent-account-name-that-needs-to-wrap.base.eth'
  await page.route(`**/api/names/${stranger}`, route => route.fulfill({ json: { name: named ? name : null, source: named ? 'ens' : null, avatar: null } }))
  host.post(1, 'Earlier parent', { who: stranger })
  host.post(2, 'Immediate context', { who: stranger, parent: 1 })
  host.post(3, 'Followed reply', { parent: 2 })
  await page.goto('/')
  const label = page.locator('.conversation-context[href="/p/84532/1"]')
  await expect(label.locator('.name')).toHaveAttribute('title', stranger)
  await expect(label).toHaveText(`in reply to ${named ? name : '0x3333…3333'} #1`)
  expect(await label.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await label.click()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 1)).toContainText('Earlier parent')
})

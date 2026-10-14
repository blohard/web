import { test, expect, card, stranger, deferred } from './host.mjs'

test('the widget reloads on tab return but rechecks visible folds only on explicit refresh', async ({ page, host }) => {
  host.chain.blocklist = { registry: host.chain.contract, list: 'blocked' }
  host.post(1, 'Discussion topic')
  host.post(2, 'An initially accepted reply', { who: stranger, parent: 1 })
  let blocked = false
  await page.route('**/state', async route => {
    const answer = await (await host.answer(route.request())).json()
    answer.memberships = answer.memberships.map(() => blocked)
    await route.fulfill({ json: answer })
  })
  await page.goto('/embed.html?chain=84532&post=1')
  await expect(card(page, 2)).toContainText('An initially accepted reply')

  blocked = true
  host.post(3, 'A later reply', { parent: 1 })
  // A real visibility event reaches the widget's listener. The new row proves
  // the returned page was applied; the existing card must keep its verdict.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(card(page, 3)).toBeVisible()
  await expect(card(page, 2)).toContainText('An initially accepted reply')
  await expect(card(page, 2)).not.toHaveClass(/\bcollapsed\b/)

  await page.getByTitle('reload the discussion').click()
  await expect(card(page, 2)).toHaveClass(/\bcollapsed\b/)
  await expect(card(page, 2)).toContainText('hidden because the author no longer accepts replies')
  await expect(card(page, 2)).not.toContainText('An initially accepted reply')
})

test('widget replies settle together even when an older reply check fails', async ({ page, host }) => {
  host.chain.blocklist = { registry: host.chain.contract, list: 'blocked' }
  host.post(1, 'Original post')
  host.post(2, 'Discussion reply', { parent: 1 })
  host.post(5, 'Older answer', { who: stranger, parent: 2 })
  host.post(6, 'Newer protected answer', { parent: 2 })
  const started = deferred(), release = deferred()
  await page.route('**/state', async route => {
    if (!route.request().postDataJSON().memberships?.length) return route.fallback()
    started.resolve()
    await release.promise
    await route.fulfill({ status: 503, json: { error: 'host busy' } })
  })
  try {
    await page.goto('/embed.html?chain=84532&post=2')
    await started.promise
    const readyCard = page.locator('article.msg').filter({ has: page.locator('a[aria-label="open post #6"]') })
    await expect(readyCard).toContainText('Newer protected answer')
    await expect(readyCard).not.toBeVisible()
  } finally { release.resolve() }
  // A failed first verdict settles the card rather than trapping the whole list.
  await expect(card(page, 5)).toContainText('Older answer')
  await expect(card(page, 5)).toBeVisible()
  await expect(card(page, 6)).toBeVisible()
  await expect(page.locator('article.msg a[aria-label^="open post #"]')).toHaveText(['#5', '#6'])
})

test('the widget asks nothing of a wallet injected into the page', async ({ page, host }) => {
  host.post(1, 'Discussion topic')
  host.post(2, 'A reply to read', { who: stranger, parent: 1 })
  await page.addInitScript(() => {
    const asked = []
    window.walletTest = { asked }
    window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
      asked.push(method)
      if (method === 'eth_accounts') return []
      if (method === 'eth_chainId') return '0x14a34'
      throw new Error(`unexpected wallet method ${method}`)
    } }
    window.dispatchEvent(new Event('ethereum#initialized'))
  })
  await page.goto('/embed.html?chain=84532&post=1')
  await expect(card(page, 2)).toContainText('A reply to read')
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  await expect(card(page, 2)).toContainText('A reply to read')
  expect(await page.evaluate(() => window.walletTest.asked)).toEqual([])
})

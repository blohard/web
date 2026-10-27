import { test, expect, author, stranger, card, deferred } from './host.mjs'

for (const width of [1100, 390]) test(`notification reply count opens the replies of a long post at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 800 })
  host.post(1, 'My original post')
  host.post(2, Array.from({ length: 35 }, (_, i) => `Paragraph ${i + 1}: a long notification post with plenty to read.`).join('\n\n'), { who: stranger, parent: 1 })
  host.post(3, 'The reply I clicked to read', { who: stranger, parent: 2 })
  await page.addInitScript(who => {
    window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
      if (method === 'eth_accounts') return [who]
      if (method === 'eth_chainId') return '0x14a34'
      if (method === 'eth_blockNumber') return '0x100'
      throw new Error(`unexpected wallet call ${method}`)
    } }
  }, author)
  await page.goto('/#/notifications')
  await card(page, 2).getByRole('button', { name: '↳ reply', exact: true }).click()
  await page.locator('textarea').fill('An unfinished reply')
  const link = card(page, 2).getByRole('link', { name: '1 reply', exact: true })
  await link.scrollIntoViewIfNeeded()
  const previousY = await page.evaluate(() => scrollY)
  await link.click()
  await expect(card(page, 3)).toBeVisible()
  await expect(card(page, 3)).toBeInViewport({ ratio: 1 })
  await expect(page.locator('textarea')).toHaveCount(0)
  await expect(page).toHaveURL(/\/p\/84532\/2\?replies$/)
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(page).toHaveURL(/#\/notifications$/)
  await expect(link).toBeInViewport()
  await expect(page.locator('textarea')).toHaveValue('An unfinished reply')
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(previousY, 0)
})


test('a direct replies link follows a late parent body and restores a manually chosen position on Forward', async ({ page, host }) => {
  const root = host.post(1, 'Late parent body\n\n' + 'A paragraph that makes the parent taller.\n\n'.repeat(40))
  host.post(2, 'The first reply', { parent: 1 })
  const started = deferred(), release = deferred()
  await page.route(`**/api/content/${root.content_hash}*`, async route => {
    started.resolve()
    await release.promise
    await route.fallback()
  })
  try {
    await page.goto('/')
    await started.promise
    // Navigate through the app so browser Forward can restore this visit later.
    await page.evaluate(() => { const a = document.createElement('a'); a.href = '/p/84532/1?replies'; document.body.append(a); a.click(); a.remove() })
    await expect(card(page, 2)).toBeInViewport({ ratio: 1 })
    release.resolve()
    await expect(card(page, 1)).toContainText('Late parent body')
    await expect(card(page, 2)).toBeInViewport({ ratio: 1 })
    // User input stops the initial follow. Forward must honor the new bookmark.
    await page.mouse.wheel(0, -350)
    await expect.poll(() => card(page, 2).evaluate(el => el.getBoundingClientRect().bottom)).toBeGreaterThan(800)
    const previousY = await page.evaluate(() => scrollY)
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await page.goForward()
    await expect(page).toHaveURL(/\?replies$/)
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(previousY, 0)
  } finally { release.resolve() }
})

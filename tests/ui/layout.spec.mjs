import { test, expect, author, stranger, card, deferred } from './host.mjs'
import { frames, watchLayout, expectStable } from './layout-watch.mjs'

for (const width of [1100, 390]) test.describe(`layout at ${width}px`, () => {
  test.use({ viewport: { width, height: 900 } })

  test('notification reply context wraps long URLs inside its column', async ({ page, host }) => {
    const url = `https://basescan.org/tx/0x${'a'.repeat(64)}`
    host.post(1, `Another token burn: ${url}`)
    host.post(2, 'The receipt is the whole point.', { who: stranger, parent: 1 })
    await page.addInitScript(who => {
      window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
        if (method === 'eth_accounts') return [who]
        if (method === 'eth_chainId') return '0x14a34'
        throw Object.assign(new Error(`unsupported wallet method ${method}`), { code: 4200 })
      } }
    }, author)
    await page.goto('/#/notifications')
    const context = card(page, 2).locator('a.context')
    await expect(context).toContainText(url)
    await expect(context).toBeVisible()
    const geometry = await context.evaluate(node => {
      const range = document.createRange()
      range.selectNodeContents(node.querySelector('.line'))
      const bounds = node.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right,
        lines: [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, top: r.top })) }
    })
    expect(new Set(geometry.lines.map(r => r.top)).size).toBeGreaterThan(1)
    for (const line of geometry.lines) {
      expect(line.left).toBeGreaterThanOrEqual(geometry.left - 1)
      expect(line.right).toBeLessThanOrEqual(geometry.right + 1)
    }
  })

  test('repeated Home keeps default cards mounted and steady', async ({ page, host }) => {
    host.post(1, 'Conversation with a reply')
    host.post(2, 'A reply with several lines.\n'.repeat(4), { parent: 1 })
    await page.goto('/')
    await expect(card(page, 2)).toContainText('A reply with several lines.')
    await frames(page)
    const original = await card(page, 2).elementHandle()
    const finish = await watchLayout(page, [1, 2])
    for (let i = 0; i < 3; i++) {
      // The brand and the sidebar Home link share the same handler; the brand
      // remains available on phones without expanding the navigation menu.
      await page.locator('a.brand').click()
      await frames(page)
      expect(await original.evaluate(node => node.isConnected)).toBe(true)
    }
    expectStable(await finish(), [1, 2])
  })

  test('cold bodies settle before the first visible frame', async ({ page, host }) => {
    host.post(1, 'Conversation')
    const reply = host.post(2, 'Slow reply body.\n'.repeat(5), { parent: 1 })
    const started = deferred(), release = deferred()
    await page.route(`**/api/content/${reply.content_hash}*`, async route => {
      started.resolve(); await release.promise; await route.fallback()
    })
    try {
      await page.goto('/')
      await started.promise
      const finish = await watchLayout(page, [1, 2])
      await frames(page)
      await expect(card(page, 1)).not.toBeVisible()
      release.resolve()
      await expect(card(page, 2)).toContainText('Slow reply body.')
      await expect(card(page, 2)).toBeVisible()
      expectStable(await finish(), [1, 2])
    } finally { release.resolve() }
  })

  for (const navigation of ['tabs', 'Back']) test(`cached ${navigation} return waits for reply checks`, async ({ page, host }) => {
    host.chain.blocklist = { registry: host.chain.contract, list: 'blocked' }
    host.post(1, 'Context from another author', { who: stranger })
    host.post(2, 'Followed reply.\n'.repeat(4), { parent: 1 })
    await page.goto('/')
    await expect(card(page, 2)).toContainText('Followed reply.')
    await expect(card(page, 2)).toBeVisible()
    if (navigation === 'tabs') {
      await page.getByRole('button', { name: '[ everyone ]', exact: true }).click()
      await expect(card(page, 1)).toBeVisible()
    } else {
      await card(page, 2).getByRole('link', { name: 'open post #2', exact: true }).click()
      await expect(page).toHaveURL(/\/p\/84532\/2$/)
      await expect(card(page, 2)).toContainText('Followed reply.')
    }
    const started = deferred(), release = deferred()
    await page.route('**/state', async route => {
      if (route.request().postDataJSON().memberships?.length) {
        started.resolve(); await release.promise
      }
      await route.fallback()
    })
    try {
      if (navigation === 'tabs') await page.getByRole('button', { name: '[ following ]', exact: true }).click()
      else await page.goBack()
      await started.promise
      const finish = await watchLayout(page, [1, 2])
      await frames(page)
      await expect(card(page, 1)).not.toBeVisible()
      release.resolve()
      await expect(card(page, 2)).toContainText('Followed reply.')
      await expect(card(page, 2)).toBeVisible()
      expectStable(await finish(), [1, 2])
    } finally { release.resolve() }
  })

  test('reply expansion reveals slow older and ready newer siblings together', async ({ page, host }) => {
    host.chain.blocklist = { registry: host.chain.contract, list: 'blocked' }
    host.post(1, 'Original')
    host.post(2, 'Parent reply', { parent: 1 })
    host.post(5, 'Older slow answer.\n'.repeat(4), { who: stranger, parent: 2 })
    host.post(6, 'Newer answer.\n'.repeat(3), { parent: 2 })
    await page.goto('/p/84532/2')
    await expect(card(page, 5)).toBeVisible()
    await card(page, 2).getByRole('button', { name: 'hide replies', exact: true }).click()
    await expect(card(page, 6)).toHaveCount(0)
    const started = deferred(), release = deferred()
    await page.route('**/state', async route => {
      if (route.request().postDataJSON().memberships?.length) { started.resolve(); await release.promise }
      await route.fallback()
    })
    try {
      await card(page, 2).getByRole('button', { name: '2 replies', exact: true }).click()
      await started.promise
      const finish = await watchLayout(page, [2, 5, 6], { anchor: 2 })
      await frames(page)
      await expect(card(page, 6)).not.toBeVisible()
      release.resolve()
      await expect(card(page, 5)).toBeVisible()
      await expect(card(page, 6)).toBeVisible()
      expectStable(await finish(), [2, 5, 6])
    } finally { release.resolve() }
  })

  test('Refresh retains visible reply geometry while rechecking gates', async ({ page, host }) => {
    host.chain.blocklist = { registry: host.chain.contract, list: 'blocked' }
    host.post(1, 'Original context', { who: stranger })
    host.post(2, 'Reply already on screen.\n'.repeat(4), { parent: 1 })
    await page.goto('/')
    await expect(card(page, 2)).toContainText('Reply already on screen.')
    await expect(card(page, 2)).toBeVisible()
    host.post(3, 'New post for the refresh cue')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const refresh = page.getByRole('button', { name: /refresh.*new/ })
    await expect(refresh).toBeVisible()
    const started = deferred(), release = deferred()
    await page.route('**/state', async route => {
      if (route.request().postDataJSON().memberships?.length) { started.resolve(); await release.promise }
      await route.fallback()
    })
    try {
      // A new post intentionally moves this pair down. Their geometry relative
      // to one another must not change while the reply's check is pending.
      const finish = await watchLayout(page, [1, 2], { anchor: 1 })
      await refresh.click()
      await started.promise
      await frames(page)
      await expect(card(page, 2)).toContainText('Reply already on screen.')
      release.resolve()
      await expect(card(page, 3)).toBeVisible()
      expectStable(await finish(), [1, 2])
    } finally { release.resolve() }
  })
})

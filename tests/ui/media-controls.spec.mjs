import { test, expect, card } from './host.mjs'

for (const touch of [false, true]) test.describe(touch ? 'touch media controls' : 'mouse media controls', () => {
  test.use({ hasTouch: touch, viewport: { width: touch ? 390 : 1100, height: 900 } })
  test('pictures and preview thumbnails hide from an overlay without opening their destination', async ({ page, host }) => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 320; canvas.height = 160
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#527d65'; ctx.fillRect(0, 0, 320, 160)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    const bytes = Buffer.from(png, 'base64')
    const hash = host.record(Buffer.concat([Buffer.from('version/1 image/png\n'), bytes]))
    host.post(1, `A picture\n![landscape](record:${hash})`)
    host.post(2, 'https://blohard.social/about')
    await page.route('http://127.0.0.1:8790/about', route => route.fulfill({ contentType: 'text/html', body: '<meta property="og:title" content="A link card"><meta property="og:image" content="https://blohard.social/test-picture.png">' }))
    await page.route('**/test-picture.png', route => route.fulfill({ contentType: 'image/png', body: bytes }))
    await page.goto('/')
    const picture = card(page, 1).locator('.rec-image-box')
    const preview = card(page, 2).locator('.link-preview')
    for (const [container, hideName, showName] of [[picture, 'hide picture', 'show picture'], [preview, 'hide image', 'show image']]) {
      const image = container.locator('img')
      await expect(image).toBeVisible()
      const hide = container.getByRole('button', { name: hideName, exact: true })
      await page.mouse.move(0, 0)
      await expect(hide).toHaveCSS('opacity', touch ? '1' : '0')
      if (!touch) {
        await container.hover()
        await expect(hide).toHaveCSS('opacity', '1')
        await page.mouse.move(0, 0)
        await hide.focus()
        await expect(hide).toHaveCSS('opacity', '1')
      }
      const bounds = await container.boundingBox(), button = await hide.boundingBox()
      expect(button.x + button.width).toBeLessThanOrEqual(bounds.x + bounds.width)
      expect(button.y - bounds.y).toBeLessThan(12)
      await page.screenshot({ path: test.info().outputPath(`${hideName}.png`) })
      await hide.click()
      await expect(image).not.toBeVisible()
      const show = container.getByRole('button', { name: showName, exact: true })
      await expect(show).toBeVisible()
      await expect(show).toBeFocused()
      await show.press('Enter')
      await expect(image).toBeVisible()
      await expect(container.getByRole('button', { name: hideName, exact: true })).toBeFocused()
      await expect(page.locator('.lightbox')).toHaveCount(0)
      await expect(page).toHaveURL('http://127.0.0.1:8790/')
    }
  })
})

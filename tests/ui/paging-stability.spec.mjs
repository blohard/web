import { test, expect, author, stranger, card } from './host.mjs'

// The first page shows 4 → 65. Paging discovers 5 → 16, also beneath 4.
// Interleaved conversations put that discovery across the host page boundary.
const roots = [1, 2, 3, 10, 11, 12, 13, 15, 18, 20, 23, 24, 25, 26, 27, 29, 30, 31,
  34, 35, 41, 42, 46, 47, 48, 49, 50, 51, 52, 53, 55, 57, 58, 60, 61, 62, 64, 66, 67, 69, 70, 72, 73, 74, 75]
const replies = [[4, 3], [5, 4], [7, 1], [14, 13], [16, 5], [17, 7], [19, 14], [28, 26],
  [32, 31], [36, 29], [37, 25], [40, 22], [43, 33], [44, 39], [45, 29], [54, 7], [59, 38], [63, 25], [65, 4], [71, 13]]

const cards = page => page.locator('[data-feed-row] article.msg')
const settle = page => page.evaluate(async () => {
  await document.fonts.ready
  await Promise.all([...document.querySelectorAll('[data-feed-row] img')].map(img => img.decode().catch(() => {})))
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
})
const geometry = page => cards(page).evaluateAll(elements => elements.map(el => {
  const box = el.getBoundingClientRect()
  return { id: el.querySelector('a[aria-label^="open post #"]').getAttribute('aria-label'),
    top: box.top + scrollY, height: box.height }
}))

for (const width of [1100, 390]) test(`paging appends older conversations without changing displayed cards at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 900 })
  const posts = [...roots.map(id => [id, 0, author]), ...[22, 33, 38, 39].map(id => [id, 0, stranger]),
    ...replies.map(([id, parent]) => [id, parent, author])].sort(([a], [b]) => a - b)
  for (const [id, parent, who] of posts) host.post(id, `Post ${id}.\nA little context for this conversation.`, { parent, who })
  await page.goto('/')
  await expect(card(page, 65)).toBeVisible()
  await expect(card(page, 54)).toBeVisible()
  await expect(card(page, 16)).toHaveCount(0)
  await settle(page)
  const before = await geometry(page)
  const nodes = await cards(page).elementHandles()
  const more = page.getByRole('button', { name: '[ show more posts ]', exact: true })
  await more.click()
  await expect(card(page, 53)).toBeVisible()
  await expect(more).toHaveAttribute('aria-busy', 'false')
  await settle(page)
  const after = await geometry(page)
  expect(after.slice(0, before.length)).toEqual(before)
  for (const node of nodes) expect(await node.evaluate(el => el.isConnected)).toBe(true)
  expect(after.length).toBeGreaterThan(before.length)
  expect(new Set(after.map(row => row.id)).size).toBe(after.length)

  await card(page, 53).getByRole('link', { name: 'open post #53', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/53$/)
  await page.goBack()
  await expect(card(page, 53)).toBeVisible()
  await settle(page)
  expect(await geometry(page)).toEqual(after)
})

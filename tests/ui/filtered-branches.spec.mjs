import { test, expect, author, stranger, card } from './host.mjs'

for (const width of [1100, 390]) for (const tab of ['curated', 'following']) test(`${tab} keeps a disconnected ancestor at its own position at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 850 })
  host.policy([author])
  host.post(1, 'Old original post')
  host.post(2, 'An unselected reply', { who: stranger, parent: 1 })
  host.post(3, 'Immediate context for the active branch', { who: stranger, parent: 2 })
  host.post(4, 'A newer independent post')
  host.post(5, 'A selected nested reply', { parent: 3 })
  host.post(6, 'The newest selected answer', { parent: 5 })
  await page.addInitScript(tab => localStorage.setItem('blohard.home.tab', JSON.stringify(tab)), tab)
  await page.goto('/')
  for (const id of [1, 3, 4, 5, 6]) await expect(card(page, id)).toHaveCount(1)
  await expect(card(page, 2)).toHaveCount(0)
  const order = async () => {
    const boxes = await Promise.all([3, 5, 6, 4, 1].map(id => card(page, id).boundingBox()))
    expect(boxes.every(Boolean)).toBe(true)
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y)
  }
  await order()
  await page.reload()
  await expect(card(page, 6)).toBeVisible()
  await order()
})

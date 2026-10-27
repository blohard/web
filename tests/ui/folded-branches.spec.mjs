import { test, expect, author, stranger, card } from './host.mjs'

for (const width of [1100, 390]) for (const tab of ['everyone', 'following', 'curated']) test(`${tab} splits at a folded reply at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 850 })
  host.policy([author, stranger])
  for (let id = 1; id <= 25; id++) host.post(id, `Older post ${id}`)
  host.post(100, 'Original post')
  host.post(110, 'Connecting reply hidden by the preview cutoff', { who: stranger, parent: 100 })
  host.post(120, 'My reply in the active branch', { parent: 110 })
  host.post(130, 'An independent newer post')
  host.post(140, 'Newest answer in the active branch', { who: stranger, parent: 120 })
  await page.addInitScript(({ tab, who }) => {
    localStorage.setItem('blohard.home.tab', JSON.stringify(tab))
    window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
      if (method === 'eth_accounts') return [who]
      if (method === 'eth_chainId') return '0x14a34'
      if (method === 'eth_blockNumber') return '0x100'
      throw new Error(`unexpected wallet call ${method}`)
    } }
  }, { tab, who: author })
  const order = async () => {
    for (const id of [120, 140, 130, 100]) await expect(card(page, id)).toHaveCount(1)
    await expect(card(page, 110)).toHaveCount(0)
    const boxes = await Promise.all([120, 140, 130, 100].map(id => card(page, id).boundingBox()))
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y)
  }
  await page.goto('/')
  await order()
  await page.getByRole('button', { name: /show more posts/ }).click()
  await expect(card(page, 1)).toHaveCount(1)
  await order()
  // The split branch retains ordinary controls and supplies context-thread inheritance.
  await card(page, 120).getByRole('button', { name: 'hide replies', exact: true }).click()
  await expect(card(page, 140)).toHaveCount(0)
  await page.locator('.conversation-context[href="/p/84532/110"]').click()
  await expect(page).toHaveURL(/\/p\/84532\/110$/)
  await expect(card(page, 120)).toHaveCount(1)
  await expect(card(page, 140)).toHaveCount(0)
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(card(page, 140)).toHaveCount(0)
  await card(page, 120).getByRole('button', { name: '1 reply', exact: true }).click()
  await order()
  await page.reload()
  await order()
})

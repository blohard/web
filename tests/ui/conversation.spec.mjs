// Static links, counts and layout classes are covered by the Node conversation-row tests.
// Keep real clicks, delayed reads, computed borders and height stability here.
import { test, expect, card, deferred, stranger } from './host.mjs'

async function mount(page, host, props) {
  await page.addInitScript(props => { window.conversation = props }, { chain: host.chain, at: host.at, ...props })
  await page.goto('/tests/ui/fixtures/conversation.html')
}
const preview = (post, drawn = 0, joins = false, gap = false) => ({ post, drawn, joins, gap })
const ids = page => page.locator('article.msg a[aria-label^="open post #"]').evaluateAll(links => links.map(a => Number(a.textContent.slice(1))))
const border = async (page, id) => (await card(page, id).evaluate(node => getComputedStyle(node).borderTopWidth)) !== '0px'

for (const failed of [false, true]) test(`opening more replies preserves the preview while the branch ${failed ? 'fails' : 'waits'}`, async ({ page, host }) => {
  const root = host.post(1, 'Parent')
  host.post(2, 'Earlier reply', { parent: 1 })
  host.post(3, 'Middle reply', { parent: 1 })
  const reply = host.post(4, 'Preview reply', { parent: 1 })
  const release = deferred(), started = deferred()
  await page.route('**/replies', async route => {
    started.resolve()
    if (failed) await route.fulfill({ status: 503, json: { error: 'replies_unavailable' } })
    else { await release.promise; await route.fallback() }
  })
  try {
    await mount(page, host, { root: { id: 1, post: root, drawn: 1, joins: true }, cards: [preview(reply)], counts: [[1, 3], [4, 0]] })
    await expect(card(page, 4)).toContainText('Preview reply')
    await page.getByRole('button', { name: '2 more replies', exact: true }).click()
    await started.promise
    if (failed) await expect(page.getByRole('status').filter({ hasText: 'replies unavailable' })).toBeVisible()
    await expect.poll(() => ids(page)).toEqual([1, 4])
    await card(page, 1).getByRole('button', { name: 'hide replies', exact: true }).click()
    await expect(card(page, 4)).toHaveCount(0)
  } finally { release.resolve() }
})

test('reopening hidden replies never restores the nested automatic preview', async ({ page, host }) => {
  const root = host.post(1, 'Parent')
  const reply = host.post(2, 'Direct reply', { parent: 1 })
  const nested = host.post(3, 'Nested automatic preview', { parent: 2 })
  await page.clock.install()
  await mount(page, host, { root: { id: 1, post: root, drawn: 1, joins: true },
    cards: [preview(reply, 1, true), preview(nested)], counts: [[1, 1], [2, 1], [3, 0]] })
  await expect(card(page, 3)).toBeVisible()
  const parent = card(page, 1)
  // The first open reads a page; reopening the cached branch checks changes.
  for (const endpoint of ['replies', 'changes']) {
    await parent.getByRole('button', { name: 'hide replies', exact: true }).click()
    await expect.poll(() => ids(page)).toEqual([1])
    const height = (await parent.boundingBox()).height
    const release = deferred(), started = deferred()
    const pattern = `**/${endpoint}`
    await page.route(pattern, async route => { started.resolve(); await release.promise; await route.fallback() })
    try {
      await parent.getByRole('button', { name: '1 reply', exact: true }).click()
      await started.promise
      await page.clock.runFor(350)
      await expect(parent.getByRole('button', { name: 'hide replies', exact: true })).toHaveAttribute('aria-busy', 'true')
      await expect.poll(() => ids(page)).toEqual([1])
      expect((await parent.boundingBox()).height).toBe(height)
    } finally { release.resolve() }
    await expect(card(page, 2)).toBeVisible()
    await expect(card(page, 3)).toHaveCount(0)
    await page.unroute(pattern)
  }
  await card(page, 2).getByRole('button', { name: '1 reply', exact: true }).click()
  await expect(card(page, 3)).toBeVisible()
})

test('an omitted parent is a context link while post cards keep their reply controls', async ({ page, host }) => {
  host.post(1, 'Omitted parent')
  const reply = host.post(2, 'Followed reply', { parent: 1 })
  host.post(3, 'Nested reply', { parent: 2 })
  await mount(page, host, { root: { id: 1, omitted: true, drawn: 1, joins: false },
    cards: [preview(reply)], counts: [[1, 1], [2, 1]] })
  const context = page.getByRole('link', { name: /^in reply to (?:.* )?#1$/ })
  await expect(context).toHaveCount(1)
  await expect(context).toHaveAttribute('href', `/p/${host.chain.id}/1`)
  await expect(page.locator('.conversation-context button')).toHaveCount(0)
  await expect(card(page, 1)).toHaveCount(0)
  expect(await border(page, 2)).toBe(false)
  await card(page, 2).getByRole('button', { name: '1 reply', exact: true }).click()
  await expect(card(page, 3)).toBeVisible()
  await card(page, 2).getByRole('button', { name: 'hide replies', exact: true }).click()
  await expect(card(page, 3)).toHaveCount(0)
  await expect(context).toBeVisible()
  await expect(card(page, 2)).toBeVisible()
})

test('connectors join direct replies; siblings and an open editor keep their separator', async ({ page, host }) => {
  const root = host.post(1, 'Parent')
  const reply = host.post(2, 'Direct reply', { parent: 1 })
  const sibling = host.post(3, 'Sibling reply', { parent: 1 })
  const child = host.post(4, 'Nested reply', { parent: 2 })
  await mount(page, host, { root: { id: 1, post: root, drawn: 2, joins: true }, editor: 2,
    cards: [preview(reply, 1, true), preview(child), preview(sibling)], counts: [[1, 2], [2, 1], [3, 0], [4, 0]] })
  await expect(card(page, 3)).toContainText('Sibling reply')
  for (const [id, drawn] of [[1, true], [2, false], [4, false], [3, true]]) expect(await border(page, id)).toBe(drawn)
  const height = (await card(page, 2).boundingBox()).height
  await page.getByRole('button', { name: '[ open editor ]', exact: true }).click()
  await expect.poll(() => border(page, 4)).toBe(true)
  expect((await card(page, 2).boundingBox()).height).toBe(height)
  await page.getByRole('button', { name: '[ open root editor ]', exact: true }).click()
  await expect.poll(() => border(page, 2)).toBe(true)
  await expect.poll(() => border(page, 4)).toBe(false)
  await page.getByRole('button', { name: '[ close editor ]', exact: true }).click()
  await expect.poll(() => border(page, 4)).toBe(false)
  await expect.poll(() => border(page, 2)).toBe(false)
})

for (const width of [1100, 390]) test(`checking reply access keeps the composer height at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 800 })
  host.chain.closed_gate = stranger
  await page.route('**/api/status', async route => {
    const status = await (await host.answer(route.request())).json()
    status.store.attachments = { max_bytes: 2097152, max_per_message: 4, media_types: ['image/png'] }
    await route.fulfill({ json: status })
  })
  const root = host.post(1, 'Reply to this post')
  const release = deferred()
  await page.route('**/message/1?*', async route => { await release.promise; await route.fallback() })
  try {
    await mount(page, host, { root: { id: 1, post: root, drawn: 0, joins: false }, account: stranger })
    await expect(card(page, 1)).toContainText('Reply to this post')
    await page.getByRole('button', { name: '[ open root editor ]', exact: true }).click()
    const composer = page.locator('.composer')
    const checking = composer.getByText('checking reply access…', { exact: true })
    await expect(checking).toBeVisible()
    await expect(composer.getByRole('textbox')).toBeEnabled()
    const height = (await composer.boundingBox()).height
    release.resolve()
    await expect(checking).toBeHidden()
    await expect(composer.locator('.compose-status > div').first()).toHaveAttribute('aria-hidden', 'false')
    expect((await composer.boundingBox()).height).toBe(height)
    const controls = composer.locator('.compose-actions > button, .post-controls > button, .post-reply-rule > button')
    const boxes = await controls.evaluateAll(nodes => nodes.map(node => {
      const { x, y, right, bottom } = node.getBoundingClientRect()
      return { x, y, right, bottom }
    }))
    expect(boxes).toHaveLength(5)
    for (let i = 0; i < boxes.length; i++) for (const b of boxes.slice(i + 1)) {
      const a = boxes[i]
      expect(Math.min(a.right, b.right) - Math.max(a.x, b.x) <= 0 || Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) <= 0).toBe(true)
    }
    await composer.getByRole('button', { name: /reply rule/ }).click()
    await expect(composer.getByText('the author you replied to can always respond while this post is live', { exact: true })).toBeVisible()
  } finally { release.resolve() }
})

test('expanding a deep preview reads only the requested replies and keeps its existing cards', async ({ page, host }) => {
  const posts = Array.from({ length: 41 }, (_, i) => host.post(i + 1, `Post ${i + 1}`, { parent: i }))
  const reads = []
  await page.route('**/replies', async route => { reads.push(route.request().postDataJSON().parent); await route.fallback() })
  await mount(page, host, { root: { id: 1, post: posts[0], drawn: 0, joins: false },
    cards: [37, 39, 41].map(id => preview(posts[id - 1], 0, false, true)), counts: [[1, 1]] })
  await expect(card(page, 41)).toBeVisible()
  await card(page, 1).getByRole('button', { name: '1 reply', exact: true }).click()
  await expect(card(page, 2)).toBeVisible()
  await expect.poll(() => ids(page)).toEqual([1, 2, 37, 39, 41])
  expect(reads).toEqual(['1'])
  for (const parent of [36, 38, 40]) await expect(page.getByRole('link', { name: new RegExp(`^in reply to (?:.* )?#${parent}$`) })).toBeVisible()
})

test('expanding keeps a preview beneath a deleted reply as labelled context', async ({ page, host }) => {
  const root = host.post(1, 'Root')
  const deleted = host.post(2, 'Deleted reply', { parent: 1 })
  const kept = host.post(3, 'Existing preview', { parent: 2 })
  host.post(4, 'Live direct reply', { parent: 1 })
  deleted.gate = deleted.effective_gate = '0x0000000000000000000000000000000000000001'
  root.replies = '1'
  await mount(page, host, { root: { id: 1, post: root, drawn: 0, joins: false },
    cards: [preview(kept, 0, false, true)], gates: [deleted], counts: [[1, 1]] })
  await expect(card(page, 3)).toBeVisible()
  await card(page, 1).getByRole('button', { name: '1 reply', exact: true }).click()
  await expect(card(page, 4)).toBeVisible()
  await expect.poll(() => ids(page)).toEqual([1, 4, 3])
  await expect(page.getByRole('link', { name: /in reply to (?:.* )?#2\s*· deleted by its author/ })).toBeVisible()
})


test('a kept preview moves into its parent list after readiness and survives paging once', async ({ page, host }) => {
  const root = host.post(1, 'Root')
  const parent = host.post(2, 'Preview parent', { parent: 1 })
  const replies = Array.from({ length: 45 }, (_, i) => host.post(i + 3, `Reply ${i + 3}`, { parent: 2 }))
  host.post(60, 'Direct sibling', { parent: 1 })
  await page.clock.install()
  await mount(page, host, { root: { id: 1, post: root, drawn: 1, joins: true },
    cards: [preview(parent, 1, true), preview(replies[41])], counts: [[1, 2], [2, 45], [44, 0]] })
  await expect(card(page, 44)).toBeVisible()
  await card(page, 1).getByRole('button', { name: '1 more reply', exact: true }).click()
  await expect.poll(() => ids(page)).toEqual([1, 2, 60, 44])
  const release = deferred(), started = deferred()
  await page.route(`**/api/content/${replies[0].content_hash}?*`, async route => { started.resolve(); await release.promise; await route.fallback() })
  try {
    await card(page, 2).getByRole('button', { name: '45 replies', exact: true }).click()
    await started.promise
    await page.clock.runFor(1500)
    await expect(card(page, 44).filter({ visible: true })).toHaveCount(1)
    await expect(page.getByRole('link', { name: /^in reply to (?:.* )?#2$/ })).toBeVisible()
    await page.clock.runFor(600)
    await expect(page.getByRole('link', { name: /^in reply to (?:.* )?#2$/ })).toHaveCount(0)
    await expect(card(page, 44)).toHaveCount(1)
    await expect(card(page, 44)).toBeVisible()
    await expect(page.getByText('use “show more” to read the replies in between.', { exact: true })).toBeVisible()
  } finally { release.resolve() }
  await page.getByRole('button', { name: '[ show 20 more replies ]', exact: true }).click()
  await expect(card(page, 42)).toBeVisible()
  await expect(card(page, 44)).toHaveCount(1)
  await page.getByRole('button', { name: '[ show 4 more replies ]', exact: true }).click()
  await expect.poll(() => ids(page)).toEqual([1, 2, ...Array.from({ length: 45 }, (_, i) => i + 3), 60])
  await card(page, 2).getByRole('button', { name: 'hide replies', exact: true }).click()
  await expect.poll(() => ids(page)).toEqual([1, 2, 60])
})


test('ended kept replies disappear while their surviving descendants keep context', async ({ page, host }) => {
  const root = host.post(1, 'Root')
  const parent = host.post(2, 'Parent', { parent: 1 })
  const deleted = host.post(3, 'Kept then deleted', { parent: 2 })
  const survivor = host.post(4, 'Surviving preview', { parent: 3 })
  const removed = host.post(5, 'Kept then removed', { parent: 2 })
  await mount(page, host, { root: { id: 1, post: root, drawn: 0, joins: false },
    cards: [preview(deleted, 1, true, true), preview(survivor), preview(removed, 0, false, true)],
    gates: [parent], counts: [[1, 1], [2, 2], [3, 1], [4, 0], [5, 0]] })
  await expect(card(page, 5)).toBeVisible()
  await card(page, 1).getByRole('button', { name: '1 reply', exact: true }).click()
  await expect.poll(() => ids(page)).toEqual([1, 2, 3, 4, 5])
  await page.evaluate(async chain => {
    const { gates } = await import('/src/lib/gates.svelte.ts')
    gates.settleMessage(chain, 3n, '0x0000000000000000000000000000000000000001', { block: 103n, index: 0 })
    gates.settleMessage(chain, 5n, '0x0000000000000000000000000000000000000002', { block: 103n, index: 1 })
  }, host.chain)
  await expect(card(page, 3)).toHaveCount(0)
  await expect(card(page, 5)).toHaveCount(0)
  await expect.poll(() => ids(page)).toEqual([1, 2, 4])
  await expect(page.getByRole('link', { name: /in reply to (?:.* )?#3\s*· deleted by its author/ })).toBeVisible()
})

test('hide replies forgets a preview pinned past the first page', async ({ page, host }) => {
  const root = host.post(1, 'Root')
  const replies = Array.from({ length: 25 }, (_, i) => host.post(i + 2, `Reply ${i + 2}`, { parent: 1 }))
  await mount(page, host, { root: { id: 1, post: root, drawn: 1, joins: true },
    cards: [preview(replies[24])], counts: [[1, 25], [26, 0]] })
  await expect(card(page, 26)).toBeVisible()
  await card(page, 1).getByRole('button', { name: '24 more replies', exact: true }).click()
  await expect(page.getByText('use “show more” to read the replies in between.', { exact: true })).toBeVisible()
  await expect(card(page, 26)).toHaveCount(1)
  await card(page, 1).getByRole('button', { name: 'hide replies', exact: true }).click()
  await expect.poll(() => ids(page)).toEqual([1])
  await card(page, 1).getByRole('button', { name: '25 replies', exact: true }).click()
  await expect(card(page, 21)).toBeVisible()
  await expect(card(page, 26)).toHaveCount(0)
  await expect(page.getByText('use “show more” to read the replies in between.', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '[ show 5 more replies ]', exact: true }).click()
  await expect.poll(() => ids(page)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1))
})

test('preview counts open only their own replies, then keep expansion when the parent opens', async ({ page, host }) => {
  const root = host.post(1, 'Root')
  const parent = host.post(2, 'Preview parent', { parent: 1 })
  const child = host.post(3, 'Existing child', { parent: 2 })
  const extra = host.post(4, 'Another child', { parent: 2 })
  host.post(5, 'Root sibling', { parent: 1 })
  host.post(6, 'Unopened grandchild', { parent: 3 })
  const reads = [], started = deferred(), release = deferred()
  await page.route('**/replies', async route => { reads.push(route.request().postDataJSON().parent); await route.fallback() })
  await page.route(`**/api/content/${extra.content_hash}?*`, async route => { started.resolve(); await release.promise; await route.fallback() })
  await mount(page, host, { root: { id: 1, post: root, drawn: 1, joins: true },
    cards: [preview(parent, 1, true), preview(child)], counts: [[1, 2], [2, 2], [3, 1]] })
  await expect(card(page, 3)).toBeVisible()
  try {
    await card(page, 2).getByRole('button', { name: '1 more reply', exact: true }).click()
    await started.promise
    await expect(card(page, 3).filter({ visible: true })).toHaveCount(1)
    release.resolve()
    await expect.poll(() => ids(page)).toEqual([1, 2, 3, 4])
    expect(reads).toEqual(['2'])
    await card(page, 2).getByRole('button', { name: 'hide replies', exact: true }).click()
    await expect.poll(() => ids(page)).toEqual([1, 2])
    await card(page, 2).getByRole('button', { name: '2 replies', exact: true }).click()
    await expect.poll(() => ids(page)).toEqual([1, 2, 3, 4])
    await card(page, 1).getByRole('button', { name: '1 more reply', exact: true }).click()
    await expect.poll(() => ids(page)).toEqual([1, 2, 3, 4, 5])
    expect(reads).toEqual(['2', '1'])
    await expect(card(page, 6)).toHaveCount(0)
    await card(page, 3).getByRole('button', { name: '1 reply', exact: true }).click()
    await expect.poll(() => ids(page)).toEqual([1, 2, 3, 6, 4, 5])
    expect(reads).toEqual(['2', '1', '3'])
    await card(page, 1).getByRole('button', { name: 'hide replies', exact: true }).click()
    await expect.poll(() => ids(page)).toEqual([1])
    await card(page, 1).getByRole('button', { name: '2 replies', exact: true }).click()
    await expect.poll(() => ids(page)).toEqual([1, 2, 3, 6, 4, 5])
  } finally { release.resolve() }
})


test('opening a distant preview moves it beneath its parent before offering hide replies', async ({ page, host }) => {
  const root = host.post(1, 'Root')
  const parent = host.post(2, 'Parent whose reply is farther down', { parent: 1 })
  const sibling = host.post(3, 'An intervening sibling', { parent: 1 })
  const child = host.post(4, 'The distant reply', { parent: 2 })
  await mount(page, host, { root: { id: 1, post: root, drawn: 2, joins: true },
    cards: [preview(parent, 1), preview(sibling), preview(child, 0, false, true)], counts: [[1, 2], [2, 1], [3, 0], [4, 0]] })
  await expect.poll(() => ids(page)).toEqual([1, 2, 3, 4])
  await expect(card(page, 2).getByRole('button', { name: 'hide replies', exact: true })).toHaveCount(0)
  const started = deferred(), release = deferred()
  await page.route('**/replies', async route => { started.resolve(); await release.promise; await route.fallback() }, { times: 1 })
  try {
    await card(page, 2).getByRole('button', { name: '1 reply', exact: true }).click()
    await started.promise
    await expect.poll(() => ids(page)).toEqual([1, 2, 3, 4])
  } finally { release.resolve() }
  await expect.poll(() => ids(page)).toEqual([1, 2, 4, 3])
  await expect(card(page, 4)).toHaveCount(1)
  await card(page, 2).getByRole('button', { name: 'hide replies', exact: true }).click()
  await expect.poll(() => ids(page)).toEqual([1, 2, 3])
})

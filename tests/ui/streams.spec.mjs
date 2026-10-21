import { test, expect, author, stranger, card, deferred, fulfill } from './host.mjs'

test('expanding delayed replies keeps the preview and parent height', async ({ page, host }) => {
  host.post(1, 'A topic with three replies')
  host.post(2, 'First reply', { who: stranger, parent: 1 })
  host.post(3, 'Second reply', { who: stranger, parent: 1 })
  host.post(4, 'Already visible reply', { parent: 1 })
  await page.clock.install()
  await page.goto('/')
  await expect(card(page, 4)).toBeVisible()
  const height = (await card(page, 1).boundingBox()).height
  const started = deferred(), release = deferred()
  await page.route('**/replies', async route => {
    started.resolve()
    await release.promise
    await route.fallback()
  }, { times: 1 })
  try {
    await page.getByRole('button', { name: '2 more replies', exact: true }).click()
    await started.promise
    await page.clock.runFor(350)
    await expect(card(page, 1).getByRole('button', { name: 'hide replies', exact: true })).toHaveAttribute('aria-busy', 'true')
    await expect(card(page, 4)).toBeVisible()
    await expect(card(page, 2)).toHaveCount(0)
    expect((await card(page, 1).boundingBox()).height).toBe(height)
  } finally { release.resolve() }
  await expect(card(page, 2)).toBeVisible()
  await expect(card(page, 3)).toBeVisible()
  await expect(card(page, 4)).toHaveCount(1)
  expect((await card(page, 1).boundingBox()).height).toBe(height)
})

for (const delayed of [false, true]) test(`reopening ${delayed ? 'delayed' : 'cached'} replies after collapsing at the page bottom does not scroll`, async ({ page, host }) => {
  await page.setViewportSize({ width: 1100, height: 1000 })
  host.post(1, 'A conversation at the top of the stream.\n\nIts replies can be opened independently.\n\nKeep this context in place while opening them.')
  host.post(2, 'A reply with several answers, one of which has its own reply.', { parent: 1 })
  host.post(5, 'An earlier answer', { parent: 2 })
  host.post(6, 'A longer answer.\n\n' + 'Some account-key context for this conversation.\n'.repeat(5), { parent: 2 })
  host.post(13, 'Another answer to the original post', { parent: 1, who: stranger })
  host.post(14, 'A later sibling below the expandable answer', { parent: 2, who: stranger })
  host.post(15, 'The reply being opened', { parent: 6, who: stranger })
  await page.goto('/')
  await expect(card(page, 1)).toBeVisible()
  for (const id of [1, 2]) {
    // Dismiss the automatic preview and open the ordinary direct-reply list.
    const parent = card(page, id)
    const hide = parent.getByRole('button', { name: 'hide replies', exact: true })
    if (await hide.count()) await hide.click()
    await parent.getByRole('button', { name: /\d+ repl/ }).click()
  }
  const parent = card(page, 6)
  const open = parent.getByRole('button', { name: '1 reply', exact: true })
  await open.click()
  await expect(card(page, 15)).toBeVisible()
  // Collapsing at the bottom clamps the scroll position. Chrome can retain
  // that bottom anchor and follow it down again when the reply reopens.
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await parent.getByRole('button', { name: 'hide replies', exact: true }).click()
  await expect(card(page, 15)).toHaveCount(0)
  const y = await page.evaluate(() => scrollY)
  expect(y).toBeGreaterThan(0)
  const top = (await parent.boundingBox()).y
  const started = deferred(), release = deferred()
  if (delayed) await page.route('**/changes', async route => {
    started.resolve()
    await release.promise
    await route.fallback()
  }, { times: 1 })
  try {
    await open.click()
    if (delayed) {
      await started.promise
      // The anchor reset must finish while the host is still answering.
      await expect.poll(() => page.evaluate(() => document.documentElement.style.overflowAnchor)).toBe('')
    }
  } finally { release.resolve() }
  await expect(card(page, 15)).toBeVisible()
  // Allow native scroll anchoring to run before checking the final layout.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await page.evaluate(() => scrollY)).toBe(y)
  expect((await parent.boundingBox()).y).toBe(top)
  const reply = await card(page, 15).boundingBox()
  expect(reply.y + reply.height).toBeLessThan(1000)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowAnchor)).toBe('auto')
})

test('a late body above the reader still preserves position after expanding replies', async ({ page, host }) => {
  for (let id = 1; id <= 20; id++) host.post(id, `Post ${id}\nEnough content to make this card readable.`)
  const slow = host.post(21, 'A slow post\n\n' + 'Additional text that arrives after the reader has scrolled.\n'.repeat(6))
  host.post(22, 'A reply used to exercise the anchor reset', { parent: 20, who: stranger })
  const started = deferred(), release = deferred()
  await page.route(`**/api/content/${slow.content_hash}*`, async route => {
    started.resolve()
    await release.promise
    await route.fallback()
  })
  try {
    await page.goto('/')
    await started.promise
    await expect(card(page, 15)).toBeVisible()
    await card(page, 20).getByRole('button', { name: '1 reply', exact: true }).click()
    await expect(card(page, 22)).toBeVisible()
    const reader = card(page, 15)
    await reader.evaluate(el => scrollTo(0, scrollY + el.getBoundingClientRect().top - 100))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const top = (await reader.boundingBox()).y
    release.resolve()
    await expect(card(page, 21)).toContainText('Additional text')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect((await reader.boundingBox()).y).toBeCloseTo(top, 0)
  } finally { release.resolve() }
})

for (const nested of [false, true]) test(`reopening ${nested ? 'nested' : 'thread'} replies reveals slow older siblings together`, async ({ page, host }) => {
  host.chain.blocklist = { registry: host.chain.contract, list: 'blocked' }
  host.post(1, 'Original post')
  host.post(2, 'Reply with two answers', { parent: 1 })
  host.post(5, 'Older answer whose blocklist check is slow', { who: stranger, parent: 2 })
  host.post(6, 'Newer protected answer', { parent: 2 })
  await page.clock.install()
  await page.goto(`/p/84532/${nested ? 1 : 2}`)
  if (nested) await card(page, 2).getByRole('button', { name: '2 replies', exact: true }).click()
  await expect(card(page, 5)).toBeVisible()
  await expect(card(page, 6)).toBeVisible()
  await card(page, 2).getByRole('button', { name: 'hide replies', exact: true }).click()
  await expect(card(page, 6)).toHaveCount(0)
  const height = (await card(page, 2).boundingBox()).height
  const started = deferred(), release = deferred()
  await page.route('**/state', async route => {
    if (route.request().postDataJSON().memberships?.length) {
      started.resolve()
      await release.promise
    }
    await route.fallback()
  })
  try {
    await card(page, 2).getByRole('button', { name: '2 replies', exact: true }).click()
    await started.promise
    await page.clock.runFor(350)
    // The later answer is ready, but showing it now would move it when #5 arrives.
    const readyCard = page.locator('article.msg').filter({ has: page.locator('a[aria-label="open post #6"]') })
    await expect(readyCard).toContainText('Newer protected answer')
    await expect(readyCard).not.toBeVisible()
    await expect(card(page, 5)).not.toBeVisible()
    await expect(card(page, 2).getByRole('button', { name: 'hide replies', exact: true })).toHaveAttribute('aria-busy', 'true')
    expect((await card(page, 2).boundingBox()).height).toBe(height)
  } finally { release.resolve() }
  await expect(card(page, 5)).toBeVisible()
  await expect(card(page, 6)).toBeVisible()
  await expect(page.locator('article.msg a[aria-label^="open post #"]')).toHaveText(['#1', '#2', '#5', '#6'])
  expect((await card(page, 2).boundingBox()).height).toBe(height)
})

test('profile tabs share a Back step; Back restores position and sidebar starts at the top', async ({ page, host }) => {
  for (let id = 1; id <= 25; id++) host.post(id, `Stream post ${id}\nEnough text to give this row a natural height.`)
  await page.goto('/')
  const row = card(page, 15)
  await expect(row).toBeVisible()
  const profile = row.getByRole('link', { name: 'alice.eth', exact: true })
  await profile.scrollIntoViewIfNeeded()
  const top = (await row.boundingBox()).y
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(100)
  await profile.click()
  const tabs = page.getByRole('navigation', { name: 'profile sections' })
  await tabs.getByRole('link', { name: '[ replies ]', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/u/84532/${author}/replies$`))
  await tabs.getByRole('link', { name: '[ posts ]', exact: true }).click()
  await tabs.getByRole('link', { name: '[ replies ]', exact: true }).click()
  await page.goBack()
  await expect(page).toHaveURL('http://127.0.0.1:8790/')
  await expect(row).toBeVisible()
  await expect.poll(async () => (await row.boundingBox()).y).toBeCloseTo(top, 0)
  await profile.click()
  await page.locator('nav.side').getByRole('link', { name: 'home', exact: true }).click()
  await expect(page).toHaveURL('http://127.0.0.1:8790/#/')
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0)
})

test('a late stream poll cannot overwrite the thread refresh cue', async ({ page, host }) => {
  host.post(1, 'Open this thread')
  await page.clock.install()
  await page.goto('/')
  await expect(card(page, 1)).toBeVisible()
  host.post(2, 'A new stream post')
  const started = deferred(), release = deferred()
  await page.route('**/changes', async route => {
    if (!route.request().postDataJSON().scope.feed) return route.fallback()
    const answer = await host.answer(route.request())
    started.resolve()
    await release.promise
    await fulfill(route, answer)
  }, { times: 1 })
  try {
    await page.clock.runFor(30_000)
    await started.promise
    await page.getByRole('link', { name: 'open post #1', exact: true }).click()
    await expect(page).toHaveURL(/\/p\/84532\/1/)
    await expect(card(page, 1)).toBeVisible()
    host.post(3, 'First new thread reply', { parent: 1 })
    host.post(4, 'Second new thread reply', { parent: 1 })
    const delivered = page.waitForEvent('requestfinished', { predicate: request =>
      request.url().endsWith('/changes') && !!request.postDataJSON().scope.feed })
    release.resolve()
    await delivered
    // Let Svelte process the received response without starting another poll.
    // Releasing before the next 30-second tick keeps it inside the 20-second
    // request deadline, so this checks ownership rather than a timed-out fetch.
    await page.clock.runFor(50)
    await expect(page.getByRole('button', { name: /refresh ·/ })).toHaveCount(0)
    await page.clock.runFor(30_000)
    const refresh = page.getByRole('button', { name: '[ refresh · 2 new ]', exact: true })
    await expect(refresh).toBeVisible()
    await refresh.click()
    await expect(card(page, 3)).toBeVisible()
    await expect(card(page, 4)).toBeVisible()
  } finally { release.resolve() }
})

test('the first reply keeps a separator until the thread count catches up', async ({ page, host }) => {
  host.post(1, 'Parent with a count that has not caught up')
  host.post(2, 'First reply', { parent: 1 })
  await page.route('**/message/1?*', async route => {
    const answer = await (await host.answer(route.request())).json()
    answer.message.replies = '0'
    await route.fulfill({ json: answer })
  })
  await page.goto('/p/84532/1')
  await expect(card(page, 2)).toContainText('First reply')
  await expect(card(page, 1)).not.toHaveClass(/\bconnector\b/)
  await expect(card(page, 2)).toHaveCSS('border-top-width', '1px')
})

for (const late of [false, true]) test(`deleting an expanded reply hides its branch even ${late ? 'after a late page' : 'on Back'}`, async ({ page, host }) => {
  const root = host.post(1, 'Root')
  const deleted = host.post(2, 'Reply to withdraw', { who: stranger, parent: 1 })
  for (let id = 3; id <= 102; id++) host.post(id, `Descendant ${id}`, { who: id % 2 ? author : stranger, parent: id - 1 })
  await page.goto('/p/84532/1')
  await expect(card(page, 2)).toBeVisible()
  const started = deferred(), release = deferred()
  if (late) await page.route('**/replies', async route => {
    if (route.request().postDataJSON().parent === '2') { started.resolve(); await release.promise }
    await route.fallback()
  })
  try {
    await card(page, 2).getByRole('button', { name: '1 reply', exact: true }).click()
    if (late) await started.promise
    else await expect(card(page, 3)).toBeVisible()
    // The same receipt overlay used after a confirmed local deletion.
    await page.evaluate(async chain => {
      const { gates } = await import('/src/lib/gates.svelte.ts')
      gates.settleMessage(chain, 2n, '0x0000000000000000000000000000000000000001', { block: 103n, index: 0 })
    }, host.chain)
    deleted.gate = deleted.effective_gate = '0x0000000000000000000000000000000000000001'
    root.replies = '0'
    await expect(card(page, 2)).toHaveCount(0)
    release.resolve()
    await expect(card(page, 3)).toHaveCount(0)
    await page.evaluate(async () => {
      const { router } = await import('/src/features/navigation/router.svelte.ts')
      router.go('/p/84532/2')
    })
    await expect(card(page, 2)).toContainText('deleted by its author')
    await expect(page).toHaveURL(/\/p\/84532\/2$/)
    await expect(card(page, 3)).toBeVisible()
    await expect(page.locator('.composer')).toHaveCount(0)
    await page.goBack()
    await expect(page).toHaveURL(/\/p\/84532\/1$/)
    await expect(card(page, 2)).toHaveCount(0)
    await expect(card(page, 3)).toHaveCount(0)
  } finally { release.resolve() }
})

test('thread ancestors expand other replies in place without hiding the focused post', async ({ page, host }) => {
  host.post(1, 'Oldest ancestor')
  host.post(2, 'Immediate parent', { parent: 1 })
  host.post(3, 'Another reply to oldest ancestor', { parent: 1 })
  host.post(4, 'Another reply to immediate parent', { parent: 2 })
  host.post(6, 'Addressed reply', { parent: 2 })
  host.post(7, 'Child of the addressed reply', { parent: 6 })
  await page.clock.install()
  await page.goto('/p/84532/6')
  await expect(card(page, 7)).toBeVisible()
  const more = card(page, 2).getByRole('button', { name: '1 more reply', exact: true })
  await expect(more).toBeVisible()
  const height = (await card(page, 2).boundingBox()).height
  const started = deferred(), release = deferred()
  await page.route('**/replies', async route => {
    if (route.request().postDataJSON().parent === '2') { started.resolve(); await release.promise }
    await route.fallback()
  })
  try {
    await more.click()
    await started.promise
    await page.clock.runFor(350)
    await expect(page).toHaveURL(/\/p\/84532\/6$/)
    await expect(card(page, 2).getByRole('button', { name: 'hide replies', exact: true })).toHaveAttribute('aria-busy', 'true')
    await expect(card(page, 6)).toBeVisible()
    await expect(card(page, 7)).toBeVisible()
    await expect(card(page, 4)).toHaveCount(0)
    expect((await card(page, 2).boundingBox()).height).toBe(height)
  } finally { release.resolve() }
  await expect(card(page, 4)).toBeVisible()
  await expect(card(page, 6)).toHaveCount(1)
  await expect(card(page, 6)).toHaveClass(/\bfocus\b/)
  await expect(card(page, 7)).toHaveCount(1)
  await page.getByRole('link', { name: '↑ earlier in this thread · #1', exact: true }).click()
  await card(page, 1).getByRole('button', { name: '1 more reply', exact: true }).click()
  await expect(card(page, 3)).toBeVisible()
  await expect(card(page, 2)).toHaveCount(1)
  await expect(card(page, 4)).toHaveCount(1)
  await card(page, 4).getByRole('link', { name: 'open post #4', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/4$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/p\/84532\/6$/)
  await expect(card(page, 3)).toBeVisible()
  await expect(card(page, 4)).toBeVisible()
  await card(page, 2).getByRole('button', { name: 'hide replies', exact: true }).click()
  await expect(card(page, 4)).toHaveCount(0)
  await expect(card(page, 6)).toHaveCount(1)
  await expect(card(page, 7)).toBeVisible()
  await expect(more).toBeVisible()
})


for (const total of [21, 25]) test(`ancestor expansion pages ${total - 1} other replies and keeps the refresh cue`, async ({ page, host }) => {
  host.post(1, 'Parent')
  for (let id = 2; id <= total + 1; id++) host.post(id, `Reply ${id}`, { parent: 1 })
  const focus = total + 1
  await page.clock.install()
  await page.goto(`/p/84532/${focus}`)
  await card(page, 1).getByRole('button', { name: `${total - 1} more replies`, exact: true }).click()
  await expect(card(page, 2)).toBeVisible()
  if (total === 25) {
    await expect(card(page, 22)).toHaveCount(0)
    await page.getByRole('button', { name: '[ show 4 more replies ]', exact: true }).click()
    await expect(card(page, 22)).toBeVisible()
  }
  await expect(page.getByRole('button', { name: /show.*more replies/ })).toHaveCount(0)
  await expect(page.locator('article.msg')).toHaveCount(total + 1)
  await expect(card(page, focus)).toHaveCount(1)
  host.post(total + 2, 'New sibling after expansion', { parent: 1 })
  await page.clock.runFor(30_000)
  const refresh = page.getByRole('button', { name: '[ refresh · 1 new ]', exact: true })
  await expect(refresh).toBeVisible()
  await expect(card(page, total + 2)).toHaveCount(0)
  await refresh.click()
  await expect(card(page, total + 2)).toBeVisible()
  await expect(card(page, focus)).toHaveCount(1)
  await expect(page).toHaveURL(new RegExp(`/p/84532/${focus}$`))
})

for (const view of ['thread', 'stream']) test(`${view} replies stop waiting for a slow body after two seconds`, async ({ page, host }) => {
  host.post(1, 'Root post')
  if (view === 'stream') host.post(4, 'Existing reply preview', { parent: 1 })
  const slow = host.post(5, 'Reply whose body is slow', { who: stranger, parent: 1 })
  host.post(6, 'Ready reply', { who: stranger, parent: 1 })
  await page.clock.install({ time: new Date('2026-10-04T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-04T12:00:01Z'))
  const pageStarted = deferred(), releasePage = deferred(), bodyStarted = deferred(), releaseBody = deferred()
  await page.route('**/replies', async route => {
    if (route.request().postDataJSON().parent === '1') {
      pageStarted.resolve()
      await releasePage.promise
    }
    await route.fallback()
  })
  await page.route(`**/api/content/${slow.content_hash}?*`, async route => {
    bodyStarted.resolve()
    await releaseBody.promise
    await route.fallback()
  })
  try {
    await page.goto(view === 'stream' ? '/' : '/p/84532/1')
    if (view === 'stream') {
      await expect(card(page, 4)).toBeVisible()
      await card(page, 1).getByRole('button', { name: '2 more replies', exact: true }).click()
    }
    await pageStarted.promise
    // A slow page read must not use up the cards' settling budget.
    await page.clock.runFor(2500)
    releasePage.resolve()
    await bodyStarted.promise
    const ready = page.locator('article.msg').filter({ has: page.locator('a[aria-label="open post #6"]') })
    await expect(ready).toContainText('Ready reply')
    await page.clock.runFor(1900)
    await expect(ready).not.toBeVisible()
    await page.clock.runFor(150)
    await expect(ready).toBeVisible()
    await expect(page.getByText('Reply whose body is slow', { exact: true })).toHaveCount(0)
    if (view === 'stream') await expect(card(page, 4)).toHaveCount(1)
  } finally { releasePage.resolve(); releaseBody.resolve() }
  await expect(card(page, 5)).toContainText('Reply whose body is slow')
  await expect(card(page, 5)).toBeVisible()
  await expect(card(page, 6)).toHaveCount(1)
})

test('the reply reveal deadline does not expose a body awaiting its folding verdict', async ({ page, host }) => {
  host.chain.blocklist = { registry: host.chain.contract, list: 'blocked' }
  host.post(1, 'Original post')
  host.post(2, 'Reply with two answers', { parent: 1 })
  host.post(5, 'Body that must stay folded', { who: stranger, parent: 2 })
  host.post(6, 'Protected answer', { parent: 2 })
  await page.clock.install({ time: new Date('2026-10-04T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-04T12:00:01Z'))
  const started = deferred(), release = deferred()
  await page.route('**/state', async route => {
    if (!route.request().postDataJSON().memberships?.length) return route.fallback()
    const answer = await (await host.answer(route.request())).json()
    started.resolve()
    await release.promise
    answer.memberships = answer.memberships.map(() => true)
    await route.fulfill({ json: answer })
  })
  try {
    await page.goto('/p/84532/2')
    await started.promise
    const ready = page.locator('article.msg').filter({ has: page.locator('a[aria-label="open post #6"]') })
    await expect(ready).toContainText('Protected answer')
    await page.clock.runFor(2050)
    await expect(ready).toBeVisible()
    await expect(page.getByText('Body that must stay folded', { exact: true })).toHaveCount(0)
  } finally { release.resolve() }
  await expect(card(page, 5)).toHaveClass(/\bcollapsed\b/)
  await expect(card(page, 5)).not.toContainText('Body that must stay folded')
})

test('expanding Curated replies preserves the nested preview and other stream rows', async ({ page, host }) => {
  host.policy([author])
  host.post(1, 'Curated root')
  host.post(2, 'Direct reply already visible', { parent: 1 })
  host.post(3, 'Unrelated curated post')
  host.post(6, 'Nested reply already visible', { parent: 2 })
  host.post(7, 'Other reply to the preview', { who: stranger, parent: 2 })
  host.post(13, 'Another direct reply', { who: stranger, parent: 1 })
  await page.goto('/')
  await page.getByRole('button', { name: '[ curated ]', exact: true }).click()
  await expect(card(page, 6)).toBeVisible()
  await expect(card(page, 3)).toBeVisible()
  const reads = []
  await page.route('**/replies', async route => { reads.push(route.request().postDataJSON().parent); await route.fallback() })
  await card(page, 2).getByRole('button', { name: '1 more reply', exact: true }).click()
  await expect(card(page, 7)).toBeVisible()
  expect(reads).toEqual(['2'])
  await card(page, 1).getByRole('button', { name: '1 more reply', exact: true }).click()
  await expect(card(page, 13)).toBeVisible()
  for (const id of [1, 2, 3, 6, 7, 13]) {
    await expect(card(page, id)).toHaveCount(1)
    await expect(card(page, id)).toBeVisible()
  }
  expect(reads).toEqual(['2', '1'])
  await expect(page.getByRole('link', { name: 'in reply to #2', exact: true })).toHaveCount(0)
  // Back preserves the branch opened from a preview and later moved into its parent list.
  await card(page, 13).getByRole('link', { name: 'open post #13', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/13$/)
  await page.goBack()
  await expect(card(page, 6)).toBeVisible()
  await expect(card(page, 6)).toHaveCount(1)
  await expect(card(page, 7)).toBeVisible()
  await expect(card(page, 2).getByRole('button', { name: 'hide replies', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'in reply to #2', exact: true })).toHaveCount(0)
  await expect(card(page, 6)).toHaveCount(1)
  await card(page, 2).getByRole('button', { name: 'hide replies', exact: true }).click()
  await expect(card(page, 6)).toHaveCount(0)
  await card(page, 1).getByRole('button', { name: 'hide replies', exact: true }).click()
  await card(page, 1).getByRole('button', { name: '2 replies', exact: true }).click()
  await expect(card(page, 13)).toBeVisible()
  await expect(card(page, 6)).toHaveCount(0)
})

test('stream switches show a spinner only after 300 ms, through the first-screen handoff', async ({ page, host }) => {
  host.policy([author])
  host.post(1, 'Followed post')
  const other = host.post(2, 'Everyone post', { who: stranger })
  await page.clock.install({ time: new Date('2026-10-04T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-04T12:00:01Z'))
  await page.goto('/')
  await expect(card(page, 1)).toBeVisible()
  const curatedStarted = deferred(), curatedRelease = deferred()
  const everyoneStarted = deferred(), everyoneRelease = deferred()
  const bodyStarted = deferred(), bodyRelease = deferred()
  await page.route('**/feed', async route => {
    const curated = route.request().postDataJSON().filter.any.some(clause => clause.curated)
    const started = curated ? curatedStarted : everyoneStarted
    started.resolve()
    await (curated ? curatedRelease : everyoneRelease).promise
    await route.fallback()
  })
  await page.route(`**/api/content/${other.content_hash}?*`, async route => {
    bodyStarted.resolve()
    await bodyRelease.promise
    await route.fallback()
  })
  const spinner = page.locator('.stream-start > .loading.overlay[role="status"]')
  const tabs = page.locator('nav.tabs')
  const top = (await tabs.boundingBox()).y
  try {
    await page.getByRole('button', { name: '[ curated ]', exact: true }).click()
    await curatedStarted.promise
    await page.clock.runFor(200)
    await expect(spinner).toHaveCount(0)
    await page.getByRole('button', { name: '[ everyone ]', exact: true }).click()
    await everyoneStarted.promise
    await page.clock.runFor(150)
    await expect(spinner).toHaveCount(0) // The previous stream's timer cannot reveal this one's spinner.
    await page.clock.runFor(151)
    await expect(spinner).toBeVisible()
    expect((await tabs.boundingBox()).y).toBe(top)
    everyoneRelease.resolve()
    await bodyStarted.promise
    await expect(spinner).toBeVisible() // No second delay when the feed page hands over to its cards.
    bodyRelease.resolve()
    await expect(card(page, 2)).toBeVisible()
    await expect(spinner).toHaveCount(0)
    await page.getByRole('button', { name: '[ following ]', exact: true }).click()
    await expect(card(page, 1)).toBeVisible()
    await expect(spinner).toHaveCount(0)
    await page.clock.runFor(350)
    await expect(spinner).toHaveCount(0)
  } finally {
    curatedRelease.resolve(); everyoneRelease.resolve(); bodyRelease.resolve()
  }
})

test('notifications share one spinner delay across the page read and card preparation', async ({ page, host }) => {
  host.post(1, 'My post')
  const reply = host.post(2, 'A notification body', { who: stranger, parent: 1 })
  await page.addInitScript(who => {
    window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
      if (method === 'eth_accounts') return [who]
      if (method === 'eth_chainId') return '0x14a34'
      throw Object.assign(new Error(`unsupported wallet method ${method}`), { code: 4200 })
    } }
  }, author)
  const read = deferred(), body = deferred(), started = deferred(), bodyStarted = deferred()
  await page.route('**/notifications', async route => { started.resolve(); await read.promise; await route.fallback() })
  await page.route(`**/api/content/${reply.content_hash}?*`, async route => { bodyStarted.resolve(); await body.promise; await route.fallback() })
  await page.clock.install({ time: new Date('2026-10-04T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-04T12:00:00Z'))
  await page.goto('/#/notifications')
  await started.promise
  await page.clock.runFor(200)
  const spinner = page.locator('.stream-start .loading.overlay[role="status"]')
  try {
    await expect(spinner).toHaveCount(0)
    await page.clock.runFor(101)
    await expect(spinner).toBeVisible()
    read.resolve()
    await bodyStarted.promise
    await expect(spinner).toBeVisible()
    body.resolve()
    await expect(card(page, 2)).toBeVisible()
    await expect(spinner).toHaveCount(0)
  } finally { read.resolve(); body.resolve() }
})

test('a stream row keeps one reply spinner from the thread read through its list preparing', async ({ page, host }) => {
  host.post(1, 'Followed root')
  const reply = host.post(2, 'Stranger reply', { who: stranger, parent: 1 })
  await page.clock.install({ time: new Date('2026-10-04T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-04T12:00:01Z'))
  await page.goto('/')
  await expect(card(page, 1)).toBeVisible()
  const pageStarted = deferred(), pageRelease = deferred(), bodyStarted = deferred(), bodyRelease = deferred()
  await page.route('**/replies', async route => { pageStarted.resolve(); await pageRelease.promise; await route.fallback() })
  await page.route(`**/api/content/${reply.content_hash}?*`, async route => { bodyStarted.resolve(); await bodyRelease.promise; await route.fallback() })
  const count = card(page, 1).locator('button.reply-count').first()
  try {
    await count.click()
    await pageStarted.promise
    await page.clock.runFor(200)
    await expect(count).toHaveAttribute('aria-busy', 'false')
    await page.clock.runFor(110)
    await expect(count).toHaveAttribute('aria-busy', 'true')
    pageRelease.resolve()
    await bodyStarted.promise
    await page.clock.runFor(100)
    await expect(count).toHaveAttribute('aria-busy', 'true') // The list preparing does not restart the wait.
  } finally { pageRelease.resolve(); bodyRelease.resolve() }
  await expect(card(page, 2)).toBeVisible()
  await expect(count).toHaveAttribute('aria-busy', 'false')
})

// Hold each publication stage without a real wallet or chain.
async function publication(page, host, { id = 2, parent = 0, text = 'A posted message' } = {}) {
  const txHash = `0x${'44'.repeat(32)}`
  const signed = deferred(), receipt = deferred(), uploaded = deferred()
  await page.exposeFunction('approvePost', () => signed.promise.then(() => txHash))
  await page.addInitScript(who => {
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method }) {
        if (method === 'eth_accounts') return [who]
        if (method === 'eth_chainId') return '0x14a34'
        if (method === 'eth_blockNumber') return '0x1'
        if (method === 'eth_sendTransaction' || method === 'eth_signTypedData_v4') {
          if (window.rejectPost) throw Object.assign(new Error('rejected'), { code: 4001 })
          return window.approvePost()
        }
        throw new Error(`unexpected wallet method ${method}`)
      },
    }
  }, author)
  await page.route('**/api/relay/status', route => route.fulfill({ json: {
    chains: [{ ...host.chain, name_sponsorship: { ens: true, basenames: true } }],
  } }))
  await page.route('**/eligibility/**', route => route.fulfill({ json: {
    address: author, eligible: true, reason: 'ens', posting_available: true, posting_paused_reason: null,
  } }))
  await page.route('**/api/relay/84532/post*', route => route.fulfill({ json: { tx_hash: txHash } }))
  await page.route('**/admission', route => route.fulfill({ json: { gate: `0x${'00'.repeat(20)}` } }))
  await page.route('**/post-estimate', route => route.fulfill({ json: { gas: '100000' } }))
  await page.route('**/transaction/*', async route => {
    await receipt.promise
    const message = host.post(id, text, { parent })
    await route.fulfill({ json: { hash: txHash, status: 'success', block: String(id), block_hash: host.at.checkpoint.hash,
      events: [{ kind: 'posted', message }] } })
  })
  await page.route('**/api/publish?*', async route => {
    await uploaded.promise
    const { keccak256 } = await import('viem')
    const bytes = route.request().postDataBuffer()
    await route.fulfill({ json: { hash: keccak256(bytes), stored: true, held: false, bytes: bytes.length, kind: 'body' } })
  })
  return { signed, receipt, uploaded, text }
}

for (const width of [1100, 390]) for (const reply of [false, true]) test(`a confirmed ${reply ? 'reply' : 'post'} is selected without moving the reader at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 900 })
  for (let id = 1; id <= 12; id++) host.post(id, `Post ${id}\n\nEnough room to keep reading while the wallet is pending.\n\nAnother paragraph.`)
  const { signed, receipt, uploaded, text } = await publication(page, host, { id: 13, parent: reply ? 12 : 0 })
  await page.goto('/')
  await expect(card(page, 12)).toBeVisible()
  if (reply) await card(page, 12).getByRole('button', { name: '↳ reply', exact: true }).click()
  const composer = reply ? page.locator('.composer').last() : page.locator('.home-composer .composer')
  await composer.locator('textarea').fill(text)
  try {
    await composer.getByRole('button', { name: reply ? '[ reply ]' : '[ post ]', exact: true }).click()
    signed.resolve()
    await expect(composer.locator('.transaction-status')).toContainText('transaction pending')
    // Read partway down the stream before the transaction completes. Keep
    // the parent on screen for a reply, where centering used to move it.
    const anchor = card(page, reply ? 12 : 8)
    await anchor.evaluate(el => scrollTo(0, scrollY + el.getBoundingClientRect().top - 100))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const top = (await anchor.boundingBox()).y
    receipt.resolve(); uploaded.resolve()
    await expect(card(page, 13)).toBeVisible()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    // Native scroll anchoring rounds offsets to pixels.
    expect(Math.abs((await anchor.boundingBox()).y - top)).toBeLessThanOrEqual(1)
    await expect(card(page, 13)).toHaveClass(/selected/)
    await expect(page.locator('article.msg.selected')).toHaveCount(1)
    expect(await card(page, 13).evaluate(el => el.contains(document.activeElement))).toBe(false)
  } finally { signed.resolve(); receipt.resolve(); uploaded.resolve() }
})

for (const width of [1100, 390, 320]) for (const sponsored of [false, true]) test(`${sponsored ? 'sponsored' : 'paid'} post status reuses the free-posting line without resizing at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 900 })
  host.post(1, 'Already in the stream')
  const { signed, receipt, uploaded, text } = await publication(page, host)
  await page.clock.install()
  await page.goto('/')
  const composer = page.locator('.composer')
  const status = composer.locator('.transaction-status')
  await composer.locator('textarea').fill(text)
  await expect(card(page, 1)).toBeVisible()
  if (!sponsored) await composer.getByRole('button', { name: 'pay my own gas' }).click()
  const freePosting = composer.getByRole('button', { name: sponsored ? 'pay my own gas' : 'use free posting' })
  await expect(freePosting).toBeVisible()
  const space = await composer.locator('.compose-status').evaluate(node => {
    const payment = node.querySelector('.status')
    return { reserved: node.getBoundingClientRect().height,
      needed: payment.getBoundingClientRect().height + parseFloat(getComputedStyle(payment).marginTop) }
  })
  expect.soft(space.reserved).toBeCloseTo(space.needed, 0)
  const height = (await composer.boundingBox()).height
  const homeHeight = (await page.locator('.home-composer').boundingBox()).height
  // The reconnect placeholder must not leave another blank line below the real composer.
  expect.soft(homeHeight - height).toBeLessThan(8)
  const steady = async () => expect.soft((await composer.boundingBox()).height).toBe(height)
  try {
    await composer.getByRole('button', { name: '[ post ]', exact: true }).click()
    await expect(status).toContainText(sponsored ? 'sign in your wallet' : 'confirm in your wallet')
    await expect.soft(freePosting).toBeHidden()
    await steady()
    signed.resolve()
    await expect(status).toContainText('transaction pending')
    // Routine pending text should need only one line, even on a narrow phone.
    const lines = await status.evaluate(node => {
      const text = document.createRange()
      text.selectNodeContents(node)
      return new Set([...text.getClientRects()].map(rect => Math.round(rect.top))).size
    })
    expect(lines).toBe(1)
    await steady()
    receipt.resolve()
    await expect(status).toContainText('confirmed · uploading post')
    await steady()
    uploaded.resolve()
    await expect(status).toHaveText('posted')
    await steady()
    await page.clock.runFor(4100)
    await expect(status).toBeEmpty()
    await expect(freePosting).toBeVisible()
    await steady()
    // A dismissed error restores the payment choice, without suppressing the next attempt's status.
    await page.evaluate(() => { window.rejectPost = true })
    await composer.locator('textarea').fill(text)
    for (let attempt = 0; attempt < 2; attempt++) {
      await composer.getByRole('button', { name: '[ post ]', exact: true }).click()
      await expect(status).toContainText('you rejected the request in your wallet')
      await status.getByRole('button', { name: 'dismiss' }).click()
      await expect(freePosting).toBeVisible()
      await steady()
    }
  } finally {
    signed.resolve(); receipt.resolve(); uploaded.resolve()
  }
})


test('refreshing new replies in the first conversation returns to the top', async ({ page, host }) => {
  for (let id = 1; id <= 20; id++) host.post(id, `Post ${id}\n\nEnough text to make a scrollable stream.`)
  await page.clock.install()
  await page.goto('/')
  await expect(card(page, 20)).toBeVisible()
  await page.evaluate(() => scrollTo(0, 1000))
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(500)
  host.post(21, 'New reply in the existing first conversation', { parent: 20 })
  await page.clock.runFor(30_000)
  const refresh = page.getByRole('button', { name: /refresh · 1 new/ })
  await expect(refresh).toBeVisible()
  await refresh.click()
  await expect(card(page, 21)).toBeVisible()
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0)
})


test('curated keeps loaded branches together and still lets the reader hide them', async ({ page, host }) => {
  host.policy([author])
  host.post(1, 'Curated conversation')
  for (const [id, parent] of [[2, 1], [3, 1], [4, 2], [5, 3], [6, 4], [7, 2]]) host.post(id, `Curated reply ${id}`, { parent })
  host.post(8, 'An unrelated reply stays behind the reply control', { parent: 1, who: stranger })
  await page.goto('/')
  await page.getByRole('button', { name: '[ curated ]', exact: true }).click()
  for (let id = 1; id <= 7; id++) await expect(card(page, id)).toBeVisible()
  await expect(card(page, 8)).toHaveCount(0)
  const order = () => page.getByRole('link', { name: /^open post #\d+$/ }).evaluateAll(links => links.map(link => link.getAttribute('aria-label')))
  await expect.poll(order).toEqual([1, 2, 4, 6, 7, 3, 5].map(id => `open post #${id}`))
  await card(page, 1).getByRole('button', { name: '1 more reply', exact: true }).click()
  await expect.poll(order).toEqual([1, 2, 3, 8, 4, 6, 7, 5].map(id => `open post #${id}`))
  for (let id = 1; id <= 8; id++) await expect(card(page, id)).toHaveCount(1)
  await card(page, 1).getByRole('button', { name: 'hide replies', exact: true }).click()
  for (let id = 2; id <= 8; id++) await expect(card(page, id)).toHaveCount(0)
  await expect(card(page, 1)).toBeVisible()
})

test('returning to a saved stream checks immediately without replacing its posts', async ({ page, host }) => {
  host.post(1, 'A followed post')
  host.post(2, 'An everyone post', { who: stranger })
  await page.clock.install({ time: new Date('2026-10-04T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-04T12:00:01Z'))
  await page.goto('/')
  await expect(card(page, 1)).toBeVisible()
  await page.getByRole('button', { name: '[ everyone ]', exact: true }).click()
  await expect(card(page, 2)).toBeVisible()
  await page.getByRole('button', { name: '[ following ]', exact: true }).click()
  await expect(card(page, 2)).toHaveCount(0)
  host.post(3, 'New while everyone was off screen', { who: stranger })
  await page.getByRole('button', { name: '[ everyone ]', exact: true }).click()
  await expect(card(page, 2)).toBeVisible()
  // The clock never reaches the 30-second interval. Only the mounting poll can cue this.
  const refresh = page.getByRole('button', { name: '[ refresh · 1 new ]', exact: true })
  await expect(refresh).toBeVisible()
  await expect(card(page, 3)).toHaveCount(0)
  await refresh.click()
  await expect(card(page, 3)).toBeVisible()
})

test('following includes context for a followed reply while signed out, without opening its siblings', async ({ page, host }) => {
  host.post(850, 'An earlier unfollowed topic', { who: stranger })
  host.post(854, 'A followed top-level post')
  host.post(855, 'A followed answer', { parent: 850 })
  host.post(872, 'The unfollowed topic being answered', { who: stranger })
  host.post(873, 'An unselected sibling', { who: stranger, parent: 872 })
  host.post(877, 'A followed greeting', { parent: 872 })
  await page.goto('/')
  await expect(card(page, 872)).toContainText('The unfollowed topic being answered')
  await expect(card(page, 850)).toContainText('An earlier unfollowed topic')
  const order = () => page.locator('article.msg a[aria-label^="open post #"]').evaluateAll(links => links.map(a => a.getAttribute('aria-label')))
  await expect.poll(order).toEqual([872, 877, 850, 855, 854].map(id => `open post #${id}`))
  await expect(card(page, 873)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'in reply to #872', exact: true })).toHaveCount(0)
  await card(page, 872).getByRole('button', { name: '1 more reply', exact: true }).click()
  await expect(card(page, 873)).toBeVisible()
  await expect(card(page, 877)).toHaveCount(1)
})

test('following shows the immediate unfollowed parent without adding its ancestors', async ({ page, host }) => {
  host.post(376, 'Unfollowed root', { who: stranger })
  host.post(379, 'Unfollowed parent', { who: stranger, parent: 376 })
  host.post(380, 'Followed reply', { parent: 379 })
  await page.goto('/')
  await expect(card(page, 380)).toBeVisible()
  await expect(card(page, 376)).toHaveCount(0)
  await expect(card(page, 379)).toBeVisible()
  await expect(page.getByRole('link', { name: 'in reply to #379', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'in reply to #376', exact: true })).toBeVisible()
})

for (const direct of [false, true]) test(`following ${direct ? 'keeps direct replies grouped' : 'shows parent context without promoting ancestors'}`, async ({ page, host }) => {
  host.post(345, 'Older followed post')
  host.post(522, 'Newer followed post')
  host.post(529, 'Unfollowed parent', { who: stranger, parent: 345 })
  host.post(530, 'Recent followed reply', { parent: direct ? 345 : 529 })
  host.post(531, 'Recent followed sibling', { parent: direct ? 345 : 529 })
  await page.goto('/')
  await expect(card(page, 531)).toBeVisible()
  const order = () => page.locator('article.msg a[aria-label^="open post #"]').evaluateAll(links => links.map(a => a.getAttribute('aria-label')))
  await expect.poll(order).toEqual((direct ? [345, 530, 531, 522] : [529, 530, 531, 522, 345]).map(id => `open post #${id}`))
  await expect(card(page, 529)).toHaveCount(direct ? 0 : 1)
  await expect(page.getByRole('link', { name: 'in reply to #529', exact: true })).toHaveCount(0)
  for (const id of [345, 522, 530, 531]) await expect(card(page, id)).toHaveCount(1)
})

for (const curated of [false, true]) test(`${curated ? 'curated' : 'following'} trims old automatic replies on refresh but preserves an explicitly opened branch`, async ({ page, host }) => {
  if (curated) host.policy([author])
  host.post(230, 'Old conversation')
  host.post(232, 'Old branch', { parent: 230 })
  host.post(243, 'Old nested answer', { parent: 232 })
  host.post(280, 'Old sibling', { parent: 230 })
  await page.goto('/')
  if (curated) await page.getByRole('button', { name: '[ curated ]', exact: true }).click()
  await expect(card(page, 243)).toBeVisible()
  // Automatic "hide replies" is not an explicit expansion. Open the branch.
  await card(page, 232).getByRole('button', { name: 'hide replies', exact: true }).click()
  await card(page, 232).getByRole('button', { name: '1 reply', exact: true }).click()
  await expect(card(page, 243)).toBeVisible()
  host.post(386, 'Next conversation')
  host.post(514, 'New reply', { parent: 230 })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const refresh = page.getByRole('button', { name: /refresh.*new/ })
  await expect(refresh).toBeVisible()
  await expect(card(page, 280)).toBeVisible()
  await refresh.click()
  await expect(card(page, 514)).toBeVisible()
  await expect(card(page, 280)).toHaveCount(0)
  await expect(card(page, 232)).toBeVisible()
  await expect(card(page, 243)).toBeVisible()
  await expect(card(page, 386)).toBeVisible()
  await expect(card(page, 230).getByRole('button', { name: '1 more reply', exact: true })).toBeVisible()
})


for (const curated of [false, true]) test(`${curated ? 'curated' : 'following'} reveals every new reply even below the next conversation cutoff`, async ({ page, host }) => {
  if (curated) host.policy([author])
  host.post(1, 'Conversation')
  host.post(2, 'Previously loaded reply', { parent: 1 })
  await page.clock.install()
  await page.goto('/')
  if (curated) await page.getByRole('button', { name: '[ curated ]', exact: true }).click()
  await expect(card(page, 2)).toBeVisible()
  for (const id of [3, 4, 5, 6, 7]) host.post(id, `New reply ${id}`, { parent: 1 })
  host.post(8, 'Another new conversation')
  host.post(9, 'Newest reply', { parent: 1 })
  await page.clock.runFor(60_000)
  await expect(card(page, 3)).toHaveCount(0)
  await page.getByRole('button', { name: /refresh.*new/ }).click()
  for (const id of [3, 4, 5, 6, 7, 9]) await expect(card(page, id)).toBeVisible()
  await expect(card(page, 2)).toHaveCount(0)
  await expect(card(page, 8)).toBeVisible()
  await expect(card(page, 1).getByRole('button', { name: '1 more reply', exact: true })).toBeVisible()
})


test('posting locally does not fold replies revealed by Refresh', async ({ page, host }) => {
  host.post(1, 'Conversation')
  host.post(2, 'Old reply', { parent: 1 })
  const { signed, receipt, uploaded, text } = await publication(page, host, { id: 6 })
  await page.goto('/')
  await expect(card(page, 2)).toBeVisible()
  host.post(3, 'New reply below the age cutoff', { who: stranger, parent: 1 })
  host.post(4, 'Another conversation')
  host.post(5, 'Newest reply', { who: stranger, parent: 1 })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('button', { name: /refresh.*new/ }).click()
  await expect(card(page, 3)).toBeVisible()
  await expect(card(page, 5)).toBeVisible()
  await expect(card(page, 2)).toHaveCount(0)
  const composer = page.locator('.home-composer .composer')
  await composer.locator('textarea').fill(text)
  try {
    await composer.getByRole('button', { name: '[ post ]', exact: true }).click()
    signed.resolve(); receipt.resolve(); uploaded.resolve()
    await expect(card(page, 6)).toBeVisible()
    await expect(card(page, 3)).toBeVisible()
    await expect(card(page, 5)).toBeVisible()
    await expect(card(page, 2)).toHaveCount(0)
  } finally { signed.resolve(); receipt.resolve(); uploaded.resolve() }
})


test('Everyone folds old reply previews on initial load and can expand them', async ({ page, host }) => {
  await publication(page, host)
  host.post(386, 'Older conversation')
  host.post(510, 'Older reply', { who: stranger, parent: 386 })
  host.post(513, 'Another older reply', { who: stranger, parent: 386 })
  host.post(562, 'Next conversation')
  host.post(563, 'Recent reply', { who: stranger, parent: 386 })
  await page.goto('/')
  await page.getByRole('button', { name: '[ everyone ]', exact: true }).click()
  await expect(card(page, 563)).toBeVisible()
  await expect(card(page, 562)).toBeVisible()
  for (const id of [510, 513]) await expect(card(page, id)).toHaveCount(0)
  await card(page, 386).getByRole('button', { name: '2 more replies', exact: true }).click()
  for (const id of [510, 513, 563]) await expect(card(page, id)).toBeVisible()
})


test('Refresh keeps an explicitly opened context card and its replies in Everyone', async ({ page, host }) => {
  await publication(page, host)
  host.post(1, 'Another author’s conversation', { who: stranger })
  host.post(2, 'Context parent', { who: stranger, parent: 1 })
  host.post(3, 'My reply', { parent: 2 })
  await page.goto('/')
  await page.getByRole('button', { name: '[ everyone ]', exact: true }).click()
  await expect(card(page, 3)).toBeVisible()
  await card(page, 2).getByRole('button', { name: 'hide replies', exact: true }).click()
  await card(page, 2).getByRole('button', { name: '1 reply', exact: true }).click()
  await expect(card(page, 3)).toBeVisible()
  host.post(4, 'Next conversation', { who: stranger })
  host.post(5, 'Recent reply', { parent: 1 })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('button', { name: /refresh.*new/ }).click()
  await expect(card(page, 5)).toBeVisible()
  for (const id of [2, 3]) await expect(card(page, id)).toBeVisible()
  await expect(card(page, 2).getByRole('button', { name: 'hide replies', exact: true })).toBeVisible()
})


test('Curated omits a context-only root orphaned by age folding', async ({ page, host }) => {
  await publication(page, host)
  host.policy([author])
  host.post(75, 'Unlisted root', { who: stranger })
  host.post(76, 'Old curated reply', { parent: 75 })
  host.post(82, 'Old unlisted reply', { who: stranger, parent: 76 })
  host.post(100, 'Curated answer', { parent: 82 })
  host.post(562, 'Next conversation')
  host.post(578, 'Recent question', { who: stranger, parent: 100 })
  host.post(579, 'Recent curated answer', { parent: 578 })
  await page.goto('/')
  await page.getByRole('button', { name: '[ curated ]', exact: true }).click()
  for (const id of [100, 578, 579, 562]) await expect(card(page, id)).toBeVisible()
  for (const id of [75, 76, 82]) await expect(card(page, id)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'in reply to #82', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'in reply to #75', exact: true })).toHaveCount(0)
})


test('profile replies keep older context above the immediate parent', async ({ page, host }) => {
  host.post(979, 'Original context', { who: stranger })
  host.post(997, 'An earlier answer', { parent: 979 })
  host.post(1000, 'The latest answer', { parent: 997 })
  await page.goto(`/u/84532/${author}/replies`)
  const row = page.locator('.pair')
  await expect(row).toHaveCount(1)
  await expect(row.locator('article.msg a[aria-label^="open post #"]')).toHaveText(['#979', '#997', '#1000'])
  await expect(row.getByText('Original context', { exact: true })).toBeVisible()
  await expect(row.getByText('in reply to #979', { exact: true })).toHaveCount(0)
  await expect(row.getByText('in reply to #997', { exact: true })).toHaveCount(0)
})


test('Everyone checks again on window return when an older poll is still answering', async ({ page, host }) => {
  host.post(1, 'Already displayed')
  await page.clock.install()
  await page.goto('/')
  await page.getByRole('button', { name: '[ everyone ]', exact: true }).click()
  await expect(card(page, 1)).toBeVisible()
  const started = deferred(), release = deferred()
  await page.route('**/changes', async route => {
    const answer = await host.answer(route.request())
    started.resolve()
    await release.promise
    await fulfill(route, answer)
  }, { times: 1 })
  const refresh = page.getByRole('button', { name: /refresh.*new/ })
  try {
    await page.clock.runFor(30_000)
    await started.promise
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    host.post(2, 'Posted while the window was away', { who: stranger })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(refresh).toHaveCount(0)
  } finally { release.resolve() }
  // No further timer tick: the return must survive the old, empty answer.
  await expect(refresh).toBeVisible()
  await expect(card(page, 2)).toHaveCount(0)
  await refresh.click()
  await expect(card(page, 2)).toBeVisible()
})

for (const reply of [false, true]) test(`exhausted free posts automatically use wallet gas for a ${reply ? 'reply' : 'post'}`, async ({ page, host }) => {
  host.post(1, 'Parent post')
  await publication(page, host, { parent: reply ? 1 : 0 })
  let available = false, relayed = 0
  await page.route('**/eligibility/**', route => route.fulfill({ json: {
    address: author, eligible: true, reason: 'ens', posting_available: available,
    posting_paused_reason: available ? null : 'daily allowance used',
  } }))
  await page.route('**/api/relay/84532/post*', async route => { relayed++; await route.fallback() })
  await page.goto('/')
  await expect(card(page, 1)).toBeVisible()
  if (reply) await card(page, 1).getByRole('button', { name: '↳ reply', exact: true }).click()
  const composer = reply ? page.locator('.composer').last() : page.locator('.home-composer .composer')
  await composer.locator('textarea').fill('My reply after the free allowance is spent')
  const submit = composer.locator('.post-action')
  await expect(submit).toBeEnabled()
  await expect(composer.getByRole('status').filter({ hasText: 'daily allowance used' })).toContainText('you pay gas')
  await page.evaluate(() => {
    window.postMethods = []
    window.rejectPost = true
    const request = window.ethereum.request.bind(window.ethereum)
    window.ethereum.request = async args => {
      if (args.method === 'eth_sendTransaction' || args.method === 'eth_signTypedData_v4') window.postMethods.push(args.method)
      return request(args)
    }
  })
  await submit.click()
  await expect.poll(() => page.evaluate(() => window.postMethods)).toEqual(['eth_sendTransaction'])
  await expect(composer.locator('textarea')).toHaveValue('My reply after the free allowance is spent')
  expect(relayed).toBe(0)
  // A restored allowance selects free posting again; automatic fallback is not a saved paid preference.
  await composer.getByRole('button', { name: /dismiss/ }).click()
  await expect(composer.getByText('daily allowance used', { exact: false })).toBeVisible()
  available = true
  await composer.getByRole('button', { name: /retry/, exact: false }).click()
  await expect(composer.getByRole('button', { name: /pay my own gas/ })).toBeVisible()
  await expect(composer.getByText('free via your ENS name')).toBeVisible()
})

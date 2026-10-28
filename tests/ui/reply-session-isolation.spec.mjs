import { test, expect, author, stranger, card, deferred, fulfill } from './host.mjs'

test('paging a thread does not enlarge the stream branch on Back', async ({ page, host }) => {
  host.post(1, 'Stream root')
  for (let id = 2; id <= 31; id++) host.post(id, `Reply ${id}`, { who: stranger, parent: 1 })
  await page.goto('/')
  await card(page, 1).getByRole('button', { name: '30 replies', exact: true }).click()
  await expect(card(page, 21)).toBeVisible()
  await expect(card(page, 22)).toHaveCount(0)
  await card(page, 1).getByRole('link', { name: 'open post #1', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 22)).toHaveCount(0)
  await page.getByRole('button', { name: /show .* more repl/ }).click()
  await expect(card(page, 31)).toBeVisible()
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(card(page, 21)).toBeVisible()
  await expect(card(page, 22)).toHaveCount(0)
})

test('refreshing a thread does not add its new replies to the stream on Back', async ({ page, host }) => {
  host.post(1, 'Stream root')
  host.post(2, 'Original reply', { who: stranger, parent: 1 })
  await page.clock.install()
  await page.goto('/')
  await card(page, 1).getByRole('button', { name: '1 reply', exact: true }).click()
  await expect(card(page, 2)).toBeVisible()
  await card(page, 1).getByRole('link', { name: 'open post #1', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 2)).toBeVisible()
  host.post(3, 'New while away', { who: stranger, parent: 1 })
  await page.clock.runFor(30_000)
  await page.getByRole('button', { name: /refresh.*new/ }).click()
  await expect(card(page, 3)).toBeVisible()
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(card(page, 2)).toBeVisible()
  await expect(card(page, 3)).toHaveCount(0)
})

test('opening a thread without refreshing leaves new replies out of the returning stream', async ({ page, host }) => {
  host.post(1, 'Root')
  host.post(2, 'Original reply', { who: stranger, parent: 1 })
  await page.goto('/')
  await card(page, 1).getByRole('button', { name: '1 reply', exact: true }).click()
  await expect(card(page, 2)).toBeVisible()
  host.post(3, 'Arrived while the stream was open', { who: stranger, parent: 1 })
  await card(page, 1).getByRole('link', { name: 'open post #1', exact: true }).click()
  await expect(card(page, 3)).toBeVisible()
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(card(page, 2)).toBeVisible()
  await expect(card(page, 3)).toHaveCount(0)
})

test('Following and Curated own their reply page lengths independently', async ({ page, host }) => {
  host.policy([author])
  host.post(1, 'Root')
  for (let id = 2; id <= 31; id++) host.post(id, `Reply ${id}`, { who: stranger, parent: 1 })
  await page.goto('/')
  await card(page, 1).getByRole('button', { name: '30 replies', exact: true }).click()
  await expect(card(page, 21)).toBeVisible()
  await expect(card(page, 22)).toHaveCount(0)
  await page.getByRole('button', { name: '[ curated ]', exact: true }).click()
  await card(page, 1).getByRole('button', { name: '30 replies', exact: true }).click()
  await page.getByRole('button', { name: /show .* more repl/ }).click()
  await expect(card(page, 31)).toBeVisible()
  await page.getByRole('button', { name: '[ following ]', exact: true }).click()
  await expect(card(page, 21)).toBeVisible()
  await expect(card(page, 22)).toHaveCount(0)
})

for (const width of [1100, 390]) test(`separate thread visits keep their own pages and Back snapshot at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 850 })
  host.post(1, 'Root')
  for (let id = 2; id <= 31; id++) host.post(id, `Reply ${id}`, { who: stranger, parent: 1 })
  await page.goto('/')
  await card(page, 1).getByRole('button', { name: '30 replies', exact: true }).click()
  await expect(card(page, 21)).toBeVisible()
  await card(page, 1).getByRole('link', { name: 'open post #1', exact: true }).click()
  await page.getByRole('button', { name: /show .* more repl/ }).click()
  await expect(card(page, 31)).toBeVisible()
  // The page arrow keeps the first thread visit in browser history.
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(card(page, 22)).toHaveCount(0)
  host.post(32, 'New after the first thread visit', { who: stranger, parent: 1 })
  await card(page, 1).getByRole('link', { name: 'open post #1', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 21)).toBeVisible()
  await expect(card(page, 22)).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(/\/$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 31)).toBeVisible()
  await expect(card(page, 32)).toHaveCount(0)
})


test('Back to a previously refreshed thread keeps its displayed replies', async ({ page, host }) => {
  host.post(1, 'Root')
  host.post(2, 'Original reply', { who: stranger, parent: 1 })
  await page.clock.install()
  await page.goto('/')
  await card(page, 1).getByRole('link', { name: 'open post #1', exact: true }).click()
  await expect(card(page, 2)).toBeVisible()
  host.post(3, 'Added by refresh', { who: stranger, parent: 1 })
  await page.clock.runFor(30_000)
  await page.getByRole('button', { name: /refresh.*new/ }).click()
  await expect(card(page, 3)).toBeVisible()
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  host.post(4, 'New while away', { who: stranger, parent: 1 })
  await page.goBack()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 3)).toBeVisible()
  await expect(card(page, 4)).toHaveCount(0)
  await page.clock.runFor(30_000)
  await page.getByRole('button', { name: /refresh.*new/ }).click()
  await expect(card(page, 4)).toBeVisible()
})


async function openRoot(page) {
  await card(page, 1).getByRole('link', { name: 'open post #1', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
}

test('page-arrow thread return does not enlarge its original history entry', async ({ page, host }) => {
  host.post(1, 'Root')
  for (let id = 2; id <= 31; id++) host.post(id, `Reply ${id}`, { who: stranger, parent: 1 })
  await page.goto('/')
  await openRoot(page)
  await expect(card(page, 21)).toBeVisible()
  await card(page, 2).getByRole('link', { name: 'open post #2', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/2$/)
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await page.getByRole('button', { name: /show .* more repl/ }).click()
  await expect(card(page, 31)).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/p\/84532\/2$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 21)).toBeVisible()
  await expect(card(page, 22)).toHaveCount(0)
})

test('a late thread page cannot enlarge the returning stream', async ({ page, host }) => {
  host.post(1, 'Root')
  for (let id = 2; id <= 31; id++) host.post(id, `Reply ${id}`, { who: stranger, parent: 1 })
  await page.goto('/')
  await card(page, 1).getByRole('button', { name: '30 replies', exact: true }).click()
  await expect(card(page, 21)).toBeVisible()
  await openRoot(page)
  await expect(card(page, 21)).toBeVisible()
  const started = deferred(), release = deferred(), finished = deferred()
  await page.route('**/replies', async route => {
    started.resolve()
    const response = await host.answer(route.request())
    await release.promise
    await fulfill(route, response)
    finished.resolve()
  })
  try {
    await page.getByRole('button', { name: /show .* more repl/ }).click()
    await started.promise
    await page.getByRole('button', { name: 'back', exact: true }).click()
    await expect(card(page, 21)).toBeVisible()
    release.resolve()
    await finished.promise
    await expect(card(page, 22)).toHaveCount(0)
    await page.goBack()
    await expect(page).toHaveURL(/\/p\/84532\/1$/)
    await expect(card(page, 31)).toBeVisible()
  } finally { release.resolve() }
})

test('a failed thread page leaves stream paging usable', async ({ page, host }) => {
  host.post(1, 'Root')
  for (let id = 2; id <= 31; id++) host.post(id, `Reply ${id}`, { who: stranger, parent: 1 })
  await page.goto('/')
  await card(page, 1).getByRole('button', { name: '30 replies', exact: true }).click()
  await expect(card(page, 21)).toBeVisible()
  await openRoot(page)
  await expect(card(page, 21)).toBeVisible()
  await page.route('**/replies', route => route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'busy', code: 'host_busy'})}), { times: 1 })
  await page.getByRole('button', { name: /show .* more repl/ }).click()
  await expect(page.getByRole('button', { name: /try again/ })).toBeVisible()
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(card(page, 22)).toHaveCount(0)
  await page.getByRole('button', { name: /show .* more repl/ }).click()
  await expect(card(page, 31)).toBeVisible()
})


test('stream refresh cannot add replies to a retained thread on browser Back', async ({ page, host }) => {
  host.post(1, 'Root')
  host.post(2, 'Original reply', { who: stranger, parent: 1 })
  await page.clock.install()
  await page.goto('/')
  await card(page, 1).getByRole('button', { name: '1 reply', exact: true }).click()
  await expect(card(page, 2)).toBeVisible()
  await openRoot(page)
  await expect(card(page, 2)).toBeVisible()
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  host.post(3, 'New reply', { who: stranger, parent: 1 })
  await page.clock.runFor(30_000)
  await page.getByRole('button', { name: /refresh.*new/ }).click()
  await card(page, 1).getByRole('button', { name: '2 replies', exact: true }).click()
  await expect(card(page, 3)).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 2)).toBeVisible()
  await expect(card(page, 3)).toHaveCount(0)
})


test('a copied thread does not wait for or adopt the original visit pending refresh', async ({ page, host }) => {
  host.post(1, 'Root')
  host.post(2, 'Original reply', { who: stranger, parent: 1 })
  await page.clock.install()
  await page.goto('/')
  await openRoot(page)
  await expect(card(page, 2)).toBeVisible()
  host.post(3, 'New reply', { who: stranger, parent: 1 })
  await page.clock.runFor(30_000)
  const refresh = page.getByRole('button', { name: /refresh.*new/ })
  await expect(refresh).toBeVisible()
  const started = deferred(), release = deferred(), finished = deferred()
  await page.route('**/changes', async route => {
    started.resolve()
    const answer = await host.answer(route.request())
    await release.promise
    await fulfill(route, answer)
    finished.resolve()
  }, { times: 1 })
  try {
    await refresh.click()
    await started.promise
    await card(page, 2).getByRole('link', { name: 'open post #2', exact: true }).click()
    await expect(page).toHaveURL(/\/p\/84532\/2$/)
    await page.getByRole('button', { name: 'back', exact: true }).click()
    await expect(page).toHaveURL(/\/p\/84532\/1$/)
    await expect(card(page, 2)).toBeVisible()
    await expect(card(page, 3)).toHaveCount(0)
    release.resolve()
    await finished.promise
    await page.goBack()
    await expect(page).toHaveURL(/\/p\/84532\/2$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/p\/84532\/1$/)
    await expect(card(page, 3)).toBeVisible()
    await page.goForward()
    await page.goForward()
    await expect(page).toHaveURL(/\/p\/84532\/1$/)
    await expect(card(page, 2)).toBeVisible()
    await expect(card(page, 3)).toHaveCount(0)
  } finally { release.resolve() }
})


test('page-arrow thread return keeps nested open choices independent', async ({ page, host }) => {
  host.post(1, 'Root')
  host.post(2, 'Reply with a branch', { who: stranger, parent: 1 })
  host.post(3, 'Nested reply', { who: stranger, parent: 2 })
  await page.goto('/')
  await openRoot(page)
  await card(page, 2).getByRole('button', { name: '1 reply', exact: true }).click()
  await expect(card(page, 3)).toBeVisible()
  await card(page, 2).getByRole('link', { name: 'open post #2', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/2$/)
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 3)).toBeVisible()
  await card(page, 2).getByRole('button', { name: 'hide replies', exact: true }).click()
  await expect(card(page, 3)).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(/\/p\/84532\/2$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 3)).toBeVisible()
  await page.goForward()
  await page.goForward()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 3)).toHaveCount(0)
})

test('refreshing a page-arrow thread copy leaves the original history entry unchanged', async ({ page, host }) => {
  host.post(1, 'Root')
  host.post(2, 'Original reply', { who: stranger, parent: 1 })
  await page.clock.install()
  await page.goto('/')
  await openRoot(page)
  await expect(card(page, 2)).toBeVisible()
  await card(page, 2).getByRole('link', { name: 'open post #2', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/2$/)
  await page.getByRole('button', { name: 'back', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  host.post(3, 'New after the copy', { who: stranger, parent: 1 })
  await page.clock.runFor(30_000)
  await page.getByRole('button', { name: /refresh.*new/ }).click()
  await expect(card(page, 3)).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/p\/84532\/2$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 2)).toBeVisible()
  await expect(card(page, 3)).toHaveCount(0)
  await page.goForward()
  await page.goForward()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await expect(card(page, 3)).toBeVisible()
})


test.describe('isolation matrix', () => {
  const THREAD = /\/p\/84532\/1$/, HOME = /\/$/

  function wallet(page, who = author) {
    return page.addInitScript(who => {
      window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
        if (method === 'eth_accounts') return [who]
        if (method === 'eth_chainId') return '0x14a34'
        if (method === 'eth_blockNumber') return '0x100'
        throw new Error(`unexpected wallet call ${method}`)
      } }
    }, who)
  }
  const tab = (page, name) => page.addInitScript(name => localStorage.setItem('blohard.home.tab', JSON.stringify(name)), name)
  /** A root with `replies` direct replies by a stranger, the first of which has one nested reply. */
  function conversation(host, replies = 1) {
    host.post(1, 'Root')
    for (let id = 2; id <= replies + 1; id++) host.post(id, `Reply ${id}`, { who: stranger, parent: 1 })
    host.post(100, 'Nested under the first reply', { who: stranger, parent: 2 })
  }
  const openBranch = async (page, id, label) => { await card(page, id).getByRole('button', { name: label, exact: true }).click() }
  // These cells mutate settled views; the tests above cover outstanding reads.
  async function settled(page) {
    await expect(page.locator('.reply-list.preparing')).toHaveCount(0)
    await expect(page.getByText(/^loading/)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /try again/ })).toHaveCount(0)
  }
  const permalink = async (page, id = 1) => { await card(page, id).getByRole('link', { name: `open post #${id}`, exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/p/84532/${id}$`)); await settled(page) }
  const arrow = async (page) => { await page.getByRole('button', { name: 'back', exact: true }).click() }
  const showMore = async (page) => { await page.getByRole('button', { name: /show .* more repl/ }).click() }
  const hideReplies = async (page, id) => { await card(page, id).getByRole('button', { name: 'hide replies', exact: true }).click() }
  async function refreshHere(page, host, id, parent = 1, { inStream = false, count } = {}) {
    host.post(id, `Arrived #${id}`, { who: stranger, parent })
    await page.clock.runFor(30_000)
    const refresh = page.getByRole('button', { name: /refresh/ })
    await expect(refresh).toBeVisible()
    await refresh.click()
    // An explicit stream refresh closes its open branches by design, so only the count shows the arrival there.
    if (inStream) await expect(card(page, parent).getByRole('button', { name: count, exact: true })).toBeVisible()
    else await expect(card(page, id)).toBeVisible()
  }
  const tombstone = (page, host, id) => page.evaluate(async ({ chain, id }) => {
    const { gates } = await import('/src/lib/gates.svelte.ts')
    gates.settleMessage(chain, BigInt(id), `0x${'1'.padStart(40, '0')}`, { block: 1000n, index: 0 })
  }, { chain: host.chain, id })

  /** The wallet, relay and transaction routes that let the reader post a reply in place. */
  async function publishing(page, host, { id, parent, text = 'My own reply' }) {
    const txHash = `0x${'44'.repeat(32)}`
    const signed = deferred(), receipt = deferred(), uploaded = deferred()
    await page.exposeFunction('approvePost', () => signed.promise.then(() => txHash))
    await page.addInitScript(who => {
      window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
        if (method === 'eth_accounts') return [who]
        if (method === 'eth_chainId') return '0x14a34'
        if (method === 'eth_blockNumber') return '0x1'
        if (method === 'eth_sendTransaction' || method === 'eth_signTypedData_v4') return window.approvePost()
        throw new Error(`unexpected wallet method ${method}`)
      } }
    }, author)
    await page.route('**/api/relay/status', route => route.fulfill({ json: { chains: [{ ...host.chain, name_sponsorship: { ens: true, basenames: true } }] } }))
    await page.route('**/eligibility/**', route => route.fulfill({ json: { address: author, eligible: true, reason: 'ens', posting_available: true, posting_paused_reason: null } }))
    await page.route('**/api/relay/84532/post*', route => route.fulfill({ json: { tx_hash: txHash } }))
    await page.route('**/admission', route => route.fulfill({ json: { gate: `0x${'00'.repeat(20)}` } }))
    await page.route('**/post-estimate', route => route.fulfill({ json: { gas: '100000' } }))
    await page.route('**/transaction/*', async route => {
      await receipt.promise
      const message = host.post(id, text, { parent })
      await route.fulfill({ json: { hash: txHash, status: 'success', block: String(id), block_hash: host.at.checkpoint.hash, events: [{ kind: 'posted', message }] } })
    })
    await page.route('**/api/publish?*', async route => {
      await uploaded.promise
      const { keccak256 } = await import('viem')
      const bytes = route.request().postDataBuffer()
      await route.fulfill({ json: { hash: keccak256(bytes), stored: true, held: false, bytes: bytes.length, kind: 'body' } })
    })
    return async function replyUnder(parentCard) {
      await card(page, parentCard).getByRole('button', { name: '↳ reply', exact: true }).click()
      const composer = page.locator('.composer').filter({ visible: true })
      await composer.locator('textarea').fill(text)
      await composer.getByRole('button', { name: '[ reply ]', exact: true }).click()
      signed.resolve(); receipt.resolve(); uploaded.resolve()
      await expect(card(page, id)).toBeVisible()
    }
  }

  // ---------------------------------------------------------------------------
  // Boundary 1: a stream row's open branch and the thread entered from it.
  // ---------------------------------------------------------------------------
  for (const mutation of ['page', 'hide nested', 'refresh', 'quiet poll', 'delete']) test(`stream row ← thread: ${mutation} in the thread`, async ({ page, host }) => {
    conversation(host, mutation === 'page' ? 30 : 2)
    await page.clock.install()
    await page.goto('/')
    await openBranch(page, 1, mutation === 'page' ? '30 replies' : '2 replies')
    await openBranch(page, 2, '1 reply')
    await expect(card(page, 100)).toBeVisible()
    if (mutation === 'page') { await expect(card(page, 21)).toBeVisible(); await expect(card(page, 22)).toHaveCount(0) }
    await permalink(page)
    await expect(card(page, 100)).toBeVisible()
    if (mutation === 'page') { await showMore(page); await expect(card(page, 31)).toBeVisible() }
    if (mutation === 'hide nested') { await hideReplies(page, 2); await expect(card(page, 100)).toHaveCount(0) }
    if (mutation === 'refresh') await refreshHere(page, host, 150)
    if (mutation === 'quiet poll') { host.post(150, 'Arrived during the thread poll', { who: stranger, parent: 1 }); await page.clock.runFor(30_000); await expect(page.getByRole('button', { name: /refresh/ })).toBeVisible(); await expect(card(page, 150)).toHaveCount(0) }
    if (mutation === 'delete') { await tombstone(page, host, 3); await expect(card(page, 3)).toHaveCount(0) }
    await arrow(page)
    await expect(page).toHaveURL(HOME)
    await expect(card(page, 1)).toBeVisible()
    if (mutation === 'page') { await expect(card(page, 21)).toBeVisible(); await expect(card(page, 22)).toHaveCount(0) }
    if (mutation === 'hide nested') await expect(card(page, 100)).toBeVisible()
    if (mutation === 'refresh' || mutation === 'quiet poll') { await expect(card(page, 2)).toBeVisible(); await expect(card(page, 150)).toHaveCount(0) }
    // The gates ledger is tab-wide by design: a deletion leaves every view at once.
    if (mutation === 'delete') { await expect(card(page, 2)).toBeVisible(); await expect(card(page, 3)).toHaveCount(0) }
  })

  for (const mutation of ['page', 'hide nested', 'refresh']) test(`thread ← stream row: ${mutation} in the stream, then Forward`, async ({ page, host }) => {
    conversation(host, mutation === 'page' ? 30 : 2)
    await page.clock.install()
    await page.goto('/')
    await openBranch(page, 1, mutation === 'page' ? '30 replies' : '2 replies')
    await openBranch(page, 2, '1 reply')
    await expect(card(page, 100)).toBeVisible()
    await permalink(page)
    await expect(card(page, 100)).toBeVisible()
    if (mutation === 'page') { await expect(card(page, 21)).toBeVisible(); await expect(card(page, 22)).toHaveCount(0) }
    await page.goBack()
    await expect(page).toHaveURL(HOME)
    await expect(card(page, 100)).toBeVisible()
    if (mutation === 'page') { await showMore(page); await expect(card(page, 31)).toBeVisible() }
    if (mutation === 'hide nested') { await hideReplies(page, 2); await expect(card(page, 100)).toHaveCount(0) }
    if (mutation === 'refresh') await refreshHere(page, host, 150, 1, { inStream: true, count: '3 replies' })
    await page.goForward()
    await expect(page).toHaveURL(THREAD)
    if (mutation === 'page') { await expect(card(page, 21)).toBeVisible(); await expect(card(page, 22)).toHaveCount(0) }
    if (mutation === 'hide nested') await expect(card(page, 100)).toBeVisible()
    if (mutation === 'refresh') { await expect(card(page, 2)).toBeVisible(); await expect(card(page, 150)).toHaveCount(0) }
  })

  for (const complete of [true, false]) test(`stream row ← thread: an own reply ${complete ? 'joins a complete branch' : 'leaves a paging gap intact'} on Back`, async ({ page, host }) => {
    host.post(1, 'A stranger posts', { who: stranger })
    for (let id = 2; id <= (complete ? 3 : 31); id++) host.post(id, `Reply ${id}`, { who: stranger, parent: 1 })
    await tab(page, 'everyone')
    const reply = await publishing(page, host, { id: 200, parent: 1 })
    await page.goto('/')
    await openBranch(page, 1, complete ? '2 replies' : '30 replies')
    await expect(card(page, complete ? 3 : 21)).toBeVisible()
    await permalink(page)
    await reply(1)
    await arrow(page)
    await expect(page).toHaveURL(HOME)
    await expect(card(page, 1)).toBeVisible()
    // Designed behaviour: a confirmed own reply is appended to a complete branch and held back from a partial one.
    if (complete) await expect(card(page, 200)).toBeVisible()
    else { await expect(card(page, 21)).toBeVisible(); await expect(card(page, 22)).toHaveCount(0); await expect(card(page, 200)).toHaveCount(0) }
  })

  // ---------------------------------------------------------------------------
  // Boundary 2: a thread visit and the copy the page arrow makes of it.
  // ---------------------------------------------------------------------------
  for (const mutation of ['page', 'hide nested', 'refresh', 'delete']) test(`thread ← arrow copy: ${mutation} in the copy`, async ({ page, host }) => {
    conversation(host, mutation === 'page' ? 30 : 2)
    await page.clock.install()
    await page.goto('/')
    await permalink(page)
    await openBranch(page, 2, '1 reply')
    await expect(card(page, 100)).toBeVisible()
    await permalink(page, 100)
    await arrow(page)
    await expect(page).toHaveURL(THREAD)
    await expect(card(page, 100)).toBeVisible()
    await settled(page)
    if (mutation === 'page') { await showMore(page); await expect(card(page, 31)).toBeVisible() }
    if (mutation === 'hide nested') { await hideReplies(page, 2); await expect(card(page, 100)).toHaveCount(0) }
    if (mutation === 'refresh') await refreshHere(page, host, 150)
    if (mutation === 'delete') { await tombstone(page, host, 3); await expect(card(page, 3)).toHaveCount(0) }
    await page.goBack()
    await expect(page).toHaveURL(/\/p\/84532\/100$/)
    await page.goBack()
    await expect(page).toHaveURL(THREAD)
    if (mutation === 'page') { await expect(card(page, 21)).toBeVisible(); await expect(card(page, 22)).toHaveCount(0) }
    if (mutation === 'hide nested') await expect(card(page, 100)).toBeVisible()
    if (mutation === 'refresh') { await expect(card(page, 2)).toBeVisible(); await expect(card(page, 150)).toHaveCount(0) }
    if (mutation === 'delete') { await expect(card(page, 2)).toBeVisible(); await expect(card(page, 3)).toHaveCount(0) }
  })

  // ---------------------------------------------------------------------------
  // Boundary 3: two Home tabs showing the same conversation.
  // ---------------------------------------------------------------------------
  for (const mutation of ['page', 'hide nested', 'refresh', 'delete']) test(`following ← curated: ${mutation} on the curated tab`, async ({ page, host }) => {
    host.policy([author])
    conversation(host, mutation === 'page' ? 30 : 2)
    await page.clock.install()
    await page.goto('/')
    await openBranch(page, 1, mutation === 'page' ? '30 replies' : '2 replies')
    await openBranch(page, 2, '1 reply')
    await expect(card(page, 100)).toBeVisible()
    if (mutation === 'page') { await expect(card(page, 21)).toBeVisible(); await expect(card(page, 22)).toHaveCount(0) }
    await page.getByRole('button', { name: '[ curated ]', exact: true }).click()
    await openBranch(page, 1, mutation === 'page' ? '30 replies' : '2 replies')
    await openBranch(page, 2, '1 reply')
    await expect(card(page, 100)).toBeVisible()
    if (mutation === 'page') { await showMore(page); await expect(card(page, 31)).toBeVisible() }
    if (mutation === 'hide nested') { await hideReplies(page, 2); await expect(card(page, 100)).toHaveCount(0) }
    if (mutation === 'refresh') await refreshHere(page, host, 150, 1, { inStream: true, count: '3 replies' })
    if (mutation === 'delete') { await tombstone(page, host, 3); await expect(card(page, 3)).toHaveCount(0) }
    await page.getByRole('button', { name: '[ following ]', exact: true }).click()
    await expect(card(page, 1)).toBeVisible()
    if (mutation === 'page') { await expect(card(page, 21)).toBeVisible(); await expect(card(page, 22)).toHaveCount(0) }
    if (mutation === 'hide nested') await expect(card(page, 100)).toBeVisible()
    if (mutation === 'refresh') { await expect(card(page, 2)).toBeVisible(); await expect(card(page, 150)).toHaveCount(0) }
    if (mutation === 'delete') { await expect(card(page, 2)).toBeVisible(); await expect(card(page, 3)).toHaveCount(0) }
  })

  // ---------------------------------------------------------------------------
  // Boundary 4: a profile stream and the thread entered from it.
  // ---------------------------------------------------------------------------
  for (const mutation of ['page', 'hide nested', 'refresh']) test(`profile row ← thread: ${mutation} in the thread`, async ({ page, host }) => {
    conversation(host, mutation === 'page' ? 30 : 2)
    await page.clock.install()
    await page.goto(`/u/84532/${author}`)
    await openBranch(page, 1, mutation === 'page' ? '30 replies' : '2 replies')
    await openBranch(page, 2, '1 reply')
    await expect(card(page, 100)).toBeVisible()
    await permalink(page)
    if (mutation === 'page') { await showMore(page); await expect(card(page, 31)).toBeVisible() }
    if (mutation === 'hide nested') { await hideReplies(page, 2); await expect(card(page, 100)).toHaveCount(0) }
    if (mutation === 'refresh') await refreshHere(page, host, 150)
    await arrow(page)
    await expect(page).toHaveURL(new RegExp(`/u/84532/${author}$`))
    if (mutation === 'page') { await expect(card(page, 21)).toBeVisible(); await expect(card(page, 22)).toHaveCount(0) }
    if (mutation === 'hide nested') await expect(card(page, 100)).toBeVisible()
    if (mutation === 'refresh') { await expect(card(page, 2)).toBeVisible(); await expect(card(page, 150)).toHaveCount(0) }
  })

  // ---------------------------------------------------------------------------
  // Boundary 5: a context-link thread (an ancestor) and the stream it came from.
  // ---------------------------------------------------------------------------
  for (const mutation of ['page', 'refresh']) test(`stream row ← ancestor thread via context link: ${mutation}`, async ({ page, host }) => {
    host.post(1, 'Earlier ancestor', { who: stranger })
    host.post(2, 'Visible parent', { who: stranger, parent: 1 })
    host.post(3, 'Followed reply', { parent: 2 })
    for (let id = 4; id <= 28; id++) host.post(id, `Reply ${id} under the followed reply`, { who: stranger, parent: 3 })
    await page.clock.install()
    await page.goto('/')
    await openBranch(page, 3, '25 replies')
    await expect(card(page, 23)).toBeVisible()
    await expect(card(page, 24)).toHaveCount(0)
    await page.locator('.conversation-context[href="/p/84532/1"]').click()
    await expect(page).toHaveURL(THREAD)
    await expect(card(page, 23)).toBeVisible()
    await settled(page)
    if (mutation === 'page') { await showMore(page); await expect(card(page, 28)).toBeVisible() }
    if (mutation === 'refresh') await refreshHere(page, host, 150, 1)
    await arrow(page)
    await expect(page).toHaveURL(HOME)
    await expect(card(page, 23)).toBeVisible()
    await expect(card(page, 24)).toHaveCount(0)
    await expect(card(page, 150)).toHaveCount(0)
  })

  // ---------------------------------------------------------------------------
  // Boundary 6: the notifications page and a thread opened from a reply count.
  // ---------------------------------------------------------------------------
  test('notifications ← thread opened from a reply count: paging', async ({ page, host }) => {
    host.post(1, 'My post')
    host.post(2, 'A stranger answers', { who: stranger, parent: 1 })
    for (let id = 3; id <= 32; id++) host.post(id, `Reply ${id} under the answer`, { who: stranger, parent: 2 })
    await wallet(page)
    await page.goto('/#/notifications')
    await expect(card(page, 2)).toBeVisible()
    const count = card(page, 2).getByRole('link', { name: '30 replies', exact: true })
    await expect(count).toBeVisible()
    await count.click()
    await expect(page).toHaveURL(/\/p\/84532\/2\?replies$/)
    await expect(card(page, 22)).toBeVisible()
    await showMore(page)
    await expect(card(page, 32)).toBeVisible()
    await arrow(page)
    await expect(page).toHaveURL(/#\/notifications$/)
    await expect(card(page, 2)).toBeVisible()
    await expect(card(page, 2).getByRole('link', { name: '30 replies', exact: true })).toBeVisible()
    await expect(card(page, 22)).toHaveCount(0)
  })
})

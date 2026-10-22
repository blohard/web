import { test, expect, author, stranger, card } from './host.mjs'

const tx = `0x${'44'.repeat(32)}`
const purchase = block => ({ position: { block: String(block), log: 1 }, timestamp: 1_800_000_000 + block, transaction: tx,
  event: { kind: 'trade', creator: author, holder: stranger, buy: true, amount: 2, supply: 2 } })
async function configure(page, host, read) {
  const market = host.chain.contract
  await page.route('**/api/status', async route => {
    const status = await (await host.answer(route.request())).json()
    status.keyrings = [{ chain: host.chain.id, market, start_block: 0 }]
    await route.fulfill({ json: status })
  })
  await page.route('**/keyring/*/balances?*', route => route.fulfill({ json: { market, view: 'holding', active: false, own_balance: 0, total: 0, entries: [], next: null, checkpoint: host.at.checkpoint } }))
  await page.route('**/keyring/activity?*', async route => {
    const answer = read(new URL(route.request().url()))
    if (!answer) return route.fulfill({ status: 503, json: { code: 'keyring_syncing', error: 'syncing' } })
    await route.fulfill({ json: { market, checkpoint: { block: '1000', hash: tx }, ...answer } })
  })
  await page.addInitScript(() => localStorage.setItem('blohard.home.tab', JSON.stringify('everyone')))
}
const activity = page => page.locator('[data-feed-row^="key/"]')

test('Everyone interleaves purchases and transfers; whole cards open the key owner; other streams stay posts only', async ({ page, host }) => {
  host.policy([author])
  host.post(20, 'ordinary post')
  const transfer = { ...purchase(40), event: { kind: 'transfer', creator: author, from: stranger, to: author, amount: 1 } }
  let reads = 0
  await configure(page, host, () => { reads++; return { items: [transfer, purchase(30)], next: null } })
  await page.goto('/')
  await expect(activity(page)).toHaveCount(2)
  await expect(activity(page).nth(1)).toContainText("bob.eth just bought 2 of alice.eth's keys!")
  await expect(activity(page).first()).toContainText("bob.eth just transferred 1 of alice.eth's keys to alice.eth!")
  await expect(card(page, 20)).toBeVisible()
  expect(await page.locator('[data-feed-row]').evaluateAll(nodes => nodes.map(n => n.dataset.feedRow).filter(x => x.startsWith('key/') || x === '20'))).toEqual(['key/40/1', 'key/30/1', '20'])
  // The card's padding hits the same link as its text, without a wallet action.
  await page.evaluate(() => document.addEventListener('click', e => {
    const link = e.target.closest('a')
    if (link?.pathname.endsWith('/keys')) { window.cardDestination = link.pathname; e.preventDefault(); e.stopImmediatePropagation() }
  }, { capture: true }))
  await activity(page).nth(1).locator('.key-activity').click({ position: { x: 5, y: 5 } })
  expect(await page.evaluate(() => window.cardDestination)).toBe(`/u/84532/${author}/keys`)
  await page.getByRole('button', { name: '[ curated ]', exact: true }).click()
  await expect(card(page, 20)).toBeVisible()
  await expect(activity(page)).toHaveCount(0)
  await page.getByRole('button', { name: '[ following ]', exact: true }).click()
  await expect(card(page, 20)).toBeVisible()
  await expect(activity(page)).toHaveCount(0)
  expect(reads).toBe(1)
})

test('key-only pages paginate and quiet activity appears only after Refresh', async ({ page, host }) => {
  let latest = 45
  await configure(page, host, url => {
    const before = Number(url.searchParams.get('before_block') ?? latest + 1)
    const top = Math.min(before - 1, latest)
    const count = Math.min(top, 100)
    return { items: Array.from({ length: count }, (_, i) => purchase(top - i)), next: top > count ? { block: String(top - count + 1), log: 1 } : null }
  })
  await page.clock.install()
  await page.goto('/')
  await expect(activity(page)).toHaveCount(20)
  latest = 46
  await page.clock.runFor(30_000)
  const refresh = page.getByRole('button', { name: /refresh/ })
  await expect(refresh).toBeVisible()
  await page.getByRole('button', { name: /show more posts/ }).click()
  await expect(activity(page)).toHaveCount(40)
  await expect(refresh).toBeVisible()
  await page.getByRole('button', { name: /show more posts/ }).click()
  await expect(activity(page)).toHaveCount(45)
  await expect(page.getByText("you've reached the end of this stream")).toBeVisible()
  await expect(refresh).toBeVisible()
  await expect(activity(page)).toHaveCount(45)
  await refresh.click()
  await expect(activity(page)).toHaveCount(46)
  await expect(activity(page).first()).toHaveAttribute('data-feed-row', 'key/46/1')
  await expect(refresh).toHaveCount(0)
})

test('an unavailable key index leaves posts readable and its retry recovers', async ({ page, host }) => {
  host.post(20, 'still readable')
  let available = false
  await configure(page, host, () => available ? { items: [purchase(30)], next: null } : null)
  await page.goto('/')
  await expect(card(page, 20)).toBeVisible()
  await expect(page.getByText('could not update key activity.')).toBeVisible()
  available = true
  await page.getByRole('button', { name: '[ try again ]', exact: true }).click()
  await expect(activity(page)).toHaveCount(1)
  await expect(page.getByText('could not update key activity.')).toHaveCount(0)
})


test('activation cards show initial purchases once, including activation without keys', async ({ page, host }) => {
  const activation = (block, creator, amount) => ({ ...purchase(block), event: { kind: 'activated', creator, amount } })
  await configure(page, host, () => ({ items: [purchase(40), activation(30, author, 3), activation(20, stranger, 0)], next: null }))
  await page.goto('/')
  await expect(activity(page)).toHaveCount(3)
  await expect(activity(page).nth(1)).toContainText('alice.eth just activated account keys and bought 3 of their own keys!')
  await expect(activity(page).nth(2)).toContainText('bob.eth just activated account keys!')
  await expect(activity(page).nth(2)).not.toContainText('bought')
  await expect(activity(page).nth(1).getByRole('link').first()).toHaveAttribute('href', `/u/84532/${author}/keys`)
  await expect(activity(page).first()).toContainText("bob.eth just bought 2 of alice.eth's keys!")
})

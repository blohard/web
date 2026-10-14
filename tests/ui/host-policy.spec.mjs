import { test, expect, card, author, stranger } from './host.mjs'

test('a host block hides an already-rendered post on policy refresh, with no show override', async ({ page, host }) => {
  host.policy([author])
  host.post(1, 'A cached post that the host will block')
  await page.goto('/p/84532/1')
  await expect(card(page, 1)).toContainText('A cached post that the host will block')
  host.policy([author], [author])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('post blocked by host', { exact: true })).toBeVisible()
  await expect(page.getByText('A cached post that the host will block', { exact: true })).toHaveCount(0)
  await expect(card(page, 1)).toHaveCount(0)
})

test('host blocks also hide replies in an embedded discussion', async ({ page, host }) => {
  host.policy([author])
  host.post(1, 'Topic')
  host.post(2, 'Visible reply before blocking', { who: stranger, parent: 1 })
  await page.goto('/embed.html?chain=84532&post=1')
  await expect(card(page, 2)).toContainText('Visible reply before blocking')
  host.policy([author], [stranger])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(card(page, 2)).toHaveCount(0)
})

test('the connected host admin can reach every list editor on desktop and phone', async ({ page, host }) => {
  host.policy([author], [stranger])
  await page.addInitScript(who => {
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method }) {
        if (method === 'eth_accounts') return [who]
        if (method === 'eth_chainId') return '0x14a34'
        throw Object.assign(new Error(`unsupported wallet method ${method}`), { code: 4200 })
      },
    }
  }, author)
  await page.goto('/#/list')
  const tabs = page.getByRole('navigation', { name: 'host lists' })
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 })
    // One list per tab, each with its own editor; the blocked tab is the admin's.
    for (const [tab, heading] of [['curated', 'curated accounts'], ['bots', 'bots labelled by this host'], ['blocked', 'blocked accounts']]) {
      await tabs.getByRole('link', { name: `[ ${tab} ]`, exact: true }).click()
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      await expect(page.getByLabel('addresses to add or remove')).toHaveCount(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
    // The takedown list is the admin's too, and shown only once they sign.
    await tabs.getByRole('link', { name: '[ takedowns ]', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'taken down content', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'sign to see the list' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})

test('the account list has one tab per list, switching adds no Back step, and bots show a robot', async ({ page, host }) => {
  host.policy([author], [], { bots: [stranger], declared: [author] })
  host.post(1, 'A post by a declared bot')
  host.post(2, 'A post by a labelled bot', { who: stranger })
  await page.goto('/')
  await page.goto('/#/list')
  const tabs = page.getByRole('navigation', { name: 'host lists' })
  await expect(tabs.getByRole('link', { name: '[ curated ]', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(tabs.getByRole('link', { name: '[ blocked ]', exact: true })).toHaveCount(0)
  await expect(tabs.getByRole('link', { name: '[ takedowns ]', exact: true })).toHaveCount(0)
  await tabs.getByRole('link', { name: '[ bots ]', exact: true }).click()
  await expect(page).toHaveURL(/#\/list\/bots$/)
  await expect(page.getByRole('heading', { name: 'bots labelled by this host', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'bots by their own statement', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'curated accounts', exact: true })).toHaveCount(0)
  // Tabs replace the URL, as profile tabs do: Back leaves the page, Forward returns to the tab.
  await page.goBack()
  await expect(page).not.toHaveURL(/#\/list/)
  await page.goForward()
  await expect(page).toHaveURL(/#\/list\/bots$/)
  await expect(page.getByRole('heading', { name: 'bots labelled by this host', exact: true })).toBeVisible()
  await page.goto('/')
  await page.getByRole('button', { name: '[ everyone ]', exact: true }).click()
  await expect(card(page, 1).getByRole('img', { name: 'bot · declared by this account', exact: true })).toBeVisible()
  await expect(card(page, 2).getByRole('img', { name: 'bot · labelled by this host', exact: true })).toBeVisible()
})

// The picture may come after a long text: the whole text is searched for it.
for (const [where, filler] of [['a short post', ''], ['a long post', `${'x'.repeat(650)} `]]) test(`the admin sees ${where}'s words and picture, and takes down only the picture`, async ({ page, host }) => {
  host.policy([author], [])
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const picture = host.record(Buffer.concat([Buffer.from('version/1 image/png\n'), png]))
  const reported = host.post(1, `reported words ${filler}![a picture](record:${picture})`)
  await page.addInitScript(who => {
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method }) {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [who]
        if (method === 'eth_chainId') return '0x14a34'
        if (method === 'personal_sign') return `0x${'11'.repeat(65)}`
        throw Object.assign(new Error(`unsupported wallet method ${method}`), { code: 4200 })
      },
    }
  }, author)
  await page.goto('/#/list/takedowns')
  await page.getByRole('button', { name: 'sign to see the list' }).click()
  await expect(page.getByText('nothing is taken down.')).toBeVisible()
  await page.getByLabel('post link or content hash').fill('http://127.0.0.1:8790/p/84532/1')
  await page.getByRole('button', { name: 'look up' }).click()
  await expect(page.locator('blockquote.words')).toContainText('reported words')
  await expect(page.getByRole('img', { name: 'attachment 1' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'attachment 1' })).not.toBeChecked()
  await page.getByRole('checkbox', { name: 'attachment 1' }).check()
  await page.getByRole('checkbox', { name: "the post's text" }).uncheck()
  await page.getByRole('button', { name: 'review takedown' }).click()
  await expect(page.getByText('every copy of these bytes stops being served by this host')).toBeVisible()
  await page.getByRole('button', { name: '[ take down ]', exact: true }).click()
  await expect(page.getByText('taken down', { exact: true })).toBeVisible()
  expect(host.takedowns().hashes).toEqual([picture])
  expect(host.takedowns().hashes).not.toContain(reported.content_hash)
  await expect(page.locator('.taken code')).toHaveText([picture])
})

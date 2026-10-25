import { test, expect, author, deferred, card } from './host.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
const url = 'https://avatars.invalid/picture.png'
async function setup(page) {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
    window.avatarUrls = { created: [], revoked: [] }
    URL.createObjectURL = blob => { const url = create(blob); window.avatarUrls.created.push(url); return url }
    URL.revokeObjectURL = url => { window.avatarUrls.revoked.push(url); revoke(url) }
  })
  await page.goto('/tests/ui/fixtures/avatars.html')
  await page.waitForFunction(() => window.avatarFixture)
}
const loaded = async locator => {
  await expect(locator).toBeVisible()
  await expect.poll(() => locator.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
}

for (const width of [1100, 390]) test(`mounted avatars own their URLs at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 800 })
  let requests = 0
  await page.route('https://avatars.invalid/**', route => { requests++; return route.fulfill({ contentType: 'image/png', body: png }) })
  await setup(page)
  await page.evaluate(({ author, url }) => {
    avatarFixture.set(author, url)
    avatarFixture.show('first', author); avatarFixture.show('second', author)
  }, { author, url })
  await loaded(page.locator('#first img'))
  await loaded(page.locator('#second img'))
  const first = await page.locator('#first img').getAttribute('src')
  const second = await page.locator('#second img').getAttribute('src')
  expect(first).not.toBe(second)
  expect(requests).toBe(1)
  await page.evaluate(() => avatarFixture.hide('first'))
  expect(await page.evaluate(() => avatarUrls.revoked)).toEqual([first])
  await loaded(page.locator('#second img'))
  await page.evaluate(author => avatarFixture.show('first', author), author)
  await loaded(page.locator('#first img'))
  expect(await page.locator('#first img').getAttribute('src')).not.toBe(first)
  expect(requests).toBe(1)
  await page.evaluate(() => Promise.all(['first', 'second'].map(id => avatarFixture.hide(id))))
  expect(await page.evaluate(() => [...avatarUrls.revoked].sort())).toEqual(await page.evaluate(() => [...avatarUrls.created].sort()))
})

test('cache eviction does not disturb mounted avatars or refetch their images', async ({ page, host }) => {
  let requests = 0
  await page.route('https://avatars.invalid/**', route => { requests++; return route.fulfill({ contentType: 'image/png', body: png }) })
  await setup(page)
  await page.evaluate(({ author, url }) => { avatarFixture.set(author, url); avatarFixture.show('first', author) }, { author, url })
  await loaded(page.locator('#first img'))
  const src = await page.locator('#first img').getAttribute('src')
  await page.evaluate(async url => {
    const { avatars } = await import('/src/lib/avatars.ts')
    for (let i = 1; i <= 257; i++) await avatars.read(`0x${i.toString(16).padStart(40, '0')}`, url)
  }, url)
  await loaded(page.locator('#first img'))
  expect(await page.locator('#first img').getAttribute('src')).toBe(src)
  expect(await page.evaluate(() => avatarUrls.created)).toEqual([src])
  expect(await page.evaluate(() => avatarUrls.revoked)).toEqual([])
  expect(requests).toBe(258)
  await page.evaluate(author => avatarFixture.show('second', author), author)
  await loaded(page.locator('#second img'))
  expect(requests, 'an evicted blob still comes from disk').toBe(258)
})

test('a source change revokes the old URL, but a name-only update keeps it', async ({ page, host }) => {
  await page.route('https://avatars.invalid/**', route => route.fulfill({ contentType: 'image/png', body: png }))
  await setup(page)
  await page.evaluate(({ author, url }) => { avatarFixture.set(author, url); avatarFixture.show('first', author) }, { author, url })
  await loaded(page.locator('#first img'))
  const first = await page.locator('#first img').getAttribute('src')
  await page.evaluate(async author => {
    const { names } = await import('/src/lib/names.svelte.ts')
    names.entries[author] = { ...names.entries[author], name: 'renamed.eth', checkedAt: Date.now() }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, author)
  expect(await page.locator('#first img').getAttribute('src')).toBe(first)
  expect(await page.evaluate(() => avatarUrls.revoked)).toEqual([])
  await page.evaluate(({ author, url }) => avatarFixture.set(author, `${url}?changed`), { author, url })
  await expect(page.locator('#first img')).not.toHaveAttribute('src', first)
  await loaded(page.locator('#first img'))
  expect(await page.evaluate(() => avatarUrls.revoked)).toEqual([first])
  await page.evaluate(author => avatarFixture.set(author, null), author)
  await expect(page.locator('#first svg')).toBeVisible()
  expect(await page.evaluate(() => [...avatarUrls.revoked].sort())).toEqual(await page.evaluate(() => [...avatarUrls.created].sort()))
  // Returning to the original source must not revive its already revoked URL.
  await page.evaluate(({ author, url }) => avatarFixture.set(author, url), { author, url })
  await loaded(page.locator('#first img'))
  expect(await page.locator('#first img').getAttribute('src')).not.toBe(first)
  await page.evaluate(() => avatarFixture.hide('first'))
  expect(await page.evaluate(() => [...avatarUrls.revoked].sort())).toEqual(await page.evaluate(() => [...avatarUrls.created].sort()))
})

for (const unmount of [false, true]) test(`late avatar completion after ${unmount ? 'unmount' : 'source change'} creates no stale URL`, async ({ page, host }) => {
  const started = deferred(), release = deferred()
  await page.route('https://avatars.invalid/**', async route => {
    if (route.request().url() === url) { started.resolve(); await release.promise }
    await route.fulfill({ contentType: 'image/png', body: png })
  })
  await setup(page)
  await page.evaluate(({ author, url }) => { avatarFixture.set(author, url); avatarFixture.show('first', author) }, { author, url })
  await started.promise
  try {
    if (unmount) await page.evaluate(() => avatarFixture.hide('first'))
    else {
      await page.evaluate(({ author, url }) => avatarFixture.set(author, `${url}?new`), { author, url })
      await loaded(page.locator('#first img'))
    }
  } finally { release.resolve() }
  // Await the cache's actual flight, including its disk write and component callback.
  await page.evaluate(async ({ author, url }) => {
    const { avatars } = await import('/src/lib/avatars.ts')
    await avatars.read(author, url)
  }, { author, url })
  expect(await page.evaluate(() => avatarUrls.created.length)).toBe(unmount ? 0 : 1)
  expect(await page.evaluate(() => avatarUrls.revoked)).toEqual([])
  if (!unmount) await loaded(page.locator('#first img'))
})

for (const refused of [false, true]) test(`avatar ${refused ? 'refusal stays an identicon' : 'CORS failure keeps the direct-image fallback'}`, async ({ page, host }) => {
  const types = []
  await page.route('https://avatars.invalid/**', route => {
    types.push(route.request().resourceType())
    if (refused) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg/>' })
    if (route.request().resourceType() === 'fetch') return route.abort('failed')
    return route.fulfill({ contentType: 'image/png', body: png })
  })
  await setup(page)
  await page.evaluate(({ author, url }) => { avatarFixture.set(author, url); avatarFixture.show('first', author) }, { author, url })
  await page.evaluate(async ({ author, url }) => { const { avatars } = await import('/src/lib/avatars.ts'); await avatars.read(author, url) }, { author, url })
  if (refused) {
    await expect(page.locator('#first svg')).toBeVisible()
    expect(types).toEqual(['fetch'])
  } else {
    await loaded(page.locator('#first img'))
    await expect(page.locator('#first img')).toHaveAttribute('src', url)
    expect(types).toEqual(['fetch', 'image'])
  }
  expect(await page.evaluate(() => avatarUrls.created)).toEqual([])
})

for (const width of [1100, 390]) test(`avatars render through stream, thread and Back at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 800 })
  host.post(1, 'An author with an avatar')
  host.post(2, 'A reply with the same avatar', { parent: 1 })
  await page.goto('/')
  const picture = id => card(page, id).locator('img.avatar').first()
  await loaded(picture(1))
  await loaded(picture(2))
  await expect(picture(1)).toHaveAttribute('src', /^blob:/)
  await expect(card(page, 1)).toContainText('alice.eth')
  await card(page, 1).getByRole('link', { name: 'open post #1', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/1$/)
  await loaded(picture(1))
  await loaded(picture(2))
  await page.goBack()
  await loaded(picture(1))
  await loaded(picture(2))
  await expect(picture(1)).toHaveAttribute('src', /^blob:/)
})

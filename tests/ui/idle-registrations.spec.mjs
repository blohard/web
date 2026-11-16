// A page that sits idle keeps what it registered. While the host's answers do
// not change, no poller closes and opens again and no stream mounts again, on
// pages resumed with Back as well as fresh ones. An effect that follows state
// it never meant to follow shows up here as a registration repeating on every
// poll, with nothing else visibly wrong.
import { test, expect, author, card } from './host.mjs'

const REGISTRATION = / (poller (opened|closed) poller=|stream (mounted|unmounted) view=)/

/** The page's registrations, read from its poll log after every step: the log keeps only its latest entries. */
function registrations(page) {
  const seen = new Set()
  let inFlight = 0
  page.on('request', () => inFlight++)
  page.on('requestfinished', () => inFlight--)
  page.on('requestfailed', () => inFlight--)
  return {
    /** Wait for the page's requests to settle, then collect the entries logged so far. */
    async read() {
      do {
        await expect.poll(() => inFlight).toBe(0)
        // A round trip to the page, so a request it has just started is counted before the next look.
        await page.evaluate(() => 0)
      } while (inFlight !== 0)
      const lines = await page.evaluate(() => window.blohardPolls?.().split('\n') ?? [])
      // Without the time column: an entry is the event, its kind and its instance number.
      for (const line of lines) if (REGISTRATION.test(line)) seen.add(line.split(' ').slice(2).join(' '))
      return [...seen]
    },
  }
}

/** What is registered now: every opening or mount whose closing has not been logged. */
function open(entries) {
  const closed = new Set(entries.filter(e => / (closed|unmounted) /.test(` ${e}`)).map(e => /id=(\d+)/.exec(e)[1]))
  return entries.filter(e => !/^(poller closed|stream unmounted) /.test(e) && !closed.has(/id=(\d+)/.exec(e)[1]))
    .map(e => e.replace(/^(poller opened poller=|stream mounted view=)/, '').replace(/ id=\d+.*$/, '')).sort()
}

async function setUp(page, host) {
  host.policy([author])
  for (let id = 1; id <= 25; id++) host.post(id, `Post ${id}\nEnough text for a scrollable stream.`)
  host.post(26, 'A reply under post 15', { parent: 15 })
  await page.addInitScript(() => {
    localStorage.setItem('blohard.debug.polls', 'true')
    localStorage.setItem('blohard.home.tab', JSON.stringify('everyone'))
  })
  await page.clock.install()
  await page.goto('/')
  await expect(card(page, 15)).toBeVisible()
}
const openThread = async page => {
  await card(page, 15).getByRole('link', { name: 'open post #15', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/84532\/15$/)
  await expect(card(page, 26)).toBeVisible()
}
const openProfile = async page => {
  await card(page, 15).getByRole('link', { name: 'alice.eth', exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`/u/84532/${author}$`))
  await expect(card(page, 15)).toBeVisible()
}

const pages = [
  { name: 'the Everyone stream', registered: ['everyone', 'home', 'policy'],
    async resume(page) { await openThread(page); await page.goBack(); await expect(page).toHaveURL(/\/$/) } },
  { name: 'a profile', registered: ['author', 'policy', 'profile'],
    async resume(page) { await openProfile(page); await openThread(page); await page.goBack(); await expect(page).toHaveURL(new RegExp(`/u/84532/${author}$`)) } },
  { name: 'a thread', registered: ['policy', 'thread'],
    async resume(page) { await openThread(page); await openProfile(page); await page.goBack(); await expect(page).toHaveURL(/\/p\/84532\/15$/) } },
]

for (const { name, registered, resume } of pages) test(`${name} resumed with Back keeps its registrations while idle`, async ({ page, host }) => {
  const log = registrations(page)
  await setUp(page, host)
  await log.read()
  await resume(page)
  await expect(card(page, 15)).toBeVisible()
  const before = await log.read()
  expect(open(before), 'what the resumed page registered').toEqual(registered)

  // Two minutes of unchanged answers, with one return to the window on the way.
  for (let step = 0; step < 4; step++) {
    if (step === 2) await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })
    await page.clock.runFor(30_000)
    await log.read()
  }
  const after = await log.read()
  expect(after.filter(entry => !before.includes(entry)), 'registrations made while idle').toEqual([])
  // The page did check in that time: an idle page that stopped polling would pass the line above too.
  expect(await page.evaluate(() => window.blohardPolls())).toContain('trigger=interval')
})

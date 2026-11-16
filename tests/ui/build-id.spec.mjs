// The page names the build it runs, so a tab opened before a deploy can be told
// from a current one without asking the site what it serves now.
import { execFileSync } from 'node:child_process'
import { test, expect, card } from './host.mjs'

test('the page names its build in the console and at the top of the poll log copy', async ({ page, host }) => {
  host.post(1, 'A post')
  await page.addInitScript(() => localStorage.setItem('blohard.debug.polls', 'true'))
  await page.goto('/')
  await expect(card(page, 1)).toBeVisible()
  const build = await page.evaluate(() => window.blohardBuild)
  // This checkout's revision, marked when tracked files have uncommitted changes.
  const head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim()
  expect(build).toMatch(new RegExp(`^${head}(-dirty)?$`))
  await expect.poll(() => page.evaluate(() => window.blohardPolls?.().split('\n')[0] ?? ''))
    .toMatch(new RegExp(`^build ${build}, page loaded \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d$`))
})

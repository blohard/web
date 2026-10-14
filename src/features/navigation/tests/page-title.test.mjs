// The browser tab's title follows the page, in the forms the host's share pages use.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, address } from '../../../../scripts/harness.mjs'
const { tabTitle } = await load('features/navigation/page-title.ts')
const { parse, parseLocation } = await load('features/navigation/router.svelte.ts')
beforeEach(install)
after(teardown)

test('each page names itself in the tab, and home is the site alone', () => {
  const alice = address('aa')
  const name = (a) => a.toLowerCase() === alice ? 'alice.eth' : 'someone'
  const title = (hash, heading = 'unused') => tabTitle(parse(hash), heading, name)
  assert.equal(title('#/'), 'blohard')
  assert.equal(title('#/notifications', 'notifications'), 'notifications · blohard')
  assert.equal(title('#/following', 'following'), 'following · blohard')
  assert.equal(tabTitle(parseLocation('/about'), 'about', name), 'about blohard')
  assert.equal(tabTitle(parseLocation('/p/84532/7'), 'post', name), 'post #7 · blohard')
  assert.equal(tabTitle(parseLocation(`/u/84532/${alice}`), 'profile', name), 'alice.eth · blohard')
  assert.equal(tabTitle(parseLocation(`/u/84532/${alice}/replies`), 'profile', name), 'alice.eth replies · blohard')
  assert.equal(tabTitle(parseLocation(`/u/84532/${alice}/keys`), 'profile', name), 'alice.eth account keys · blohard')
  assert.equal(title(`/u/84532/${alice}/keyring`), 'alice.eth keyring · blohard')
  assert.equal(title(`/u/84532/${alice}/keyring/holders`), 'alice.eth key holders · blohard')
  assert.equal(tabTitle({ kind: 'keys', chainId: 84532, about: true }, 'about account keys', name), 'about account keys · blohard')
})

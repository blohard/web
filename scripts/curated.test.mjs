import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, curate, mock, author } from './host-harness.mjs'
const { host } = await load('lib/host.svelte.ts')
beforeEach(install)
after(teardown)
test('curated badges update directly from host policy, without chain reads', () => {
  curate([author])
  assert.equal(host.curated(author), true)
  curate([])
  assert.equal(host.curated(author), false)
  assert.equal(mock.calls.length, 0)
})
test('host blocking overrides curation', () => {
  curate([author])
  host.status.host_policy.blocked = [author]
  assert.equal(host.curated(author), false)
})

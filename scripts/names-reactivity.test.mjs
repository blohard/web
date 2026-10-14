// A name's answer redraws what shows that name, not every name on the page.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactiveFixture } from './svelte-test.mjs'

const { watching, names, host, flushSync } = await reactiveFixture(new URL('./fixtures/names-reactivity.svelte.ts', import.meta.url))

test('another name arriving does not redraw this one', async () => {
  host.status = { gateway: { names: true } }
  const shown = `0x${'b1'.repeat(20)}`, other = `0x${'b2'.repeat(20)}`
  names.entries[shown] = { name: 'shown.eth', source: 'ens', avatar: null, checkedAt: Date.now() }
  globalThis.fetch = async () => new Response(JSON.stringify({ name: 'other.eth', source: 'ens', avatar: null }), { headers: { 'content-type': 'application/json' } })
  const view = watching(shown)
  try {
    flushSync()
    const before = view.runs
    await names.hint(other)
    flushSync()
    assert.equal(view.runs, before, 'only the answered name redraws')
    assert.equal(names.display(other), 'other.eth')
  } finally { view.stop() }
})

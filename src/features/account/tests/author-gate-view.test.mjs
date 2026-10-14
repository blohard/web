// The account-wide reply rule and activation in settings, through their real controllers with the reads stubbed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactiveFixture } from '../../../../scripts/svelte-test.mjs'

const { Settings, AuthorGate, flushSync } = await reactiveFixture(new URL('./fixtures/author-gate.svelte.ts', import.meta.url))
async function settle() { for (let i = 0; i < 10; i++) { flushSync(); await Promise.resolve() } }

for (const [name, make] of Object.entries({ Settings, AuthorGate })) {
  for (const change of ['account', 'chain']) {
    test(`${name} scopes pending selection and late transaction notes to the ${change}`, async () => {
      let finish
      const view = make(() => new Promise(resolve => { finish = resolve }))
      try {
        await settle()
        const action = view.act(); await settle()
        if (name === 'AuthorGate') assert.equal(view.selected, 'keys')
        view.change(change === 'account' ? 'bob' : 'alice', change === 'chain' ? 2 : 1); await settle()
        if (name === 'AuthorGate') assert.equal(view.selected, 'all')
        finish(); await action; await settle()
        assert.equal(view.note, null, 'a late completion must not annotate a different account or chain')
        view.change('alice', 1); await settle(); assert.equal(view.note.ok, true)
        view.change('bob', 2); await settle(); assert.equal(view.note, null, 'completed notes also belong to their original account')
      } finally { view.stop() }
    })
  }
}

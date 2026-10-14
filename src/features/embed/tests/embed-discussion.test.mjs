// When the embed widget reloads its discussion and rechecks folds, through its real controller.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactiveFixture } from '../../../../scripts/svelte-test.mjs'

const { widget, flushSync } = await reactiveFixture(new URL('./fixtures/embed-discussion.svelte.ts', import.meta.url))
async function settle() { for (let i = 0; i < 10; i++) { flushSync(); await Promise.resolve() } }

test('widget explicit refresh rechecks folds after its page while visibility return preserves verdicts', async () => {
  const view = widget()
  try {
    await settle()
    const first = view.folds, firstPage = view.page
    await first
    view.back(); await settle()
    assert.notEqual(view.page, firstPage)
    assert.equal(view.folds, first, 'automatic return must not recheck displayed folds')
    view.refresh(); await settle()
    assert.notEqual(view.folds, first)
    assert.equal(view.folds, view.page, 'folds wait for the explicitly refreshed page')
    const refreshed = view.folds
    view.back(); await settle(); assert.equal(view.folds, refreshed)
  } finally { view.stop() }
})

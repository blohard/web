// The notice's automatic check runs once per outstanding change, whatever its own bookkeeping does.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactiveFixture } from './svelte-test.mjs'

const { notice, flushSync } = await reactiveFixture(new URL('./fixtures/unsettled-check.svelte.ts', import.meta.url))
async function settle() {
  for (let i = 0; i < 6; i++) { flushSync(); await Promise.resolve() }
  flushSync()
}

test('an outstanding change is checked once, though the check itself makes the notice busy', async () => {
  let view, calls = 0
  // As tracked-changes does: busy while asking, and pending answers come back.
  view = notice(async () => {
    calls++
    view.set({ busy: true })
    await Promise.resolve()
    view.set({ busy: false })
    return 'pending'
  })
  try {
    view.set({ hash: '0xaa' }); await settle()
    for (let i = 0; i < 5; i++) await settle()
    assert.equal(calls, 1, 'once, then the button asks')
    view.set({ busy: true }); await settle()
    view.set({ busy: false }); await settle()
    assert.equal(calls, 1, 'a later send or check does not start another')
    view.set({ hash: '0xbb' }); await settle()
    assert.equal(calls, 2, 'a different change is checked once too')
  } finally { view.stop() }
})

test('the check waits for a send still running, and a landed change is reported', async () => {
  let calls = 0
  const view = notice(async () => { calls++; return 'landed' })
  try {
    view.set({ hash: '0xcc', busy: true }); await settle()
    assert.equal(calls, 0, 'not while the send itself is running')
    view.set({ busy: false }); await settle()
    assert.equal(calls, 1)
    assert.equal(view.landed, 1)
  } finally { view.stop() }
})

test('a failed check is not retried on its own', async () => {
  let calls = 0
  const view = notice(async () => { calls++; throw new Error('host unavailable') })
  try {
    view.set({ hash: '0xdd' }); await settle()
    for (let i = 0; i < 5; i++) await settle()
    assert.equal(calls, 1)
  } finally { view.stop() }
})

// A reply card reads its body while the gate verdict is out and shows nothing until it lands.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactiveFixture } from '../../../../scripts/svelte-test.mjs'

const { card, flushSync } = await reactiveFixture(new URL('./fixtures/card-body.svelte.ts', import.meta.url))
async function settle() {
  for (let i = 0; i < 6; i++) { flushSync(); await Promise.resolve() }
  flushSync()
}

test('the body is read during the gate check and shown only once the reply may show', async () => {
  let reads = 0
  const view = card(async () => { reads++; return 'hello' })
  try {
    await settle()
    assert.equal(reads, 1, 'the read started before the verdict')
    assert.equal(view.value, null, 'nothing shows while the verdict is out')
    view.decide('shown'); await settle()
    assert.equal(view.value, 'hello')
    assert.equal(reads, 1, 'the verdict needs no second read')
  } finally { view.stop() }
})

test('a reply folded by its verdict shows neither its body nor a failed read, until revealed', async () => {
  for (const outcome of ['arrives', 'fails']) {
    let answer
    const view = card(() => new Promise((resolve, reject) => { answer = outcome === 'fails' ? () => reject(new Error('host unavailable')) : () => resolve('hello') }))
    try {
      await settle()
      view.decide('folded'); await settle()
      answer(); await settle()
      assert.equal(view.value, null, `${outcome}: a folded card shows no body`)
      assert.equal(view.failure, null, `${outcome}: nor a failed read`)
      view.reveal(); await settle()
      if (outcome === 'fails') assert.match(String(view.failure?.cause), /host unavailable/, 'revealed, the failure shows')
      else assert.equal(view.value, 'hello', 'revealed, the body shows')
    } finally { view.stop() }
  }
})

test('a body that failed or is not on the host yet can be asked for again', async () => {
  for (const outcome of ['missing', 'error', 'rejected']) {
    const answers = [outcome, 'hello']
    let reads = 0
    const view = card(async () => {
      reads++
      const next = answers.shift()
      if (next === 'rejected') throw new Error('host unavailable')
      return next
    }, 'shown')
    try {
      await settle()
      assert.equal(view.retryable, true, `${outcome}: offers to try again`)
      view.retry(); await settle()
      assert.equal(reads, 2, `${outcome}: a second read`)
      assert.equal(view.value, 'hello')
      assert.equal(view.failure, null)
      assert.equal(view.retryable, false)
    } finally { view.stop() }
  }
})

test('a body not on the host yet is asked for once more on its own, a few seconds later', async () => {
  const answers = ['missing', 'missing', 'hello']
  let reads = 0
  const view = card(async () => { reads++; return answers.shift() }, 'shown')
  try {
    await settle()
    assert.equal(view.value, 'missing')
    assert.equal(view.timers.length, 1)
    assert.ok(view.timers[0].ms >= 3_000, 'after the host stores a new post')
    view.timers[0].run(); await settle()
    assert.equal(reads, 2)
    assert.equal(view.timers.length, 0, 'once only; then it waits for a press')
    view.retry(); await settle()
    assert.equal(view.value, 'hello')
  } finally { view.stop() }
})

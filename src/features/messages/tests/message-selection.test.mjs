import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { address, load, install, mock, teardown } from '../../../../scripts/harness.mjs'

const { messageSelection } = await load('features/messages/message-selection.svelte.ts')
const { router } = await load('features/navigation/router.svelte.ts')
const { Visit } = await load('features/navigation/visits.ts')
beforeEach(install)
after(teardown)

function visit(t) {
  const previous = router.visit
  t.after(() => { router.visit = previous })
  router.visit = new Visit(1)
  return router.visit
}

test('only the latest submitted message is selected, within its chain and Board', t => {
  visit(t)
  const selection = messageSelection()
  selection.select(mock.chain, 7n)
  assert.equal(selection.has(mock.chain, 7n), true)
  assert.equal(selection.has({ ...mock.chain, id: mock.chain.id + 1 }, 7n), false)
  assert.equal(selection.has({ ...mock.chain, contract: address('55') }, 7n), false)
  selection.select(mock.chain, 8n)
  assert.equal(selection.has(mock.chain, 7n), false)
  assert.equal(selection.has(mock.chain, 8n), true)
})

test('a late confirmation belongs to the visit its composer captured', t => {
  const original = visit(t), selection = messageSelection()
  router.visit = new Visit(2)
  const next = messageSelection()
  next.select(mock.chain, 9n)
  selection.select(mock.chain, 7n)
  assert.equal(next.has(mock.chain, 7n), false)
  assert.equal(next.has(mock.chain, 9n), true)
  router.visit = original
  assert.equal(messageSelection().has(mock.chain, 7n), true)
})

test('returning visits copy the marker without sharing future selections', t => {
  const original = visit(t), selection = messageSelection()
  selection.select(mock.chain, 7n)
  router.visit = original.resume(2)
  const resumed = messageSelection()
  assert.equal(resumed.has(mock.chain, 7n), true)
  resumed.select(mock.chain, 8n)
  assert.equal(selection.has(mock.chain, 7n), true)
  assert.equal(selection.has(mock.chain, 8n), false)
  router.visit = new Visit(3)
  assert.equal(messageSelection().has(mock.chain, 8n), false)
})

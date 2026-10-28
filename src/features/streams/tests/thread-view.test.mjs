import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, feedPost, feedHistory } from '../../../../scripts/host-harness.mjs'
const { Visit } = await load('features/navigation/visits.ts')
const { router } = await load('features/navigation/router.svelte.ts')
const { threadView } = await load('features/streams/thread-view.ts')
const { readThread, replySlice } = await load('features/streams/replies.ts')
beforeEach(install)
after(teardown)

// Only immutable wire snapshots and post records may be shared between visits.
// Freeze those values so the test also rejects attempts to mutate them.
const shared = new WeakSet()
function freezeData(value) {
  if (!value || typeof value !== 'object' || shared.has(value)) return
  assert.ok(!(value instanceof Map) && !(value instanceof Set))
  shared.add(value)
  for (const child of Object.values(value)) freezeData(child)
  Object.freeze(value)
}
function mutableObjects(value, path = 'thread', found = new Map()) {
  if (!value || typeof value !== 'object' || shared.has(value) || found.has(value)) return found
  found.set(value, path)
  if (value instanceof Map) for (const [key, child] of value) {
    mutableObjects(key, `${path}.key`, found)
    mutableObjects(child, `${path}[${String(key)}]`, found)
  }
  else if (value instanceof Set) for (const child of value) mutableObjects(child, `${path}.member`, found)
  else for (const [key, child] of Object.entries(value)) mutableObjects(child, `${path}.${key}`, found)
  return found
}

test('resuming a thread visit shares no mutable state anywhere in its saved graph', async t => {
  const previous = router.visit
  t.after(() => { router.visit = previous })
  router.visit = new Visit(1)
  feedHistory([feedPost(1), feedPost(2, 1), ...Array.from({ length: 30 }, (_, i) => feedPost(i + 3, 2))])
  const original = threadView(mock.chain, 2n, new Map([[2n, { limit: 20, open: { 3: true }, retained: [32n] }]]))
  const first = await readThread(original.sessions, mock.chain, 2n)
  await replySlice(mock.chain, first.replies, 2n, 20, 32n)
  original.ancestors.push(first.parent)
  original.openAncestors['1'] = true
  for (const post of original.ancestors) freezeData(post)
  for (const session of original.sessions.values()) {
    freezeData(session.at)
    for (const record of session.records.values()) freezeData(record)
    for (const branch of session.branches.values()) freezeData(branch.next)
  }

  router.visit = router.visit.resume(2, null, true)
  const copy = threadView(mock.chain, 2n)
  const owned = mutableObjects(original)
  for (const [value, path] of mutableObjects(copy)) assert.ok(!owned.has(value), `${path} shares mutable state with ${owned.get(value)}`)
  assert.equal(copy.ancestors[0], original.ancestors[0], 'immutable records remain shared')
  mock.calls = []
  const reopened = await readThread(copy.sessions, mock.chain, 2n, undefined, true)
  assert.equal((await replySlice(mock.chain, reopened.replies, 2n, 20)).list.length, 21)
  assert.deepEqual(mock.calls, [], 'the isolated copy reuses every loaded page and pin')
})

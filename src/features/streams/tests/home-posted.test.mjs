import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { curate, load, install, teardown, mock, author } from '../../../../scripts/host-harness.mjs'
const { homePosted } = await load('features/streams/home-posted.ts')
const { router, href } = await load('features/navigation/router.svelte.ts')
const curated = { kind: 'timeline', curatedOnly: true, viewer: author }
const otherStreams = {
  everyone: { kind: 'timeline', viewer: author },
  following: { kind: 'following', authors: [author], viewer: author, includeRepliesToViewer: true },
  keyrings: [{ kind: 'following', authors: [], viewer: author, includeRepliesToViewer: false }],
}
beforeEach(() => {
  install()
  curate([])
})
after(teardown)
function view(t, filter = curated) {
  const v = { current: true, reloads: 0, destinations: [] }
  t.mock.method(router, 'go', to => v.destinations.push(to))
  v.posted = id => homePosted(mock.chain, filter, id, () => v.current, () => v.reloads++)
  return v
}

test('a non-curated author sees their new post in its thread', t => {
  const v = view(t)
  v.posted(7n)
  assert.deepEqual(v.destinations, [href.thread(mock.chain.id, 7n)])
  assert.equal(v.reloads, 0)
})

test('a curated author stays in curated and reloads it', t => {
  curate([author])
  const v = view(t)
  v.posted(7n)
  assert.deepEqual(v.destinations, [])
  assert.equal(v.reloads, 1)
})

test('everyone, following and keyring keep their existing post behavior without a membership read', t => {
  for (const filter of Object.values(otherStreams)) {
    const v = view(t, filter)
    v.posted(7n)
    assert.deepEqual(v.destinations, [])
    assert.equal(v.reloads, 1)
  }
  assert.equal(mock.calls.length, 0)
})

for (const [stream, filter] of Object.entries({ curated, ...otherStreams })) test(`a confirmation from ${stream} after changing the view does nothing`, t => {
  const v = view(t, filter)
  v.current = false
  v.posted(7n)
  assert.deepEqual(v.destinations, [])
  assert.equal(v.reloads, 0)
  assert.equal(mock.calls.length, 0)
})

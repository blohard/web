import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactiveFixture } from '../../../../scripts/svelte-test.mjs'

const { card, reader, flushSync } = await reactiveFixture(new URL('./fixtures/reply-fold.svelte.ts', import.meta.url))
const address = byte => '0x' + byte.repeat(20)
const chain = { id: 84532, contract: address('11') }
const post = { id: 2n, parentId: 1n, author: address('22'), parentAuthor: address('33'), contentHash: '0x' + 'aa'.repeat(32), blockNumber: 9n }
const parentAuthor = address('33')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function settle() {
  for (let i = 0; i < 6; i++) { flushSync(); await Promise.resolve() }
  flushSync()
}

for (const first of ['shown', 'folded']) {
  test(`${first} replies keep their verdict through paging, posting and local moderation`, async () => {
    let verdict = first, calls = 0
    reader(async () => { calls++; return verdict })
    const view = card(chain, post)
    let added
    try {
      await settle()
      assert.equal(view.verdict, first)
      verdict = first === 'shown' ? 'folded' : 'shown'
      for (const action of ['older posts', 'new post', 'more replies', 'local moderation']) {
        view.page(); await settle()
        assert.equal(view.verdict, first, action)
        assert.equal(calls, 1, `${action} must not trigger another check`)
      }
      added = card(chain, { ...post, id: 3n })
      await settle()
      assert.equal(added.verdict, verdict, 'newly displayed replies still check their rule')
      assert.equal(view.verdict, first, 'checking another reply must not change an existing card')
      assert.equal(calls, 2)
      const refreshed = Promise.resolve()
      view.refresh(refreshed); added.refresh(refreshed)
      await settle()
      assert.equal(view.verdict, verdict)
      assert.equal(calls, 4, 'explicit refresh rechecks both cards once')
    } finally { view.stop(); added?.stop() }
  })
}

test('explicit refresh waits for the page to update the ledger', async () => {
  let verdict = 'shown', calls = 0
  reader(async () => { calls++; return verdict })
  const view = card(chain, post)
  try {
    await settle()
    const page = deferred()
    view.refresh(page.promise)
    view.page(); await settle()
    assert.equal(calls, 1)
    assert.equal(view.verdict, 'shown', 'keep the visible result while the page loads')
    verdict = 'folded'; page.resolve()
    await settle()
    assert.equal(calls, 2)
    assert.equal(view.verdict, 'folded', 'the refreshed rule is read after the page completes')
    view.page(); await settle()
    assert.equal(calls, 2, 'rendering the refreshed records does not duplicate the check')
  } finally { view.stop() }
})

test('late checks cannot overwrite a newer refresh or a different reply', async () => {
  const old = deferred()
  let calls = 0
  reader(async () => ++calls === 1 ? old.promise : 'shown')
  const view = card(chain, post)
  try {
    await settle()
    view.refresh(Promise.resolve()); await settle()
    assert.equal(view.verdict, 'shown')
    old.resolve('folded'); await settle()
    assert.equal(view.verdict, 'shown')
    view.page({ ...post, id: 4n, author: address('44') }); await settle()
    assert.equal(calls, 3, 'a different reply needs its own verdict')
  } finally { view.stop() }
})

test('a failed page refresh keeps the visible verdict until another explicit refresh', async () => {
  let calls = 0
  reader(async () => { calls++; return 'folded' })
  const view = card(chain, post)
  try {
    await settle()
    assert.equal(view.verdict, 'folded')
    const failed = deferred()
    view.refresh(failed.promise); await settle()
    failed.reject(new Error('host unavailable')); await settle()
    assert.equal(view.verdict, 'folded')
    view.page(); await settle()
    assert.equal(calls, 1, 'incidental updates must not retry a failed refresh')
    view.refresh(Promise.resolve()); await settle()
    assert.equal(view.verdict, 'folded')
    assert.equal(calls, 2)
  } finally { view.stop() }
})

test('a first gate verdict keeps a reply pending instead of briefly showing it', async () => {
  const pending = deferred()
  reader(() => pending.promise)
  const view = card(chain, post)
  try {
    assert.equal(view.verdict, 'checking')
    await settle()
    assert.equal(view.verdict, 'checking')
    pending.resolve('folded')
    await settle()
    assert.equal(view.verdict, 'folded')
  } finally { view.stop() }
})

for (const first of ['shown', 'folded']) {
  test(`failed gate reads preserve ${first} until a successful refresh`, async () => {
    reader(async () => first)
    const view = card(chain, post)
    try {
      await settle()
      reader(async () => { throw new Error('holdings unavailable') })
      view.refresh(Promise.resolve()); await settle()
      assert.equal(view.verdict, first)
      reader(async () => 'shown')
      view.refresh(Promise.resolve()); await settle()
      assert.equal(view.verdict, 'shown')
    } finally { view.stop() }
  })
}
test('a failed first gate lookup shows the reply', async () => {
  reader(async () => { throw new Error('host unavailable') })
  const view = card(chain, post)
  try { await settle(); assert.equal(view.verdict, 'shown') }
  finally { view.stop() }
})


test('a reply uses its recorded parent author before earlier context is loaded', async () => {
  let calls = 0
  const pending = deferred()
  reader(async (_chain, msg, parent) => {
    calls++
    assert.equal(msg.id, post.id)
    assert.equal(parent, parentAuthor)
    return pending.promise
  })
  const view = card(chain, post)
  try {
    await settle()
    assert.equal(view.verdict, 'checking', 'check the reply even without its parent card')
    assert.equal(calls, 1)
    pending.resolve('shown'); await settle()
    assert.equal(view.verdict, 'shown')
    view.page({ ...post }); await settle()
    assert.equal(view.verdict, 'shown', 'loading earlier context keeps the visible verdict')
    assert.equal(calls, 1, 'context loading does not recheck an unchanged reply')
  } finally { view.stop() }
})

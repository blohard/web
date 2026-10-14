import assert from 'node:assert/strict'
import { test, beforeEach, after } from 'node:test'
import { load, install, teardown, mock, author, address, renderComponent, deferred } from '../../../../scripts/harness.mjs'
const { Resource } = await load('shared/resource.svelte.ts')
const { wallet } = await load('lib/wallet.svelte.ts')
const { DraftBox } = await load('features/publishing/draft-box.svelte.ts')
beforeEach(install)
after(teardown)

test('reply access reserves its separate row for restrictions and failures', async () => {
  const render = props => renderComponent('features/publishing/ReplyAccess.svelte', {
    chain: mock.chain, access: null, pending: false, failed: false, onretry: () => {}, ...props,
  })
  const checking = await render({ pending: true })
  assert.doesNotMatch(checking, /role="status"|checking reply access|try again/)

  const allowed = await render({})
  assert.doesNotMatch(allowed, /role="status"|checking reply access/)

  const restricted = await render({ pending: true, access: { kind: 'keys', creator: author } })
  assert.match(restricted, /you need a key/)
  assert.doesNotMatch(restricted, /checking reply access/)

  const failed = await render({ failed: true })
  assert.match(failed, /could not check the reply rule/)
  assert.match(failed, />try again<\/button>/)
  assert.doesNotMatch(failed, /checking reply access/)
})

test('known reply restrictions disable submission until a successful recheck clears them', async t => {
  const previousAccount = wallet.account
  wallet.account = author
  const owner = new DraftBox()
  owner.edit({ text: 'a reply draft', mentions: {}, attachments: [] })
  const identity = `${mock.chain.id}/${mock.chain.contract}/7/${author}`
  const read = new Resource()
  const value = Resource.prototype.value, failure = Resource.prototype.failure
  t.mock.method(Resource.prototype, 'value', function(key) { return key === identity ? value.call(read, key) : value.call(this, key) })
  t.mock.method(Resource.prototype, 'failure', function(key) { return key === identity ? failure.call(read, key) : failure.call(this, key) })
  t.after(() => { wallet.account = previousAccount })
  const render = () => renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, parentId: 7n, owner })
  const disabled = html => assert.match(html, /<button[^>]*post-action[^>]*disabled/)
  for (const kind of ['keys', 'blocked', 'closed', 'inactive']) {
    read.watch(Promise.resolve({ kind, creator: address('33') }), identity)
    await Promise.resolve()
    const html = await render()
    disabled(html)
    assert.doesNotMatch(html, /check again|try again/)
  }
  read.watch(Promise.resolve({ kind: 'keys', creator: address('33') }), identity)
  await Promise.resolve()
  const checking = deferred()
  const stop = read.watch(checking.promise, identity)
  disabled(await render())
  checking.reject(new Error('unavailable'))
  await Promise.resolve()
  let html = await render()
  disabled(html)
  assert.match(html, /you need a key/)
  assert.match(html, /could not check the reply rule/)
  assert.match(html, />try again<\/button>/)
  stop()
  read.watch(Promise.resolve(null), identity)
  await Promise.resolve()
  html = await render()
  assert.doesNotMatch(html, /<button[^>]*post-action[^>]*disabled/)
  assert.doesNotMatch(html, /you need a key|could not check the reply rule/)
  assert.equal(owner.draft.text, 'a reply draft')
})

test('a reply restriction does not disable top-level posts or another parent or wallet', async t => {
  const previousAccount = wallet.account
  wallet.account = author
  const owner = new DraftBox()
  owner.edit({ text: 'a draft', mentions: {}, attachments: [] })
  const value = Resource.prototype.value
  const identity = `${mock.chain.id}/${mock.chain.contract}/7/${author}`
  t.mock.method(Resource.prototype, 'value', function(key) { return key === identity ? { kind: 'keys', creator: address('33') } : value.call(this, key) })
  t.after(() => { wallet.account = previousAccount })
  for (const parentId of [0n, 8n]) {
    const html = await renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, parentId, owner })
    assert.doesNotMatch(html, /<button[^>]*post-action[^>]*disabled/)
  }
  wallet.account = address('44')
  const html = await renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, parentId: 7n, owner })
  assert.doesNotMatch(html, /<button[^>]*post-action[^>]*disabled/)
})

test('an advisory block warns without disabling Reply, but missing keys still disable it', async t => {
  const previousAccount = wallet.account
  wallet.account = author
  const owner = new DraftBox()
  owner.edit({ text: 'a reply draft', mentions: {}, attachments: [] })
  const value = Resource.prototype.value
  const identity = `${mock.chain.id}/${mock.chain.contract}/7/${author}`
  let access = { kind: null, creator: address('33'), blocked: true }
  t.mock.method(Resource.prototype, 'value', function(key) { return key === identity ? access : value.call(this, key) })
  t.after(() => { wallet.account = previousAccount })
  const render = () => renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, parentId: 7n, owner })
  let html = await render()
  assert.doesNotMatch(html, /<button[^>]*post-action[^>]*disabled/)
  assert.match(html, /your reply will be folded/)
  access = { ...access, kind: 'keys' }
  html = await render()
  assert.match(html, /<button[^>]*post-action[^>]*disabled/)
  assert.match(html, /you need a key/)
  assert.match(html, /buying a key will not remove the block/)
  assert.doesNotMatch(html, />buy a key<\/a>/)
})

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, mock, address, hash, renderComponent } from '../../../../scripts/harness.mjs'
const { gates } = await load('lib/gates.svelte.ts')
const { TOMBSTONE } = await load('lib/board.ts')
beforeEach(install)
after(teardown)

const msg = { id: 7n, parentId: 1n, author: address('22'), contentHash: hash('ab'), parentAuthor: address('33'), blockNumber: 9n, logIndex: 0 }

test('a deleted placeholder has its direct link but no reply count, expansion or spinner', async () => {
  gates.settleMessage(mock.chain, msg.id, TOMBSTONE, { block: 101n, index: 0 })
  for (const expanded of [false, true]) {
    const html = await renderComponent('features/messages/MessageCard.svelte', {
      chain: mock.chain, msg, replyCount: 2, expanded, repliesLoading: true, onexpand() {},
    })
    assert.match(html, /deleted by its author/)
    assert.match(html, /aria-label="open post #7"/)
    assert.doesNotMatch(html, /2 replies|hide replies|aria-expanded|class="spinner/)
  }
})

test('a reply under the reader\'s post offers remove from its own record, with no parent card drawn', async t => {
  const { Resource } = await load('shared/resource.svelte.ts')
  const { wallet } = await load('lib/wallet.svelte.ts')
  const value = Resource.prototype.value, previous = wallet.account
  const identity = `${mock.chain.id}/${mock.chain.contract}/${msg.id}/${msg.contentHash}`
  t.mock.method(Resource.prototype, 'value', function (key) { return key?.startsWith?.('removal/') ? { parentId: 0n, parentAuthor: address('00') } : key === identity ? { timestamp: 1, body: { kind: 'text', text: 'a reply' } } : value.call(this, key) })
  t.after(() => { wallet.account = previous })
  const remove = /<button[^>]*>(?:<[^>]*>)*\s*remove<\/button>/
  const render = () => renderComponent('features/messages/MessageCard.svelte', { chain: mock.chain, msg, linkToThread: false })
  wallet.account = msg.parentAuthor
  assert.match(await render(), remove, 'the parent\'s author may remove it')
  wallet.account = address('44')
  assert.doesNotMatch(await render(), remove, 'anyone else may not')
  wallet.account = msg.author
  const own = await render()
  assert.doesNotMatch(own, remove)
  assert.match(own, /delete<\/button>/, 'its own author deletes it instead')
})

test('a change that may still land shows on the card, with check and clear, and holds its other actions', async t => {
  const { Resource } = await load('shared/resource.svelte.ts')
  const { wallet } = await load('lib/wallet.svelte.ts')
  const { trackedTransaction } = await load('lib/tracked-transaction.svelte.ts')
  const value = Resource.prototype.value, previous = wallet.account
  const identity = `${mock.chain.id}/${mock.chain.contract}/${msg.id}/${msg.contentHash}`
  t.mock.method(Resource.prototype, 'value', function (key) { return key?.startsWith?.('removal/') ? { parentId: 0n, parentAuthor: address('00') } : key === identity ? { timestamp: 1, body: { kind: 'text', text: 'a reply' } } : value.call(this, key) })
  const change = trackedTransaction(`blohard.post-change/${mock.chain.id}/${mock.chain.contract.toLowerCase()}/${msg.id}`)
  t.after(() => { wallet.account = previous; change.finish(change.hash) })
  wallet.account = msg.parentAuthor
  change.save(hash('cd'))
  const html = await renderComponent('features/messages/MessageCard.svelte', { chain: mock.chain, msg, linkToThread: false })
  assert.match(html, /an earlier change to this post may still land/)
  assert.match(html, /<button[^>]*>check<\/button>/)
  assert.match(html, /<button[^>]*>clear<\/button>/)
  assert.match(html, /<button[^>]*disabled[^>]*>(?:<[^>]*>)*\s*remove<\/button>/, 'no second change while one may land')
})

test('the unsettled change notice shows only while one is out, inline or as its own paragraph', async () => {
  const props = { what: 'your account', busy: false, check: async () => 'pending', clear() {} }
  assert.doesNotMatch(await renderComponent('components/UnsettledChange.svelte', { ...props, hash: null }), /may still land/)
  const html = await renderComponent('components/UnsettledChange.svelte', { ...props, hash: hash('ef'), block: true })
  assert.match(html, /<p class="small">(?:<!--[^>]*-->)*an earlier change to your account may still land/)
  assert.match(html, /<button[^>]*>check<\/button>/)
  assert.match(html, /<button[^>]*>clear<\/button>/)
  assert.match(await renderComponent('components/UnsettledChange.svelte', { ...props, hash: hash('ef') }), /<span class="small">/)
})

test('the notice warns when tracking could not be saved, and waits while a send is running', async () => {
  const props = { what: 'your account', check: async () => 'pending', clear() {} }
  const unsaved = await renderComponent('components/UnsettledChange.svelte', { ...props, hash: hash('ef'), saved: false, busy: true })
  assert.match(unsaved, /transaction tracking could not be saved\. do not reload or close this tab until it confirms/)
  assert.doesNotMatch(unsaved, /may still land/, 'a send still running is not an earlier change')
  assert.doesNotMatch(await renderComponent('components/UnsettledChange.svelte', { ...props, hash: hash('ef') }), /could not be saved/)
})

/** Render a loaded card through the same body state its real reader supplies. */
async function loadedCard(t, post = { ...msg, parentId: 0n }) {
  const { Resource } = await load('shared/resource.svelte.ts')
  const { wallet } = await load('lib/wallet.svelte.ts')
  const value = Resource.prototype.value, previous = wallet.account
  const identity = `${mock.chain.id}/${mock.chain.contract}/${post.id}/${post.contentHash}`
  t.mock.method(Resource.prototype, 'value', function (key) {
    return key?.startsWith?.('removal/') ? { parentId: 0n, parentAuthor: address('00') } : key === identity ? { timestamp: 1, body: { kind: 'text', text: 'a post' } } : value.call(this, key)
  })
  wallet.account = post.author
  t.after(() => { wallet.account = previous })
  return {
    wallet,
    render: async (props = {}) => (await renderComponent('features/messages/MessageCard.svelte', {
      chain: mock.chain, msg: post, linkToThread: false, replyCount: 2, ...props,
    })).replace(/<!--[^]*?-->/g, ''),
  }
}

test('card actions keep their order and offer rule editing on the author\'s own thread', async t => {
  const { zeroAddress } = await import('viem')
  gates.settleMessage(mock.chain, msg.id, zeroAddress, { block: 101n, index: 0 })
  const { wallet, render } = await loadedCard(t)
  const html = await render()
  const controls = ['↳ reply', '↱ quote', '2 replies', 'delete</button>', 'reply rule']
  const positions = controls.map(text => html.indexOf(text))
  assert.ok(positions.every(n => n >= 0), 'all controls are shown')
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
  assert.doesNotMatch(await render({ linkToThread: true }), /reply rule/, 'stream cards have no rule editor')
  wallet.account = address('44')
  assert.doesNotMatch(await render(), /delete<\/button>|reply rule/, 'only the author can edit the post')
  wallet.account = null
  const anonymous = await render()
  assert.match(anonymous, /↳ reply/)
  assert.match(anonymous, /↱ quote/)
  assert.doesNotMatch(anonymous, /delete<\/button>|reply rule/)
})

test('a closed post keeps its reply count and author controls without reply or quote', async t => {
  mock.chain.closed_gate = address('ee')
  gates.settleMessage(mock.chain, msg.id, mock.chain.closed_gate, { block: 101n, index: 0 })
  const { render } = await loadedCard(t)
  const html = await render()
  assert.doesNotMatch(html, /↳ reply|↱ quote/)
  assert.match(html, /2 replies/)
  assert.match(html, /delete<\/button>/)
  assert.match(html, /reply rule/)
})

test('an embedded card links replies to the app and exposes no wallet actions or recovery controls', async t => {
  const { router } = await load('features/navigation/router.svelte.ts')
  const { trackedTransaction } = await load('lib/tracked-transaction.svelte.ts')
  const previous = router.embed
  router.embed = true
  const change = trackedTransaction(`blohard.post-change/${mock.chain.id}/${mock.chain.contract.toLowerCase()}/${msg.id}`)
  change.save(hash('bc'))
  t.after(() => { router.embed = previous; change.finish(change.hash) })
  const { render } = await loadedCard(t)
  const html = await render()
  assert.match(html, /<a class="act(?: [^"]*)?" href="[^"]+">↳ reply<\/a>/)
  assert.match(html, /2 replies/)
  assert.doesNotMatch(html, /↱ quote|delete<\/button>|remove<\/button>|reply rule|may still land/)
})

test('recovery controls remain available while a card is waiting for its body', async t => {
  const { trackedTransaction } = await load('lib/tracked-transaction.svelte.ts')
  const change = trackedTransaction(`blohard.post-change/${mock.chain.id}/${mock.chain.contract.toLowerCase()}/${msg.id}`)
  change.save(hash('bc'))
  t.after(() => change.finish(change.hash))
  const html = await renderComponent('features/messages/MessageCard.svelte', { chain: mock.chain, msg: { ...msg, parentId: 0n } })
  assert.match(html, /an earlier change to this post may still land/)
  assert.doesNotMatch(html, /↳ reply|↱ quote|delete<\/button>/)
})


test('separator and reply stub are independent on both full and collapsed cards', async t => {
  const { render } = await loadedCard(t)
  const separate = await render({ continuesAbove: true })
  assert.match(separate, /class="line up(?: |")/)
  assert.doesNotMatch(separate, /no-separator/)
  assert.match(await render({ separator: false }), /<article[^>]*no-separator/)
  gates.settleMessage(mock.chain, msg.id, TOMBSTONE, { block: 101n, index: 0 })
  assert.match(await render({ separator: false }), /<article[^>]*collapsed[^>]*no-separator/)
})

test('removal waits for protection to be known, and never offers a protected response', async t => {
  const { Resource } = await load('shared/resource.svelte.ts')
  const { wallet } = await load('lib/wallet.svelte.ts')
  const original = Resource.prototype.value, previous = wallet.account
  const identity = `${mock.chain.id}/${mock.chain.contract}/${msg.id}/${msg.contentHash}`
  let parent = null
  t.mock.method(Resource.prototype, 'value', function (key) {
    if (key?.startsWith?.('removal/')) return parent
    return key === identity ? { timestamp: 1, body: { kind: 'text', text: 'a response' } } : original.call(this, key)
  })
  wallet.account = msg.parentAuthor
  t.after(() => { wallet.account = previous })
  const render = () => renderComponent('features/messages/MessageCard.svelte', { chain: mock.chain, msg, linkToThread: false })
  assert.doesNotMatch(await render(), /remove<\/button>/, 'a missing parent is not permission')
  parent = { parentId: 2n, parentAuthor: msg.author }
  assert.doesNotMatch(await render(), /remove<\/button>/, 'the immediate parent answers this author')
  parent = { parentId: 2n, parentAuthor: address('44') }
  assert.match(await render(), /remove<\/button>/, 'an unrelated reply remains removable')
})

test('a closed reply offers a response only to the entitled wallet, while deletion wins', async t => {
  mock.chain.closed_gate = address('ee')
  gates.settleMessage(mock.chain, msg.id, mock.chain.closed_gate, { block: 101n, index: 0 })
  const { wallet, render } = await loadedCard(t, msg)
  assert.doesNotMatch(await render(), /↳ reply/)
  wallet.account = msg.parentAuthor
  const entitled = await render()
  assert.match(entitled, /↳ reply/)
  assert.doesNotMatch(entitled, /↱ quote/)
  wallet.account = null
  assert.doesNotMatch(await render(), /↳ reply/)
  wallet.account = msg.parentAuthor
  gates.settleMessage(mock.chain, msg.id, TOMBSTONE, { block: 102n, index: 0 })
  assert.doesNotMatch(await render(), /↳ reply|reply rule|hide replies/)
})

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, mock, author, feedPost, feedHistory, renderComponent } from '../../../../scripts/host-harness.mjs'

const { Resource } = await load('shared/resource.svelte.ts')
const { readMessage } = await load('lib/messages.ts')
const { readRoot, replySlice } = await load('features/streams/replies.ts')
const { RowExpansion, expansionOf } = await load('features/streams/stream-expansion.ts')
const { replying } = await load('features/publishing/replying.svelte.ts')
const sessions = new Map()
beforeEach(() => { sessions.clear(); install() })
after(teardown)

const post = (id, parent = 0) => feedPost(id, parent, author, author)
const preview = (post, drawn = 0, joins = false, gap = false) => ({ post, drawn, joins, gap })
const articles = html => [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].map(m => m[0])
const idOf = html => Number(html.match(/aria-label="open post #(\d+)"/)[1])
const ids = html => articles(html).map(idOf)
const card = (html, id) => {
  const found = articles(html).find(article => idOf(article) === id)
  assert.ok(found, `post #${id} is rendered`)
  return found
}
const separators = html => articles(html).map(article => [idOf(article), !article.slice(0, article.indexOf('>')).includes('no-separator')])

/** Render the real components at explicit read states. SSR runs no effects;
 * keyed Resource answers supply bodies, verdicts and slices, restored by Node.
 * The HTTP fixture still handles any reads; no component source is replaced. */
async function fixture(t, posts) {
  mock.blocked = false
  feedHistory(posts)
  const records = await Promise.all(posts.map(p => readMessage(mock.chain, p.id)))
  const prefix = `${mock.chain.id}/${mock.chain.contract}`
  const values = new Map(), errors = new Map()
  for (const { record: p } of records) {
    const identity = `${prefix}/${p.id}/${p.contentHash}`
    values.set(identity, { timestamp: p.timestamp, body: { kind: 'text', text: `post ${p.id}` } })
    values.set(`${identity}/${p.parentId}/${p.author}/${p.blockNumber}/${p.parentAuthor}/true`, 'shown')
  }
  const value = Resource.prototype.value, failure = Resource.prototype.failure
  t.mock.method(Resource.prototype, 'value', function(key) { return values.has(key) ? values.get(key) : value.call(this, key) })
  t.mock.method(Resource.prototype, 'failure', function(key) { return errors.has(key) ? { key, cause: errors.get(key) } : failure.call(this, key) })
  const rowx = new RowExpansion(expansionOf(`render-${mock.chain.id}`), posts[0].id)
  const render = async (name, props) => (await renderComponent(`features/streams/${name}.svelte`, { chain: mock.chain, ...props })).replace(/<!--[^]*?-->/g, '')
  return {
    prefix, values, errors, rowx, render,
    row: (row, counts = []) => render('ConversationRow', { row, page: { counts: new Map(counts) }, rowx }),
  }
}

for (const failed of [false, true]) for (const firstParent of [1, 3]) {
  test(`preview links, counts and separators survive a ${failed ? 'failed' : 'pending'} parent read, first answering #${firstParent}`, async t => {
    const root = post(1), first = post(4, firstParent), middle = post(5, 4), last = post(6, 4)
    const view = await fixture(t, [root, post(3), first, middle, last])
    if (failed) view.errors.set(1n, new Error('offline'))
    const html = await view.row({ root: { id: 1n, drawn: 0, joins: false },
      cards: [preview(first, 2, true, firstParent !== 1), preview(middle), preview(last)] }, [[4n, 5], [5n, 0], [6n, 1]])
    assert.deepEqual(ids(html), [4, 5, 6])
    assert.match(card(html, 4), /3 more replies<\/button>/)
    assert.match(card(html, 6), /1 reply<\/button>/)
    assert.match(card(html, 4), /<article[^>]*\bconnector\b/)
    assert.equal(separators(html)[0][1], false, 'the label or loading placeholder owns the separator')
    const label = new RegExp(`href="/p/${mock.chain.id}/${firstParent}">in reply to (?:<span[^>]*>[^<]*</span> )?#${firstParent}`)
    if (failed || firstParent !== 1) assert.match(html, label)
    else assert.doesNotMatch(html, /in reply to (?:<span[^>]*>[^<]*<\/span> )?#1/, 'the loading placeholder already names the parent')
    assert.doesNotMatch(html, /in reply to (?:<span[^>]*>[^<]*<\/span> )?#4/, 'the siblings already show their parent')
    assert.equal(html.includes('loading #1'), !failed)
  })
}

test('hiding the preview removes the parent connector and restores its full count', async t => {
  const root = post(1), reply = post(2, 1)
  const view = await fixture(t, [root, reply])
  const draw = () => view.row({ root: { id: 1n, post: root, drawn: 1, joins: true }, cards: [preview(reply)] }, [[1n, 3], [2n, 0]])
  const shown = await draw()
  assert.deepEqual(ids(shown), [1, 2])
  assert.match(card(shown, 1), /<article[^>]*\bconnector\b/)
  assert.match(card(shown, 1), /2 more replies<\/button>/)
  assert.match(card(shown, 1), /hide replies<\/button>/)
  view.rowx.hide(1n)
  const hidden = await draw()
  assert.deepEqual(ids(hidden), [1])
  assert.doesNotMatch(card(hidden, 1), /\bconnector\b|hide replies|more replies/)
  assert.match(card(hidden, 1), /3 replies<\/button>/)
})

for (const failed of [false, true]) test(`a hidden preview stays hidden while its parent read is ${failed ? 'failed' : 'pending'}`, async t => {
  const root = post(1), reply = post(2, 1)
  const view = await fixture(t, [root, reply])
  if (failed) view.errors.set(1n, new Error('offline'))
  const draw = () => view.row({ root: { id: 1n, drawn: 1, joins: true }, cards: [preview(reply)] })
  view.rowx.hide(1n)
  assert.deepEqual(ids(await draw()), [])
  view.rowx.press(1n)
  assert.deepEqual(ids(await draw()), [], 'restoring the branch also waits for the parent')
})

for (const failed of [false, true]) test(`a restored open branch does not resurrect its preview while ${failed ? 'failed' : 'pending'}`, async t => {
  const root = post(1), reply = post(2, 1)
  const view = await fixture(t, [root, reply])
  if (failed) view.errors.set(`${view.prefix}/1`, new Error('offline'))
  const draw = () => view.row({ root: { id: 1n, post: root, drawn: 1, joins: true }, cards: [preview(reply)] }, [[1n, 3], [2n, 0]])
  view.rowx.press(1n)
  const opening = await draw()
  assert.deepEqual(ids(opening), [1], 'restoring an open branch waits for its list')
  assert.match(card(opening, 1), /aria-expanded="true"[^>]*>hide replies/)
  assert.equal(opening.includes('offline'), failed)
  view.rowx.press(1n)
  assert.deepEqual(ids(await draw()), [1])
})

test('an omitted parent has one context link without reply controls', async t => {
  const root = post(1), replies = [5, 6, 7].map(id => post(id, 1))
  const view = await fixture(t, [root, ...replies])
  const draw = () => view.row({ root: { id: 1n, omitted: true, drawn: 3, joins: false }, cards: replies.map(p => preview(p)) }, [[1n, 6], [5n, 0], [6n, 0], [7n, 0]])
  const previewed = await draw()
  assert.equal((previewed.match(/in reply to (?:<span[^>]*>[^<]*<\/span> )?#1/g) ?? []).length, 1)
  assert.match(previewed, new RegExp(`href="/p/${mock.chain.id}/1">in reply to (?:<span[^>]*>[^<]*</span> )?#1`))
  assert.deepEqual(ids(previewed), [5, 6, 7])
  assert.doesNotMatch(previewed, /class="[^"]*reply-count/)
  assert.doesNotMatch(previewed, /loading #1/)
  assert.equal(separators(previewed)[0][1], false)
})

test('an omitted grouping ancestor has no header above a reply to a different parent', async t => {
  const root = post(376), parent = post(379, 376), reply = post(380, 379)
  const view = await fixture(t, [root, parent, reply])
  const html = await view.row({ root: { id: 376n, omitted: true, drawn: 0, joins: false },
    cards: [preview(reply, 0, false, true)] }, [[376n, 1], [380n, 0]])
  assert.deepEqual(ids(html), [380])
  assert.match(html, new RegExp(`href="/p/${mock.chain.id}/379">in reply to (?:<span[^>]*>[^<]*</span> )?#379`))
  assert.doesNotMatch(html, /in reply to (?:<span[^>]*>[^<]*<\/span> )?#376/)
  assert.doesNotMatch(html, /1 reply<\/button>/)
})

test('preview separators follow direct joins; siblings and an editor interrupt them', async t => {
  const root = post(1), reply = post(2, 1), child = post(4, 2), sibling = post(3, 1)
  const view = await fixture(t, [root, reply, child, sibling])
  const draw = async () => separators(await view.row({ root: { id: 1n, post: root, drawn: 2, joins: true },
    cards: [preview(reply, 1, true), preview(child), preview(sibling)] }))
  assert.deepEqual(await draw(), [[1, true], [2, false], [4, false], [3, true]])
  const box = replying.box()
  t.after(() => box.detach())
  box.open(mock.chain.id, 2n)
  assert.deepEqual(await draw(), [[1, true], [2, false], [4, true], [3, true]])
  box.open(mock.chain.id, 1n)
  assert.deepEqual(await draw(), [[1, true], [2, true], [4, false], [3, true]])
  box.detach()
  assert.deepEqual(await draw(), [[1, true], [2, false], [4, false], [3, true]])
})

test('context labels own the separator for a root reply and an omitted parent', async t => {
  const root = post(9, 8), reply = post(10, 9)
  const view = await fixture(t, [root, reply, post(8)])
  const row = { root: { id: 9n, post: root, drawn: 1, joins: true }, cards: [preview(reply)] }
  const html = await view.row(row)
  assert.match(html, new RegExp(`href="/p/${mock.chain.id}/8">in reply to (?:<span[^>]*>[^<]*</span> )?#8`))
  assert.deepEqual(separators(html), [[9, false], [10, false]])
  row.root = { id: 9n, omitted: true, drawn: 1, joins: false }
  assert.deepEqual(separators(await view.row(row)), [[10, false]])
})

test('nested lists join only the first card, until an editor interrupts that join', async t => {
  const view = await fixture(t, [post(1), post(2, 1), post(3, 1), post(4, 2)])
  const root = await readRoot(sessions, mock.chain, 1n)
  const first = await replySlice(mock.chain, root.replies, 1n, 20)
  view.values.set(`${view.prefix}/1`, first)
  view.values.set(`${view.prefix}/2`, await replySlice(mock.chain, first.children, 2n, 20))
  const props = { parentId: 1n, data: root.replies, separator: false, views: new Map([[1n, { limit: 20, open: { 2: true } }]]) }
  const draw = async () => separators(await view.render('Replies', props))
  assert.deepEqual(await draw(), [[2, false], [4, false], [3, true]])
  const box = replying.box()
  t.after(() => box.detach())
  box.open(mock.chain.id, 2n)
  assert.deepEqual(await draw(), [[2, false], [4, true], [3, true]])
  box.detach()
  props.separator = true
  assert.deepEqual(await draw(), [[2, true], [4, false], [3, true]])
})

test('a paging gap gives the first displayed reply its own separator', async t => {
  const view = await fixture(t, [post(1), ...Array.from({ length: 23 }, (_, i) => post(i + 2, 1))])
  const root = await readRoot(sessions, mock.chain, 1n)
  const slice = await replySlice(mock.chain, root.replies, 1n, 0, 24n)
  assert.equal(slice.tailStart, 24n)
  view.values.set(`${view.prefix}/1`, slice)
  const html = await view.render('Replies', { parentId: 1n, data: root.replies, separator: false, reveal: 24n,
    views: new Map([[1n, { limit: 0, open: {} }]]) })
  assert.deepEqual(ids(html), [24], 'the gap must precede the first card, not an already separated sibling')
  assert.match(html, /your new reply is below/)
  assert.deepEqual(separators(html), [[24, true]])
})


for (const omitted of [2, 24]) test(`an ancestor's reply list omits focused child #${omitted} and pages only the remaining replies`, async t => {
  const view = await fixture(t, [post(1), ...Array.from({ length: 23 }, (_, i) => post(i + 2, 1))])
  const root = await readRoot(sessions, mock.chain, 1n)
  const first = await replySlice(mock.chain, root.replies, 1n, 20)
  view.values.set(`${view.prefix}/1`, first)
  const props = { parentId: 1n, data: root.replies, separator: false, omit: BigInt(omitted) }
  const html = await view.render('Replies', props)
  assert.deepEqual(ids(html), Array.from({ length: 20 }, (_, i) => i + 2).filter(id => id !== omitted))
  assert.match(html, new RegExp(`show ${omitted === 2 ? 3 : 2} more replies`))
  assert.equal(separators(html)[0][1], false, 'the first remaining child joins the ancestor')
  view.values.set(`${view.prefix}/1`, await replySlice(mock.chain, root.replies, 1n, 40))
  const complete = await view.render('Replies', props)
  assert.deepEqual(ids(complete), Array.from({ length: 23 }, (_, i) => i + 2).filter(id => id !== omitted))
  assert.doesNotMatch(complete, /show (?:\d+ )?more replies/)
})


test('a preview card offers its full reply count when its reply is farther down the row', async t => {
  const root = post(1), first = post(2, 1), sibling = post(3, 1), child = post(4, 2)
  const view = await fixture(t, [root, first, sibling, child])
  const html = await view.row({ root: { id: 1n, post: root, drawn: 2, joins: true },
    cards: [preview(first, 1), preview(sibling), preview(child, 0, false, true)] }, [[1n, 2], [2n, 1], [3n, 0], [4n, 0]])
  assert.match(card(html, 2), /1 reply<\/button>/)
  assert.doesNotMatch(card(html, 2), /hide replies|more repl/)
  assert.match(card(html, 1), /hide replies<\/button>/, 'the root does start a visible reply group')
})

test('a root offers its full count when context separates it from its direct replies', async t => {
  const root = post(1), missing = post(2, 1), nested = post(4, 2), direct = post(5, 1)
  const view = await fixture(t, [root, missing, nested, direct])
  const html = await view.row({ root: { id: 1n, post: root, drawn: 1, joins: false },
    cards: [preview(nested, 0, false, true), preview(direct, 0, false, true)] }, [[1n, 2], [4n, 0], [5n, 0]])
  assert.match(card(html, 1), /2 replies<\/button>/)
  assert.doesNotMatch(card(html, 1), /hide replies|more repl/)
  assert.deepEqual(ids(html), [1, 4, 5], 'the control change does not hide existing cards')
})

test('context names identify the parent for root replies, omitted parents and gaps', async t => {
  const parentAuthor = `0x${'98'.repeat(20)}`
  const parent = feedPost(1, 0, parentAuthor)
  const reply = feedPost(2, 1, author, parentAuthor)
  const view = await fixture(t, [parent, reply])
  const expected = new RegExp(`href="/p/${mock.chain.id}/1">in reply to <span[^>]*title="${parentAuthor}"[^>]*>[^<]+</span> #1`)
  for (const row of [
    { root: { id: 2n, post: reply, drawn: 0, joins: false }, cards: [] },
    { root: { id: 1n, omitted: true, drawn: 1, joins: false }, cards: [preview(reply)] },
    { root: { id: 99n, omitted: true, drawn: 0, joins: false }, cards: [preview(reply, 0, false, true)] },
  ]) assert.match(await view.row(row), expected)
})

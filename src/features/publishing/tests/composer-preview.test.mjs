import assert from 'node:assert/strict'
import { test, beforeEach, after } from 'node:test'
import { install, load, renderComponent, teardown, mock, author } from '../../../../scripts/harness.mjs'
const { encode } = await load('lib/envelope.ts')
const { hashOf } = await load('lib/store.ts')
const { host } = await load('lib/host.svelte.ts')
const { wallet } = await load('lib/wallet.svelte.ts')
const { DraftBox } = await load('features/publishing/draft-box.svelte.ts')
const { blockPreviewNavigation } = await load('features/publishing/composer-preview.ts')
const { modal } = await load('shared/modal.ts')
beforeEach(install)
after(teardown)

test('composer preview renders the actual grammar, local images and reply context without sending anything', async () => {
  const bytes = encode('image/png', new Uint8Array([1,2,3]))
  const record = { hash: hashOf(bytes), bytes, name: 'picture', kind: 'attachment', status: 'pending', mediaType: 'image/png' }
  const text = '*bold* _italic_ *_both_* <script>literal</script> https://example.org/\n![picture](record:' + record.hash + ')'
  const html = await renderComponent('features/publishing/ComposerPreview.svelte', { chain: mock.chain, author, text, records: [record], parentId: 7n, onclose() {} })
  assert.match(html, /<dialog/)
  assert.match(html, /reply preview/)
  assert.match(html, /in reply to #7/)
  assert.match(html, /class="[^\"]*bold/)
  assert.match(html.replace(/<!--.*?-->/gs, ''), /class="[^"]*\bbold\b[^"]*\bitalic\b[^"]*"[^>]*>both<\/span>/)
  assert.match(html, /&lt;script>literal&lt;\/script>/)
  assert.match(html, /href="https:\/\/example.org\//)
  assert.match(html, /<img alt="picture"/)
  assert.match(html, /--preview-lines: 12/)
  assert.doesNotMatch(html, /data-message="0"|loading picture|onclick="/)
  assert.equal(mock.calls.length, 0, 'rendering never uploads or sends a transaction')
})

test('only referenced draft images render and the normal shared preview budget still applies', async t => {
  const previous = host.status
  t.after(() => { host.status = previous })
  host.status = { store: { attachments: { max_per_message: 1 } } }
  const make = n => { const bytes = encode('image/png', new Uint8Array([n])); return { hash: hashOf(bytes), bytes, name: 'picture', mediaType: 'image/png' } }
  const records = [make(1), make(2), make(3)]
  const text = records.slice(0,2).map(r => `![picture](record:${r.hash})`).join('\n')
  const html = await renderComponent('features/publishing/ComposerPreview.svelte', { chain: mock.chain, author, text, records, parentId: 0n, onclose() {} })
  assert.equal((html.match(/<img alt="picture"/g) ?? []).length, 1)
  assert.ok(!html.includes(records[2].hash))
})

test('preview is available for a draft even when sponsorship or the body cap prevents posting', async t => {
  const previous = wallet.account
  t.after(() => { wallet.account = previous })
  wallet.account = author
  const owner = new DraftBox()
  const empty = await renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, owner })
  assert.match(empty, /<button[^>]*preview-post[^>]*aria-label="preview"[^>]*disabled/)
  owner.edit({ text: 'a draft', mentions: {}, attachments: [] })
  const html = await renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, owner })
  assert.match(html, /<button[^>]*preview-post[^>]*aria-label="preview"/)
  assert.doesNotMatch(html, /<button[^>]*preview-post[^>]*disabled/)
  assert.equal(owner.draft.text, 'a draft')
  wallet.account = null
  const disconnected = await renderComponent('features/publishing/Composer.svelte', { chain: mock.chain, owner })
  assert.match(disconnected, /<button[^>]*preview-post[^>]*disabled/, 'preview cannot wait invisibly for a wallet')
})

test('preview navigation is stopped before router handlers but expansion buttons stay usable', t => {
  const previous = globalThis.Element
  class Element { constructor(target) { this.target = target } closest() { return this.target } }
  globalThis.Element = Element
  t.after(() => { if (previous) globalThis.Element = previous; else delete globalThis.Element })
  for (const type of ['click', 'auxclick', 'contextmenu']) {
    const event = { type, target: new Element({}), prevented: false, stopped: false,
      preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
    blockPreviewNavigation(event)
    assert.ok(event.prevented && event.stopped)
    event.target = new Element(null); event.prevented = event.stopped = false
    blockPreviewNavigation(event)
    assert.ok(!event.prevented && !event.stopped)
  }
})

test('modal teardown clears the open request and restores background scrolling and focus', t => {
  const previousDoc = globalThis.document, previousElement = globalThis.HTMLElement
  let focus = 0, opened = 0, closed = 0
  class Element { isConnected = true; focus(options) { assert.equal(options.preventScroll, true); focus++ } }
  globalThis.HTMLElement = Element
  globalThis.document = { documentElement: { style: { overflow: 'auto' } }, activeElement: new Element() }
  t.after(() => { globalThis.document = previousDoc; globalThis.HTMLElement = previousElement })
  const dialog = { showModal() { opened++ }, close() { closed++ } }
  let requested = true
  const action = modal(dialog, () => { requested = false })
  assert.equal(opened, 1)
  assert.equal(document.documentElement.style.overflow, 'hidden')
  action.destroy()
  assert.equal(closed, 1)
  assert.equal(requested, false, 'wallet reconnection cannot reopen a torn-down modal')
  assert.equal(document.documentElement.style.overflow, 'auto')
  assert.equal(focus, 1)
})

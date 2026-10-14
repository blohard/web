import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { install, load, renderComponent, teardown, mock, author, hash } from '../../../../scripts/harness.mjs'
const { host } = await load('lib/host.svelte.ts')
const { Resource } = await load('shared/resource.svelte.ts')
beforeEach(install)
after(teardown)
const reference = id => `post://999/${id}?commit=${hash('ab')}`

for (const view of ['stream', 'thread', 'draft']) for (const native of [false, true]) {
  const draft = view === 'draft'
  const url = native ? 'https://blohard.social/keys/84532/about' : 'https://example.org/'
  const marker = 'aria-label="link preview"'
  test(`${view} ${native ? "same-site" : "external"} cards yield to explicit quotes while preserving text order and independent clipping`, async t => {
    const previous = host.status, value = Resource.prototype.value
    host.status = { chains: [], gateway: { link_previews: true }, store: { attachments: { max_per_message: 4 } } }
    t.after(() => { host.status = previous })
    const msg = { id: 164n, parentId: 0n, author, contentHash: hash('cd'), blockNumber: 1n, logIndex: 0 }
    const identity = `${mock.chain.id}/${mock.chain.contract}/${msg.id}/${msg.contentHash}`
    let text = `introduction ${url}\n${reference(162)}\nbetween quotes\n${reference(163)}`
    let metadata = { title: 'Link title', description: 'Link description', image: null }
    t.mock.method(Resource.prototype, 'value', function (key) {
      if (key === identity) return { timestamp: 1, body: { kind: 'text', text } }
      if (key === url) return metadata
      return value.call(this, key)
    })
    const render = () => draft
      ? renderComponent('features/publishing/ComposerPreview.svelte', { chain: mock.chain, author, text, records: [], parentId: 0n, onclose() {} })
      : renderComponent('features/messages/MessageCard.svelte', { chain: mock.chain, msg, linkToThread: view === 'stream' })
    let html = await render()
    const markers = ['introduction', 'quotes post #162', 'between quotes', 'quotes post #163']
    const positions = markers.map(m => html.indexOf(m))
    assert.ok(positions.every(n => n >= 0), 'all text and both explicit quote placeholders render')
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'text and explicit quotes retain their source order')
    assert.ok(!html.includes(marker), 'an explicit quote suppresses the automatic link card')
    // Inspect the rendered nesting: a long introduction must not clip the embed.
    const checkClipping = () => {
      const parents = []
      for (const tag of html.matchAll(/<\/?(?:div|aside)\b[^>]*>/g)) {
        if (tag[0].startsWith('</div')) parents.pop()
        else if (tag[0].startsWith('<div')) {
          if (/class="quote(?: |")/.test(tag[0])) {
            assert.ok(!parents.some(p => /class="preview(?: |")/.test(p)), 'quotes keep their own preview limit, outside the surrounding text preview')
          }
          parents.push(tag[0])
        }
        else if (tag[0].includes('aria-label="link preview"')) {
          assert.ok(!parents.some(p => /class="preview(?: |")/.test(p)), 'embed stays outside collapsed previews')
        }
      }
    }
    checkClipping()
    text = `introduction ${url} without a quote`
    html = await render()
    assert.equal(html.split(marker).length - 1, 1)
    assert.ok(html.indexOf('without a quote') < html.indexOf(marker), 'no quote: embed follows the text')
    checkClipping()
    metadata = null
    html = await render()
    assert.ok(!html.includes(marker), 'unavailable metadata leaves no empty embed')
    assert.ok(html.includes(`href="${url}"`), 'the original body link remains usable')
    metadata = { title: 'Link title', description: 'Link description', image: null }
    text = [reference(1), reference(2), reference(3), reference(4), url].join('\n')
    html = await render()
    assert.ok(!html.includes(marker), 'quotes still take priority in the preview budget')
  })
}

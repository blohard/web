import assert from 'node:assert/strict'
import { test, after, beforeEach } from 'node:test'
import { install, load, renderComponent, teardown, deferred } from '../../../../scripts/harness.mjs'
const { previewLink: selectLink, previewPost, hostPreviewLink, checkedPreview, LinkPreviews, PreviewQueueFull } = await load('features/messages/link-preview.ts')
const { pageHead, siteMetadata } = await load('features/messages/site-preview.ts')
const { host } = await load('lib/host.svelte.ts')
const { Resource } = await load('shared/resource.svelte.ts')
const { follows } = await load('lib/follows.svelte.ts')
const { wallet } = await load('lib/wallet.svelte.ts')
beforeEach(install)
after(teardown)
const previewLink = (...args) => selectLink(...args)?.url ?? null
const link = url => ({ url, source: url })
const post = { chain: 84532, id: 123n }
const author = '0x' + '12'.repeat(20)
const answer = { title: '<b>title</b>', description: 'description', image: 'https://images.example/image.jpg' }

test('one external link uses the existing preview budget without displacing pictures or quotes', () => {
  const image = n => `![image](record:0x${String(n).padStart(64, '0')})`
  assert.equal(previewLink('https://client.invalid/p/1/2 https://example.org/a https://example.net/b'), 'https://example.org/a')
  assert.equal(previewLink(`${[1,2,3,4].map(image).join('\n')} https://example.org/`), null)
  assert.equal(previewLink(`${[1,2,3].map(image).join('\n')} https://example.org/`), 'https://example.org/')
  assert.equal(previewLink('https://example.org/', 0), null)
  assert.equal(previewLink(`${image(1)} https://example.org/`, 1), null)
  assert.equal(previewLink(`${image(1)} https://example.org/`, 2), 'https://example.org/')
  assert.deepEqual(selectLink('visit *example.org/café#intro*'), { url: 'https://example.org/caf%C3%A9#intro', source: 'example.org/café#intro' })
  assert.equal(previewLink('https://example.org/', NaN), 'https://example.org/')
  assert.equal(previewLink('javascript:alert(1) https://name:secret@example.org/'), null)
})

test('same-site page cards skip post links and never select API or asset routes', () => {
  const pin = '0x' + 'ab'.repeat(32)
  for (const origin of ['https://client.invalid', 'https://blohard.social']) {
    for (const path of ['/p/84532/42', `/p/84532/42?commit=${pin}`, '/p/84532/42#/about', '/api/status', '/assets/app.js', '/unknown']) {
      assert.equal(selectLink(origin + path), null, path)
    }
    for (const path of ['/', '/about', '/keys/84532/about', '/design.html', '/u/84532/0x' + 'ab'.repeat(20)]) {
      const url = origin + path
      assert.deepEqual(selectLink(url), { url, source: url, localPath: path })
    }
  }
  const local = 'http://localhost:5173/keys/84532/about'
  assert.equal(selectLink(local, 4, 'http://localhost:5173').localPath, '/keys/84532/about')
  assert.equal(selectLink('https://blohard.social:1234/about'), null)
  assert.equal(selectLink('https://blohard.social/keys/084532/about'), null)
  assert.equal(selectLink('https://blohard.social/design.html#intro').localPath, '/design.html')
  assert.equal(selectLink('https://blohard.social/keys/84532/about?utm_source=share').localPath, '/keys/84532/about')
  assert.equal(selectLink('https://elsewhere.example/p/84532/42').localPath, undefined, 'other sites use external previews')
})

test('same-site page previews share the attachment budget and need no outbound service', t => {
  const saved = host.status
  t.after(() => { host.status = saved })
  host.status = { chains: [], gateway: { link_previews: false }, store: { attachments: { max_per_message: 1 } } }
  const url = 'https://blohard.social/keys/84532/about'
  assert.equal(hostPreviewLink(url)?.localPath, '/keys/84532/about')
  assert.equal(hostPreviewLink('https://blohard.social/p/84532/42'), null)
  assert.equal(hostPreviewLink('https://example.org/'), null)
  const quote = 'post://84532/7?commit=0x' + 'ab'.repeat(32)
  assert.equal(hostPreviewLink(`${quote}\n${url}`), null, 'the explicit quote keeps priority')
  assert.equal(selectLink(url, 0), null)
  assert.equal(selectLink(`https://blohard.social/p/84532/42 ${url}`)?.url, url, 'skip posts and preview the next eligible page')
  assert.equal(selectLink(`${url} https://example.org/`)?.url, url, 'only one link card')
  assert.equal(selectLink(`https://example.org/ ${url}`)?.url, 'https://example.org/', 'text order chooses the card')
})

test('same-site head reads stop early, handle split characters, and cancel at the byte cap', async () => {
  const head = '<head><title>whale 🐳</title><meta name="description" content="keys"></head>'
  const bytes = new TextEncoder().encode(head + '<body>' + 'x'.repeat(100_000))
  for (const size of [1, 7, 4096]) {
    let at = 0, cancelled = false
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(bytes.slice(at, at += size)) },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }), { headers: { 'content-length': String(bytes.length) } })
    assert.equal(await pageHead(response), head.slice(0, -7))
    assert.ok(cancelled)
    assert.ok(at <= new TextEncoder().encode(head).length + size, 'body is not drained')
  }
  let bytesRead = 0, cancelled = false
  const huge = new Response(new ReadableStream({
    pull(controller) { bytesRead += 1024; controller.enqueue(new Uint8Array(1024).fill(120)) },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 }))
  assert.equal((await pageHead(huge)).length, 32 << 10)
  assert.equal(bytesRead, 32 << 10)
  assert.ok(cancelled)
})

test('non-HTML local answers are cancelled, and local requests cannot follow redirects', async t => {
  let cancelled = false
  const response = new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-type': 'application/json' } })
  assert.equal(await siteMetadata(response), null)
  assert.ok(cancelled)
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/keys/84532/about')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    throw new TypeError('redirect refused')
  })
  assert.equal(await new LinkPreviews().read(selectLink('https://blohard.social/keys/84532/about')), null)
})

test('metadata validates bounds and image schemes, leaving markup as literal text', () => {
  assert.deepEqual(checkedPreview({ preview: answer }), answer)
  assert.equal(checkedPreview({ preview: null }), null)
  for (const preview of [{ ...answer, title: 'x'.repeat(257) }, { ...answer, image: 'javascript:alert(1)' }, { ...answer, image: 'https://user:pw@site.example/img' }, { ...answer, description: null }]) {
    assert.throws(() => checkedPreview({ preview }))
  }
})

test('identical URLs share a read, browser cache lifetime is honored, and failures keep no metadata', async t => {
  const savedFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = savedFetch })
  const wait = deferred()
  let requests = 0
  globalThis.fetch = async (path, options) => {
    requests++
    assert.equal(options.headers['x-blohard-preview'], '1')
    assert.match(path, /^\/api\/link-preview\?chain=84532&id=123&link=/)
    await wait.promise
    return new Response(JSON.stringify({ preview: answer }), { headers: { 'cache-control': 'public, max-age=300' } })
  }
  const previews = new LinkPreviews()
  const a = previews.read(link('https://example.org/#one'), post), b = previews.read(link('https://example.org/#two'), post)
  wait.resolve()
  assert.deepEqual(await a, answer)
  assert.deepEqual(await b, answer)
  assert.equal(requests, 1)
  await previews.read(link('https://example.org/'), post)
  assert.equal(requests, 1)
  globalThis.fetch = async () => { requests++; return new Response('busy', { status: 503 }) }
  assert.equal(await previews.read(link('https://other.example/'), post), null)
  assert.equal(await previews.read(link('https://other.example/'), post), null)
  assert.equal(requests, 2, 'a temporary failure has a short in-memory cooldown')
})

test('pending and unavailable previews never render an empty embed', async t => {
  const savedFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = savedFetch })
  const selected = selectLink('posts and replies still go through board.post.')
  assert.equal(selected.url, 'https://board.post/', 'a valid suffix remains a link candidate')
  const props = { link: selected, post, author }
  const render = () => renderComponent('features/messages/LinkPreview.svelte', props)
  assert.ok(!(await render()).includes('<aside'), 'no fallback card while waiting for metadata')
  for (const fetch of [
    async () => Response.json({ preview: null }),
    async () => new Response('preview unavailable', { status: 503 }),
    async () => { throw new Error('network unavailable') },
  ]) {
    globalThis.fetch = fetch
    const value = await new LinkPreviews().read(selected, post)
    assert.equal(value, null)
    const stub = t.mock.method(Resource.prototype, 'value', () => value)
    assert.ok(!(await render()).includes('<aside'), 'no embed after an unavailable answer')
    stub.mock.restore()
  }
})

test('metadata without an image still renders a useful preview', async t => {
  t.mock.method(Resource.prototype, 'value', () => ({ ...answer, image: null }))
  const html = await renderComponent('features/messages/LinkPreview.svelte', { link: link('https://example.org/'), post, author })
  assert.ok(html.includes('<aside') && html.includes('&lt;b>title&lt;/b>') && html.includes('description'))
  assert.ok(!html.includes('<img'))
})

test('text is always visible, but only own and followed authors get an image element automatically', async t => {
  const previous = wallet.account
  t.after(() => { wallet.account = previous; follows.addresses = [] })
  t.mock.method(Resource.prototype, 'value', () => answer)
  wallet.account = null
  follows.addresses = []
  const props = { link: link('https://original.example/article'), post, author }
  const stranger = await renderComponent('features/messages/LinkPreview.svelte', props)
  assert.ok(stranger.includes('description') && stranger.includes('&lt;b>title&lt;/b>'))
  assert.ok(stranger.includes('show image') && !stranger.includes('<img'))
  assert.ok(!stranger.includes('>hide<'), 'a hidden image offers only show image')
  assert.ok(!stranger.includes('loading image'), 'nothing loads while the image is hidden')
  assert.ok(stranger.includes('original.example') && !stranger.includes('href="https://images.example'))
  follows.addresses = [author]
  const followed = await renderComponent('features/messages/LinkPreview.svelte', props)
  assert.ok(followed.includes('<img') && followed.includes('referrerpolicy="no-referrer"'))
  assert.ok(followed.includes('>hide<') && !followed.includes('show image'), 'a shown image offers only hide')
  assert.ok(followed.includes('loading image…'), 'a shown image has a spinner under it until it arrives')
  follows.addresses = []
  wallet.account = author
  assert.ok((await renderComponent('features/messages/LinkPreview.svelte', props)).includes('<img'))
})


test('post identity and original link text travel with the request and busy cooldown honors retry-after', async t => {
  const savedFetch = globalThis.fetch, now = Date.now
  t.after(() => { globalThis.fetch = savedFetch; Date.now = now })
  let time = 0, requests = 0
  Date.now = () => time
  globalThis.fetch = async path => {
    requests++
    const query = new URL(path, 'https://client.invalid').searchParams
    assert.equal(query.get('chain'), '84532')
    assert.equal(query.get('id'), '123')
    assert.equal(query.get('link'), 'example.org/café#intro')
    return new Response('busy', { status: 503, headers: { 'retry-after': '600' } })
  }
  const previews = new LinkPreviews(), selected = selectLink('example.org/café#intro')
  await previews.read(selected, post)
  time = 599999
  await previews.read(selected, post)
  assert.equal(requests, 1)
  time = 600000
  await previews.read(selected, post)
  assert.equal(requests, 2)
})

test('draft previews use the bounded draft endpoint and reuse metadata without uploading the draft', async t => {
  const savedFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = savedFetch })
  const calls = []
  globalThis.fetch = async (path, options) => {
    calls.push([path, options])
    return new Response(JSON.stringify({ preview: answer }), { headers: { 'cache-control': 'public, max-age=300' } })
  }
  const previews = new LinkPreviews()
  assert.deepEqual(await previews.read(link('https://example.org/draft')), answer)
  assert.equal(calls[0][0], '/api/link-preview/draft?link=https%3A%2F%2Fexample.org%2Fdraft')
  assert.equal(calls[0][1].body, undefined)
  assert.equal(calls[0][1].headers['x-blohard-preview'], '1')
  assert.deepEqual(await previews.read(link('https://example.org/draft'), post), answer)
  assert.equal(calls.length, 1, 'publication and repeated previews share the existing URL cache')
})

test('a refused draft preview never hides the published preview of the same link', async t => {
  const savedFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = savedFetch })
  const asked = []
  globalThis.fetch = async path => {
    asked.push(path.startsWith('/api/link-preview/draft') ? 'draft' : 'post')
    return path.startsWith('/api/link-preview/draft')
      ? new Response('busy', { status: 503, headers: { 'retry-after': '15' } })
      : new Response(JSON.stringify({ preview: answer }), { headers: { 'cache-control': 'public, max-age=300' } })
  }
  const previews = new LinkPreviews()
  assert.equal(await previews.read(link('https://example.org/a')), null, 'the draft endpoint refused')
  assert.equal(await previews.read(link('https://example.org/a')), null, 'and its cooldown holds for drafts')
  assert.deepEqual(await previews.read(link('https://example.org/a'), post), answer, 'the published post still asks the host')
  assert.deepEqual(asked, ['draft', 'post'])
  assert.deepEqual(await previews.read(link('https://example.org/a')), answer, 'a published answer serves drafts too')
  assert.deepEqual(asked, ['draft', 'post'])
})

test('a refusal for one post never hides the preview for another post linking the same page', async t => {
  const savedFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = savedFetch })
  const asked = []
  globalThis.fetch = async path => {
    asked.push(path)
    return path.includes('id=1&')
      ? new Response('gone', { status: 404 })
      : new Response(JSON.stringify({ preview: answer }), { headers: { 'cache-control': 'public, max-age=300' } })
  }
  const previews = new LinkPreviews()
  const deleted = { chain: 84532, id: 1n }, live = { chain: 84532, id: 2n }
  assert.equal(await previews.read(link('https://example.org/c'), deleted), null, 'the deleted post is refused')
  assert.deepEqual(await previews.read(link('https://example.org/c'), live), answer, 'the live post gets the page')
  assert.deepEqual(await previews.read(link('https://example.org/c'), deleted), answer, 'and the answer now serves the other post too')
  assert.equal(asked.length, 2, 'one ask per post, none after the shared answer')
})

test('a published read never joins a draft request in flight', async t => {
  const savedFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = savedFetch })
  const draft = deferred(), asked = []
  globalThis.fetch = async path => {
    if (path.startsWith('/api/link-preview/draft')) { asked.push('draft'); await draft.promise; return new Response('busy', { status: 503, headers: { 'retry-after': '2' } }) }
    asked.push('post')
    return new Response(JSON.stringify({ preview: answer }), { headers: { 'cache-control': 'public, max-age=300' } })
  }
  const previews = new LinkPreviews()
  const drafting = previews.read(link('https://example.org/b'))
  const published = previews.read(link('https://example.org/b'), post)
  draft.resolve()
  assert.equal(await drafting, null)
  assert.deepEqual(await published, answer, 'the post got its own answer, not the draft\'s refusal')
  assert.deepEqual(asked.sort(), ['draft', 'post'])
})

test('a card previews a link only when its host offers previews, under the host\'s attachment cap', t => {
  const saved = host.status
  t.after(() => { host.status = saved })
  const image = n => `![image](record:0x${String(n).padStart(64, '0')})`
  host.status = { ...saved, gateway: { names: false, link_previews: false }, store: { attachments: { max_per_message: 4 } } }
  assert.equal(hostPreviewLink('https://example.org/a'), null, 'no preview service')
  host.status = { ...host.status, gateway: { names: false, link_previews: true } }
  assert.equal(hostPreviewLink('https://example.org/a')?.url, 'https://example.org/a')
  host.status = { ...host.status, store: { attachments: { max_per_message: 1 } } }
  assert.equal(hostPreviewLink(`${image(1)} https://example.org/a`), null, 'one picture fills a one-preview host')
})

test('a visitor-limit refusal pauses that endpoint for its Retry-After, and the refused and waiting reads then ask', async t => {
  const savedFetch = globalThis.fetch, savedNow = Date.now
  t.after(() => { globalThis.fetch = savedFetch; Date.now = savedNow })
  let now = 1_000_000, refused = false
  Date.now = () => now
  const asked = []
  globalThis.fetch = async path => {
    const url = decodeURIComponent(path.split('link=')[1])
    asked.push(url)
    if (url.endsWith('/first') && !refused) {
      refused = true
      return new Response('slow down', { status: 429, headers: { 'retry-after': '15' } })
    }
    return new Response(JSON.stringify({ preview: answer }), { headers: { 'cache-control': 'public, max-age=300' } })
  }
  const previews = new LinkPreviews(), pausing = deferred(), resume = deferred(), waits = []
  previews.pause = ms => { waits.push(ms); pausing.resolve(); return resume.promise.then(() => { now += ms }) }
  const first = previews.read(link('https://example.org/first'), post)
  await pausing.promise
  const other = previews.read(link('https://example.org/second'), post)
  assert.deepEqual(await previews.read(link('https://example.org/third')), answer, 'the draft endpoint was never paused')
  resume.resolve()
  assert.deepEqual(await first, answer, 'the refused read waited out the pause and asked again')
  assert.deepEqual(await other, answer, 'a published read waited out the pause and then asked')
  assert.deepEqual(waits, [15_000, 15_000])
  assert.deepEqual(asked, ['first', 'third', 'first', 'second'].map(p => `https://example.org/${p}`))
})

test('a read that waited out a pause takes the page the other endpoint fetched meanwhile', async t => {
  const savedFetch = globalThis.fetch, savedNow = Date.now
  t.after(() => { globalThis.fetch = savedFetch; Date.now = savedNow })
  let now = 1_000_000
  Date.now = () => now
  const asked = []
  globalThis.fetch = async path => {
    const draft = path.startsWith('/api/link-preview/draft')
    asked.push(draft ? 'draft' : 'post')
    if (draft && asked.length === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
    return new Response(JSON.stringify({ preview: answer }), { headers: { 'cache-control': 'public, max-age=300' } })
  }
  const previews = new LinkPreviews(), pausing = deferred(), resume = deferred(), waits = []
  previews.pause = ms => { waits.push(ms); pausing.resolve(); return resume.promise.then(() => { now += ms }) }
  const drafting = previews.read(link('https://example.org/shared'))
  await pausing.promise
  assert.deepEqual(await previews.read(link('https://example.org/shared'), post), answer)
  resume.resolve()
  assert.deepEqual(await drafting, answer, 'the draft read used the published answer')
  assert.deepEqual(asked, ['draft', 'post'], 'and asked the paused endpoint nothing more')
  assert.deepEqual(waits, [1_000], 'a zero Retry-After still pauses for a second')
})

test('published reads waiting out a pause leave the request lanes to the draft endpoint', async t => {
  const savedFetch = globalThis.fetch, savedNow = Date.now
  t.after(() => { globalThis.fetch = savedFetch; Date.now = savedNow })
  let now = 1_000_000
  Date.now = () => now
  const asked = []
  globalThis.fetch = async path => {
    const draft = path.startsWith('/api/link-preview/draft')
    asked.push(draft ? 'draft' : 'post')
    if (!draft && asked.filter(a => a === 'post').length === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
    return new Response(JSON.stringify({ preview: answer }), { headers: { 'cache-control': 'public, max-age=300' } })
  }
  const previews = new LinkPreviews()
  const pausing = deferred(), resume = deferred()
  previews.pause = ms => { pausing.resolve(); return resume.promise.then(() => { now += ms }) }
  const refused = previews.read(link('https://example.org/refused'), post)
  await pausing.promise
  // Three published reads now wait out the pause, enough to fill both lanes if they held them.
  const waiting = [refused, previews.read(link('https://example.org/p1'), post), previews.read(link('https://example.org/p2'), post)]
  const draft = await Promise.race([previews.read(link('https://example.org/d1')), new Promise(resolve => setTimeout(() => resolve('blocked'), 1000))])
  assert.deepEqual(draft, answer, 'the draft endpoint is not paused and its read goes ahead')
  assert.deepEqual(asked, ['post', 'draft'])
  resume.resolve()
  for (const read of waiting) assert.deepEqual(await read, answer)
})

test('a read refused by the visitor limit asks three times in all, then keeps the refusal', async t => {
  const savedFetch = globalThis.fetch, savedNow = Date.now
  t.after(() => { globalThis.fetch = savedFetch; Date.now = savedNow })
  let now = 1_000_000, asked = 0
  Date.now = () => now
  globalThis.fetch = async () => { asked++; return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }) }
  const previews = new LinkPreviews()
  previews.pause = ms => new Promise(resolve => setTimeout(() => { now += ms; resolve() }, 0))
  assert.equal(await previews.read(link('https://example.org/closed'), post), null, 'a closed card\'s read ends too')
  assert.equal(asked, 3)
  assert.equal(await previews.read(link('https://example.org/closed'), post), null)
  assert.equal(asked, 3, 'the refusal is kept for a while')
})

test('a read arriving at a full queue waits for room rather than answering no preview', async t => {
  const savedFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = savedFetch })
  const held = deferred(), asked = []
  globalThis.fetch = async path => {
    const url = decodeURIComponent(path.split('link=')[1])
    asked.push(url)
    if (url.includes('/held/')) await held.promise
    return new Response(JSON.stringify({ preview: answer }), { headers: { 'cache-control': 'public, max-age=300' } })
  }
  const previews = new LinkPreviews()
  const full = Array.from({ length: 64 }, (_, n) => previews.read(link(`https://example.org/held/${n}`), post))
  const late = previews.read(link('https://example.org/late'), post)
  assert.equal(await Promise.race([late, new Promise(resolve => setTimeout(() => resolve('waiting'), 50))]), 'waiting')
  held.resolve()
  assert.deepEqual(await late, answer, 'it asked once there was room')
  assert.equal(asked.at(-1), 'https://example.org/late')
  for (const read of full) assert.deepEqual(await read, answer)
})

test('a full preview queue drains without waking every waiting read on every completion', async t => {
  const savedFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = savedFetch })
  const held = deferred()
  let requests = 0, entries = 0
  globalThis.fetch = async () => {
    requests++
    await held.promise
    return Response.json({ preview: answer })
  }
  const previews = new LinkPreviews(), read = previews.read.bind(previews)
  previews.read = (...args) => { entries++; return read(...args) }
  const pending = Array.from({ length: 128 }, (_, n) => previews.read(link(`https://example.org/queue/${n}`), post))
  const duplicate = previews.read(link('https://example.org/queue/100'), post)
  assert.equal(duplicate, pending[100], 'duplicates share a promise even before admission')
  held.resolve()
  for (const result of await Promise.all([...pending, duplicate])) assert.deepEqual(result, answer)
  assert.equal(requests, 128, 'queued URLs share their work too')
  assert.ok(entries <= 257, `${entries} read entries for 129 callers: capacity wakes only the next read`)
})

test('overflow beyond active and waiting previews is an explicit retryable error, never a no-preview answer', async t => {
  const savedFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = savedFetch })
  const held = deferred()
  globalThis.fetch = async () => { await held.promise; return Response.json({ preview: answer }) }
  const previews = new LinkPreviews()
  const pending = Array.from({ length: 128 }, (_, n) => previews.read(link(`https://example.org/full/${n}`), post))
  const overflow = previews.read(link('https://example.org/overflow'), post).then(value => value, error => error)
  try {
    const outcome = await Promise.race([overflow, new Promise(resolve => setTimeout(() => resolve('still queued'), 100))])
    assert.equal(outcome?.name, 'PreviewQueueFull')
  } finally { held.resolve(); await Promise.all([...pending, overflow]) }
  assert.deepEqual(await previews.read(link('https://example.org/overflow'), post), answer, 'capacity failures are not cached')
})


test('a card with a full preview queue explains the delay and offers retry', async t => {
  t.mock.method(Resource.prototype, 'failure', () => ({ key: null, cause: new PreviewQueueFull() }))
  const html = await renderComponent('features/messages/LinkPreview.svelte', { link: link('https://example.org/'), post, author })
  assert.ok(html.includes('preview queue is full'))
  assert.match(html, /<button[^>]*>try preview again<\/button>/)
  assert.ok(!html.includes('<aside') && !html.includes('<img'), 'queue pressure offers retry without an empty embed')
})

test('a refusal is kept an hour at most, whatever its Retry-After', async t => {
  const savedFetch = globalThis.fetch, now = Date.now
  t.after(() => { globalThis.fetch = savedFetch; Date.now = now })
  let time = 0, requests = 0
  Date.now = () => time
  globalThis.fetch = async () => { requests++; return new Response('busy', { status: 503, headers: { 'retry-after': '86400' } }) }
  const previews = new LinkPreviews(), selected = link('https://example.org/slow')
  await previews.read(selected, post)
  time = 3_599_999
  await previews.read(selected, post)
  assert.equal(requests, 1)
  time = 3_600_000
  await previews.read(selected, post)
  assert.equal(requests, 2, 'asked again after the hour')
})


test('post-link previews accept inline local URLs and preserve valid pins', () => {
  const pin = '0x' + 'ab'.repeat(32)
  assert.deepEqual(previewPost('See https://blohard.social/p/84532/42 for context.'), { chainId: 84532, id: 42n })
  assert.deepEqual(previewPost(`See https://blohard.social/p/84532/42?commit=${pin}&utm_source=share`), { chainId: 84532, id: 42n, commit: pin })
  assert.deepEqual(previewPost('http://localhost:5173/p/84532/42', 4, 'http://localhost:5173'), { chainId: 84532, id: 42n })
  assert.deepEqual(previewPost('https://blohard.social/p/84532/42 https://blohard.social/p/84532/43'), { chainId: 84532, id: 42n })
  for (const url of [
    'https://other.example/p/84532/42', 'https://blohard.social.evil.example/p/84532/42',
    'https://blohard.social:1234/p/84532/42', 'https://name:secret@blohard.social/p/84532/42',
    'https://blohard.social/p/84532/042', 'https://blohard.social/p/84532/18446744073709551616',
    'https://blohard.social/p/9007199254740992/42', 'https://blohard.social/p/84532/42?commit=bad',
    `https://blohard.social/p/84532/42?commit=${pin}&commit=${pin}`, 'https://blohard.social/p/84532/42#/about',
    'post://84532/42',
  ]) assert.equal(previewPost(url), null, url)
})

test('explicit quotes suppress automatic cards and post-link cards respect picture limits', () => {
  const url = 'https://blohard.social/p/84532/42'
  const quote = 'post://84532/7?commit=0x' + 'ab'.repeat(32)
  const image = '![image](record:0x' + 'cd'.repeat(32) + ')'
  assert.equal(previewPost(`${quote}\n${url}`), null)
  assert.equal(selectLink(`${quote}\nhttps://example.org`), null)
  assert.equal(previewPost(url, 0), null)
  assert.equal(previewPost(`${image} ${url}`, 1), null)
  assert.deepEqual(previewPost(`${image} ${url}`, 2), { chainId: 84532, id: 42n })
})

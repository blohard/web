import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { install, load, teardown } from '../../../../scripts/harness.mjs'

const { fetchContent, hashOf } = await load('lib/store.ts')
const { hydrateRecords } = await load('features/messages/record-images.ts')
const { follows } = await load('lib/follows.svelte.ts')
const { host } = await load('lib/host.svelte.ts')
const { pictureSlots } = await load('features/messages/picture-slots.ts')
const bytes = new TextEncoder().encode('version/1 image/png\npicture')
const hash = hashOf(bytes)
const interrupted = () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(bytes.slice(0, 8))
    controller.error(new Error('connection lost during the body'))
  },
}))
beforeEach(install)
after(teardown)

test('an interrupted content body returns a fetch error and the next request can succeed', async () => {
  globalThis.fetch = async () => interrupted()
  const result = await fetchContent(hash)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'error')
  globalThis.fetch = async () => new Response(bytes)
  assert.deepEqual(await fetchContent(hash), { ok: true, bytes })
})

test('a content body larger than any record the host stores is refused before hashing', async (t) => {
  t.after(() => { host.status = null })
  host.status = { store: { max_content_size: 16, attachments: { max_bytes: 20, max_per_message: 4 } } }
  let pulled = 0
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(8)) },
  }))
  const result = await fetchContent(hash)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'error')
  assert.match(result.detail, /more bytes than any record/)
  assert.ok(pulled <= 4, 'reading stops at the limit instead of draining the stream')
  host.status = { store: { max_content_size: bytes.length, attachments: null } }
  globalThis.fetch = async () => new Response(bytes)
  assert.deepEqual(await fetchContent(hash), { ok: true, bytes }, 'a record exactly at the limit is accepted')
})

// Only the element operations used by the picture control; no DOM library.
function placeholder(t, author) {
  const previous = globalThis.document
  const elements = []
  const element = (tag) => {
    const el = { tag, dataset: {}, textContent: '', hidden: false, children: [],
      append(...children) { this.children.push(...children) },
      replaceChildren(...children) { this.children = children },
      replaceWith(other) { this.replacement = other },
      remove() { this.removed = true },
      classList: { contains: (name) => name === 'rec-image' },
    }
    elements.push(el)
    return el
  }
  globalThis.document = { createElement: element }
  t.after(() => { globalThis.document = previous })
  const stub = element('span')
  stub.dataset = { record: hash, alt: 'test picture' }
  hydrateRecords({ dataset: { chain: '1', message: '2', author }, querySelectorAll: (selector) => selector === '[data-record]' ? [stub] : [] })
  return { box: stub.children[0], button: elements.find((el) => el.tag === 'button') }
}
async function click(button) {
  button.onclick()
  for (let i = 0; i < 100 && !button.removed && button.textContent === 'loading…'; i++) await setImmediate()
  assert.notEqual(button.removed ? '' : button.textContent, 'loading…', 'the download must release the loading state')
}

for (const [name, failure] of [
  ['missing content', () => new Response(null, { status: 404 })],
  ['busy host', () => new Response('busy', { status: 503 })],
  ['interrupted body', interrupted],
  ['network failure', () => { throw new TypeError('offline') }],
]) {
  test(`a picture can be retried after ${name}, then toggles without fetching again`, async (t) => {
    const { box, button } = placeholder(t)
    let calls = 0
    globalThis.fetch = async () => { calls++; return calls === 1 ? failure() : new Response(bytes) }
    await click(button)
    assert.equal(button.removed, undefined)
    assert.equal(button.textContent, 'retry picture')
    assert.equal(box.dataset.openedPicture, 'true', 'a reader-opened frame stays reserved after failure')
    await click(button)
    const frame = box.children.find((el) => el.className === 'rec-image-stage')
    const img = frame.children.find((el) => el.tag === 'img')
    assert.ok(img, 'verified picture is inserted')
    assert.equal(box.dataset.openedPicture, 'true', 'opening the picture lifts the containing preview')
    img.onload() // Release the test's blob URL as the browser would after decoding.
    await click(button)
    assert.equal(frame.hidden, true)
    assert.equal(box.dataset.openedPicture, 'false', 'hiding the picture restores the preview')
    await click(button)
    assert.equal(frame.hidden, false)
    assert.equal(box.dataset.openedPicture, 'true')
    assert.equal(calls, 2)
  })
}

test('a hash mismatch never displays a picture', async (t) => {
  const { box, button } = placeholder(t)
  globalThis.fetch = async () => new Response('wrong bytes')
  await click(button)
  assert.equal(box.children.find(el => el.className === 'rec-image-stage').children.some(el => el.tag === 'img'), false)
  assert.equal(button.removed, true)
  assert.equal(box.dataset.openedPicture, 'true', 'failed verification keeps the reader-opened frame')
})

test('automatically shown pictures stay compact until the reader chooses to open them', async (t) => {
  const author = `0x${'39'.repeat(20)}`
  follows.toggle(author)
  t.after(() => follows.toggle(author))
  globalThis.fetch = async () => new Response(bytes)
  const { box, button } = placeholder(t, author)
  for (let i = 0; i < 100 && button.textContent === 'loading…'; i++) await setImmediate()
  const frame = box.children.find((el) => el.className === 'rec-image-stage')
  const img = frame.children.find((el) => el.tag === 'img')
  assert.ok(img)
  img.onload()
  assert.notEqual(box.dataset.openedPicture, 'true', 'auto-loading must not expand the stream')
  await click(button)
  assert.equal(frame.hidden, true)
  await click(button)
  assert.equal(frame.hidden, false)
  assert.equal(box.dataset.openedPicture, 'true')
})

test('an auto-loaded picture reserves its frame before the download and keeps it after a failure', async (t) => {
  const author = `0x${'38'.repeat(20)}`
  follows.toggle(author)
  t.after(() => follows.toggle(author))
  let finish
  globalThis.fetch = () => new Promise(resolve => { finish = resolve })
  const { box, button } = placeholder(t, author)
  const frame = box.children.find(el => el.className === 'rec-image-stage')
  assert.ok(frame, 'the frame exists before bytes arrive')
  assert.equal(frame.hidden, false)
  // It takes a download slot first, a turn later.
  for (let i = 0; i < 100 && !finish; i++) await setImmediate()
  finish(new Response(null, { status: 404 }))
  for (let i = 0; i < 100 && button.textContent === 'loading…'; i++) await setImmediate()
  assert.equal(frame.hidden, false, 'an error must not collapse the reserved frame')
  assert.equal(button.textContent, 'retry picture')
})

test('a taken-down picture says so and offers no retry', async (t) => {
  const author = `0x${'39'.repeat(20)}`
  follows.toggle(author)
  t.after(() => follows.toggle(author))
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'this host has taken this content down', code: 'taken_down' }),
    { status: 410, headers: { 'content-type': 'application/json' } })
  const { box, button } = placeholder(t, author)
  for (let i = 0; i < 100 && !button.removed && button.textContent === 'loading…'; i++) await setImmediate()
  const frame = box.children.find(el => el.className === 'rec-image-stage')
  assert.equal(frame.textContent, 'image removed by this host')
  assert.equal(button.removed, true, 'no retry for a takedown')
})

const cardBoxes = []
// A card body with several pictures by a followed author, which open on their own.
function card(t, count, author) {
  const previous = globalThis.document
  const elements = []
  const element = (tag) => {
    const el = { tag, dataset: {}, textContent: '', hidden: false, children: [],
      append(...children) { this.children.push(...children) },
      replaceChildren(...children) { this.children = children },
      remove() { this.removed = true },
      classList: { contains: (name) => name === 'rec-image' },
    }
    elements.push(el)
    return el
  }
  globalThis.document = { createElement: element }
  t.after(() => { globalThis.document = previous })
  const stubs = Array.from({ length: count }, (_, i) => {
    const stub = element('span')
    stub.dataset = { record: hash, alt: `picture ${i}` }
    return stub
  })
  const root = { isConnected: true, dataset: { chain: '1', message: '2', author }, querySelectorAll: (s) => s === '[data-record]' ? stubs : [] }
  const cleanup = hydrateRecords(root)
  cardBoxes.push(...stubs.map((stub) => stub.children[0]))
  return { root, cleanup, buttons: elements.filter((el) => el.tag === 'button') }
}
const microtasks = async () => { for (let i = 0; i < 20; i++) await setImmediate() }

test('pictures that open on their own download a few at a time, and a card that leaves stops its own', async (t) => {
  const author = `0x${'37'.repeat(20)}`
  follows.toggle(author)
  t.after(() => follows.toggle(author))
  const signals = []
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    signals.push(init.signal)
    init.signal.addEventListener('abort', () => reject(init.signal.reason))
  })
  const { root, cleanup, buttons } = card(t, 6, author)
  await microtasks()
  assert.equal(signals.length, 4, 'four at once, the rest wait')
  buttons[5].onclick()
  await microtasks()
  assert.equal(signals.length, 5, 'a picture the reader pressed does not wait for a slot')
  // A store change re-runs the attachment while the card stays: nothing stops.
  cleanup?.()
  await microtasks()
  assert.equal(signals.some((s) => s.aborted), false)
  root.isConnected = false
  cleanup?.()
  await microtasks()
  assert.equal(signals.every((s) => s.aborted), true, 'downloads of a card that left stop')
  assert.equal(signals.length, 5, 'and its waiting pictures never start')
})

// Hold every shared slot, as other cards' downloads would.
const holdSlots = () => Promise.all(Array.from({ length: pictureSlots.size }, () => pictureSlots.take(new AbortController().signal)))

test('a slot granted to a body that is leaving in the same turn goes back', async (t) => {
  const author = `0x${'36'.repeat(20)}`
  follows.toggle(author)
  t.after(() => follows.toggle(author))
  globalThis.fetch = () => assert.fail('a body that left must not download')
  const held = await holdSlots()
  const { root, cleanup } = card(t, 1, author)
  await microtasks()
  // The body leaves, then a slot is granted to its waiting picture, in one turn.
  root.isConnected = false
  cleanup()
  held[0]()
  await microtasks()
  for (const release of held.slice(1)) release()
  const all = await Promise.race([holdSlots(), new Promise((resolve) => setTimeout(() => resolve('leaked'), 200))])
  assert.notEqual(all, 'leaked', 'every slot is free again')
  for (const release of all) release()
})

test('pressing a picture while it waits for a slot opens it as the reader asked', async (t) => {
  const author = `0x${'35'.repeat(20)}`
  follows.toggle(author)
  t.after(() => follows.toggle(author))
  globalThis.fetch = async () => new Response(bytes)
  const held = await holdSlots()
  try {
    const { buttons } = card(t, 1, author)
    await microtasks()
    buttons[0].onclick()
    for (let i = 0; i < 100 && buttons[0].textContent === 'loading…'; i++) await setImmediate()
    assert.equal(buttons[0].textContent, 'hide picture')
    const opened = cardBoxes.at(-1).dataset.openedPicture
    assert.equal(opened, 'true', 'a press lifts the containing preview, as an explicit show does')
  } finally { for (const release of held) release() }
})

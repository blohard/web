// A reply's draft belongs to the post it answers, shared by every page's box for that post.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown } from '../../../../scripts/harness.mjs'
const { replying, hasDraft } = await load('features/publishing/replying.svelte.ts')
const { emptyDraft } = await load('features/publishing/draft-box.svelte.ts')
beforeEach(install)
after(teardown)
const text = (t) => ({ ...emptyDraft(), text: t })
let post = 100n
const next = () => ++post
/** A page's box, as the app gets it: named pages stand in for the stream and a thread. */
let pages = 0
const page = () => replying.box(`#/test-page-${++pages}`)

test('the stream and the thread show one draft for the same post, edited in either', () => {
  const id = next(), stream = page(), thread = page()
  stream.open(1, id)
  stream.reply.edit(text('half a thought'))
  assert.equal(hasDraft(1, id), true, 'the thread page can see a reply is under way')
  thread.open(1, id)
  assert.equal(thread.reply, stream.reply, 'one draft, not a copy')
  assert.equal(thread.reply.draft.text, 'half a thought')
  thread.reply.edit(text('half a thought, finished'))
  assert.equal(stream.reply.draft.text, 'half a thought, finished', 'back in the stream it has the thread’s edits')
})

test('a sent reply clears the draft and closes its box on every page', () => {
  const id = next(), stream = page(), thread = page()
  stream.open(1, id); thread.open(1, id)
  thread.reply.edit(text('sent from the thread'))
  const sending = thread.reply.begin()
  assert.equal(stream.reply.sending, true, 'the stream sees the send in flight')
  assert.equal(thread.reply.finish(sending), true)
  assert.equal(stream.is(1, id), false)
  assert.equal(thread.is(1, id), false)
  assert.equal(hasDraft(1, id), false)
})

test('a newer edit made while sending keeps the draft and the boxes open', () => {
  const id = next(), stream = page()
  stream.open(1, id)
  stream.reply.edit(text('first'))
  const sending = stream.reply.begin()
  stream.reply.edit(text('first, then more'))
  assert.equal(stream.reply.finish(sending), false)
  assert.equal(stream.is(1, id), true)
  assert.equal(stream.reply.draft.text, 'first, then more')
})

test('closing a box discards the draft and closes the box for that post elsewhere', () => {
  const id = next(), stream = page(), thread = page()
  stream.open(1, id); thread.open(1, id)
  stream.reply.edit(text('never mind'))
  thread.close()
  assert.equal(stream.is(1, id), false)
  assert.equal(hasDraft(1, id), false)
  stream.open(1, id)
  assert.equal(stream.reply.draft.text, '', 'reopened, it starts empty')
})

test('moving a page’s box to another post keeps the first draft for later', () => {
  const first = next(), second = next(), stream = page()
  stream.open(1, first)
  stream.reply.edit(text('about the first'))
  stream.open(1, second)
  assert.equal(stream.reply.draft.text, '')
  stream.open(1, first)
  assert.equal(stream.reply.draft.text, 'about the first')
})

test('only text or an attachment counts as a draft under way', () => {
  const id = next(), box = page()
  box.open(1, id)
  assert.equal(hasDraft(1, id), false, 'an open, empty box is not a draft')
  box.reply.edit(text('   '))
  assert.equal(hasDraft(1, id), false)
  box.reply.edit({ ...emptyDraft(), attachments: [{ kind: 'attachment', name: 'image 1', mediaType: 'image/png', bytes: new Uint8Array([1]), hash: `0x${'aa'.repeat(32)}`, status: 'pending' }] })
  assert.equal(hasDraft(1, id), true)
  assert.equal(hasDraft(2, id), false, 'drafts are per chain')
})

test('a draft being sent is never evicted to make room for others', () => {
  const id = next(), box = page(), other = page()
  box.open(1, id)
  box.reply.edit(text('on its way'))
  const sending = box.reply
  const version = sending.begin()
  for (let i = 0; i < 150; i++) { other.open(1, next()); void other.reply }
  assert.equal(box.reply, sending, 'reopening its post finds the draft in flight, still locked')
  assert.equal(box.reply.sending, true)
  assert.equal(sending.finish(version), true)
  assert.equal(box.is(1, id), false)
})

test('clearing a draft closes only the boxes showing that draft', () => {
  const id = next(), box = page(), other = page()
  box.open(1, id)
  const old = box.reply
  // An idle draft may be evicted; its post then gets a new one.
  for (let i = 0; i < 150; i++) { other.open(1, next()); void other.reply }
  assert.notEqual(box.reply, old)
  box.reply.edit(text('written after the old one went'))
  old.clear()
  assert.equal(box.is(1, id), true, 'the box on the new draft stays open')
  assert.equal(box.reply.draft.text, 'written after the old one went')
})

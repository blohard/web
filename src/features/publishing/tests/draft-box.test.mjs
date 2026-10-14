// Draft ownership is shared by home and inline replies, including late completions.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../../scripts/harness.mjs'

after(teardown)

const { DraftBox, emptyDraft } = await load('features/publishing/draft-box.svelte.ts')
const write = (box, text) => box.edit({ ...emptyDraft(), text })

const { attachFiles } = await load('features/publishing/attachments.ts')
const policy = { max_bytes: 10000, max_per_message: 1, media_types: ['image/gif'] }
function conversion(box, byte = 1, active = () => true) {
  let release
  const file = { type: 'image/gif', arrayBuffer: () => new Promise((r) => { release = () => r(new Uint8Array([byte]).buffer) }) }
  const done = attachFiles(box, [file], policy, active, () => 0)
  return { done, release: () => release() }
}

test('late attachments merge with typing, but never cross a reset, unmount or submission', async () => {
  const box = new DraftBox()
  const first = conversion(box)
  write(box, 'typed while converting')
  first.release(); await first.done
  assert.match(box.draft.text, /^typed while converting\n!\[image\]/)
  assert.equal(box.draft.attachments.length, 1)
  for (const event of ['reset', 'unmount', 'submit']) {
    box.clear()
    let mounted = true
    const pending = conversion(box, 2, () => mounted)
    if (event === 'reset') box.clear()
    if (event === 'unmount') mounted = false
    if (event === 'submit') box.fail(box.begin())
    write(box, 'new draft')
    pending.release(); await pending.done
    assert.equal(box.draft.text, 'new draft', event)
    assert.deepEqual(box.draft.attachments, [], event)
  }
})

test('concurrent file conversions recheck the shared attachment allowance', async () => {
  const box = new DraftBox()
  const first = conversion(box, 1), second = conversion(box, 2)
  second.release(); await second.done
  first.release()
  assert.match(await first.done, /at most 1/)
  assert.equal(box.draft.attachments.length, 1)
})

test('a completion clears its own draft, while failures preserve all recovery inputs', () => {
  const box = new DraftBox()
  const draft = { text: '@alice picture', mentions: { alice: '0xabc' }, attachments: [{ bytes: new Uint8Array([1, 2]) }] }
  box.edit(draft)
  const failed = box.begin()
  assert.equal(box.sending, true)
  box.fail(failed)
  assert.equal(box.sending, false)
  assert.deepEqual(box.draft, draft)
  const sent = box.begin()
  assert.equal(box.finish(sent), true)
  assert.deepEqual(box.draft, emptyDraft(), 'a mount returning to this owner also sees it empty')
  assert.equal(box.sending, false)
})

test('a late completion preserves newer edits and cannot unlock a newer send or another page', () => {
  const box = new DraftBox(), other = new DraftBox()
  write(box, 'first')
  const first = box.begin()
  write(other, 'another page')
  other.begin()
  write(box, 'second')
  assert.equal(box.finish(first), false)
  assert.equal(box.draft.text, 'second')
  assert.equal(box.sending, false, 'the first send no longer locks the edited draft')
  const second = box.begin()
  box.fail(first)
  box.finish(first)
  assert.equal(box.sending, true, 'the second send owns the lock now')
  assert.equal(other.draft.text, 'another page')
  assert.equal(other.sending, true)
  assert.equal(box.finish(second), true)
})

test('home quote edits are protected, and an old reply cannot close a new target', async (t) => {
  const location = globalThis.location
  globalThis.location = { ...location, hash: '' }
  t.after(() => { globalThis.location = location })
  const { draft } = await load('features/publishing/draft.svelte.ts')
  const { replying } = await load('features/publishing/replying.svelte.ts')
  draft.clear()
  const stop = draft.onPress(() => {})
  write(draft, 'quoted post')
  const sent = draft.begin()
  draft.add({ chainId: 1, id: 10n, commit: `0x${'ab'.repeat(32)}` })
  assert.equal(draft.finish(sent), false)
  assert.equal(draft.quotes.length, 1)
  assert.equal(draft.sending, false)
  assert.equal(draft.finish(draft.begin()), true)
  assert.deepEqual(draft.quotes, [])
  stop()

  // Drafts belong to the post they answer: an old reply finishing clears only
  // its own post's draft, and never closes the box now open under another.
  const reply = replying.box('#/draft-box-test')
  reply.open(1, 10n)
  const firstDraft = reply.reply
  write(firstDraft, 'first reply')
  const old = firstDraft.begin()
  reply.open(1, 11n)
  write(reply.reply, 'second reply')
  const current = reply.reply.begin()
  assert.equal(firstDraft.finish(old), true, 'the first reply went out')
  assert.equal(reply.is(1, 11n), true, 'and the box under the second post stays')
  assert.equal(reply.reply.sending, true)
  assert.equal(reply.reply.draft.text, 'second reply')
  assert.equal(reply.reply.finish(current), true)
  assert.equal(reply.id, null)
})

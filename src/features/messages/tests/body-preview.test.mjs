import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../../scripts/harness.mjs'

const { bodyPreview } = await load('features/messages/body-preview.ts')
after(teardown)

function layout(t) {
  const saved = new Map(['ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const observers = new Set(), frames = new Map()
  let serial = 0
  class Observer {
    constructor(fn) { this.fn = fn; observers.add(this) }
    observe() {}
    disconnect() { observers.delete(this) }
  }
  globalThis.ResizeObserver = globalThis.MutationObserver = Observer
  globalThis.requestAnimationFrame = (fn) => { frames.set(++serial, fn); return serial }
  globalThis.cancelAnimationFrame = (id) => frames.delete(id)
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn() }
  const changed = () => { for (const o of observers) o.fn(); flush() }
  const control = (top, bottom, inert = false) => ({
    inert, rects: [{ top, bottom }], getClientRects() { return this.rects },
  })
  const box = (height, limit, controls = []) => {
    const content = { height, controls, getBoundingClientRect() { return { height: this.height } }, querySelectorAll() { return this.controls } }
    const node = { limit, firstElementChild: content,
      getBoundingClientRect() { return { top: 0, bottom: Math.min(content.height, this.limit), height: Math.min(content.height, this.limit) } },
    }
    return { node, content }
  }
  return { box, control, changed, flush, frames, observers }
}

test('short bodies need no link; late content and width changes remeasure the natural body', (t) => {
  const b = layout(t), { node, content } = b.box(80, 200), answers = []
  const action = bodyPreview(node, (clipped) => answers.push(clipped))
  b.flush()
  assert.deepEqual(answers, [false])
  content.height = 400 // An image or quoted body arrives; the viewport stays capped.
  b.changed()
  assert.deepEqual(answers, [false, true])
  b.changed()
  assert.equal(answers.length, 2, 'unchanged layout does not publish another state update')
  node.limit = 500
  b.changed()
  assert.deepEqual(answers, [false, true, false])
  content.height = 700 // Narrower text wrapping can make the same body overflow again.
  b.changed()
  assert.equal(answers.at(-1), true)
  action.destroy()
  assert.equal(b.observers.size, 0)
  assert.equal(b.frames.size, 0)
})

test('controls entirely past the cut leave the tab order; any visible part keeps a control working', (t) => {
  const b = layout(t), visible = b.control(20, 40), cut = b.control(190, 210), hidden = b.control(300, 320)
  const { node, content } = b.box(400, 200, [visible, cut, hidden])
  const action = bodyPreview(node, () => {})
  b.flush()
  assert.equal(visible.inert, false)
  assert.equal(cut.inert, false, 'a picture cut by the preview still opens from its visible part')
  assert.equal(hidden.inert, true)
  const late = b.control(350, 375)
  content.controls.push(late) // A hydrated attachment adds a button without growing the body.
  b.changed()
  assert.equal(late.inert, true)
  // A wrapping link's second line crosses the cut; its first line still follows the link.
  visible.rects.push({ top: 190, bottom: 215 })
  b.changed()
  assert.equal(visible.inert, false)
  // A link wrapped entirely past the cut is skipped like any hidden control.
  const wrapped = b.control(205, 230)
  wrapped.rects.push({ top: 230, bottom: 255 })
  content.controls.push(wrapped)
  b.changed()
  assert.equal(wrapped.inert, true)
  node.limit = 500
  b.changed()
  assert.ok(content.controls.every((c) => !c.inert))
  action.destroy()
})

test('nested quote and message previews cannot restore controls still hidden by the other', (t) => {
  const b = layout(t), link = b.control(300, 320)
  const outer = b.box(600, 400, [link]), inner = b.box(350, 150, [link])
  const quote = bodyPreview(inner.node, () => {})
  const message = bodyPreview(outer.node, () => {})
  b.flush()
  assert.equal(link.inert, true, 'the quote clips this link even though it fits in the message')
  outer.node.limit = 250
  b.changed()
  quote.destroy()
  assert.equal(link.inert, true, 'the message now clips it too')
  message.destroy()
  assert.equal(link.inert, false)
  assert.equal(b.observers.size, 0)
})

test('cleanup restores only its own inert state and cancels pending measurements', (t) => {
  const b = layout(t), originallyInert = b.control(300, 320, true), hidden = b.control(300, 320)
  const { node, content } = b.box(400, 200, [originallyInert, hidden])
  const action = bodyPreview(node, () => {})
  b.flush()
  content.controls = [originallyInert]
  b.changed()
  assert.equal(hidden.inert, false, 'detached controls are released too')
  for (const o of b.observers) o.fn()
  action.destroy()
  assert.equal(originallyInert.inert, true)
  assert.equal(b.frames.size, 0)
  assert.equal(b.observers.size, 0)
})

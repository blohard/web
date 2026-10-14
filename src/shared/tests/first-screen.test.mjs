import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../scripts/harness.mjs'

const { FirstScreen, screenReady } = await load('shared/first-screen.svelte.ts')
after(teardown)
const settle = () => new Promise(resolve => setImmediate(resolve))

const row = (settled, bottom) => ({ settled, bottom })
test('only a settled prefix covers the viewport and its buffer', () => {
  assert.equal(screenReady([row(true, 1200), row(false, 1300)], 800), true)
  assert.equal(screenReady([row(false, 200), row(true, 1400)], 800), false)
  assert.equal(screenReady([row(true, 600), row(false, 1300)], 800), false)
  assert.equal(screenReady([row(true, 100), row(true, 200)], 800), true, 'all rows settled')
  assert.equal(screenReady([], 800), true, 'an empty feed needs no wait')
  assert.equal(screenReady(Array.from({ length: 30 }, (_, i) => row(i < 24, (i + 1) * 50)), 800), true, 'many small folded rows')
})

function environment(t, collapsed = false) {
  const original = globalThis.window, listeners = new Map()
  globalThis.window = {
    innerHeight: 800,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  }
  const screen = new FirstScreen(collapsed)
  t.after(() => { screen.finish(); globalThis.window = original })
  return { screen, listeners }
}
const node = (order, bottom) => ({
  order, getBoundingClientRect: () => ({ bottom }),
  compareDocumentPosition: other => order > other.order ? 2 : 4,
})

test('a delayed first-screen row holds the reveal; a pending row below it does not', async t => {
  const { screen, listeners } = environment(t)
  let ready = false
  screen.row(node(2, 1700), () => false) // registration order need not be DOM order
  screen.row(node(1, 1300), () => ready)
  screen.start(); screen.mount()
  await settle()
  assert.equal(screen.waiting, true)
  ready = true; screen.changed()
  await settle()
  assert.equal(screen.waiting, false)
  assert.equal(listeners.size, 0, 'listeners stop at the reveal')
  ready = false; screen.changed(); screen.start()
  await settle()
  assert.equal(screen.waiting, false, 'a later refresh never hides the stream')
})

test('a parent arriving must let its new card register before measuring the row', async t => {
  const { screen } = environment(t)
  let parent = false, body = false
  const reads = new Set([() => parent])
  screen.row(node(1, 1300), () => [...reads].every(read => read()))
  screen.start(); screen.mount()
  await settle()
  parent = true; screen.changed()
  reads.add(() => body) // mounted by the same DOM update that removes the fallback
  await settle()
  assert.equal(screen.waiting, true)
  body = true; screen.changed()
  await settle()
  assert.equal(screen.waiting, false)
})

test('the two-second budget starts at page arrival and requires no animation frame', async t => {
  const { screen, listeners } = environment(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  screen.row(node(1, 1300), () => false)
  t.mock.timers.tick(10_000)
  assert.equal(screen.waiting, true, 'the network request has not delivered a page yet')
  screen.start(); screen.mount()
  await settle()
  t.mock.timers.tick(1999)
  assert.equal(screen.waiting, true)
  t.mock.timers.tick(1)
  assert.equal(screen.waiting, false)
  assert.equal(listeners.size, 0)
})

test('a resize remeasures the required prefix, and a retired load ignores late answers', async t => {
  const { screen, listeners } = environment(t)
  screen.row(node(1, 1000), () => true)
  screen.row(node(2, 1300), () => false)
  screen.start(); screen.mount()
  await settle()
  assert.equal(screen.waiting, true)
  window.innerHeight = 600; listeners.get('resize')()
  await settle()
  assert.equal(screen.waiting, false)
  screen.row(node(3, 1500), () => false)
  screen.changed()
  await settle()
  assert.equal(screen.waiting, false)
})

test('staged paging rows measure their combined height while taking no layout space', async t => {
  const { screen } = environment(t, true)
  // Each staging wrapper is zero-height. Its normally sized child still has
  // a measurable height, but all children temporarily begin at the same top.
  const staged = order => ({ ...node(order, 1000), getBoundingClientRect: () => ({ top: 700, bottom: 1000, height: 300 }) })
  screen.row(staged(1), () => true)
  screen.row(staged(2), () => true)
  screen.row(staged(3), () => false)
  screen.start(); screen.mount()
  await settle()
  assert.equal(screen.waiting, false, 'the first two settled rows cover the viewport and its buffer')
})

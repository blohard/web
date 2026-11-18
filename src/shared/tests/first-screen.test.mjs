import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../scripts/harness.mjs'

const { FirstScreen, screenReady } = await load('shared/first-screen.svelte.ts')
after(teardown)
const settle = () => new Promise(resolve => setImmediate(resolve))

const row = (settled, bottom) => [node(0, bottom), () => settled]
test('only a settled prefix covers the viewport and its buffer', () => {
  assert.equal(screenReady([row(true, 1200), row(false, 1300)], 800), true)
  assert.equal(screenReady([row(false, 200), row(true, 1400)], 800), false)
  assert.equal(screenReady([row(true, 600), row(false, 1300)], 800), false)
  assert.equal(screenReady([row(true, 100), row(true, 200)], 800), true, 'all rows settled')
  assert.equal(screenReady([], 800), true, 'an empty feed needs no wait')
  assert.equal(screenReady(Array.from({ length: 30 }, (_, i) => row(i < 24, (i + 1) * 50)), 800), true, 'many small folded rows')
})

function environment(t, mode = 'screen') {
  const original = globalThis.window, listeners = new Map()
  globalThis.window = {
    innerHeight: 800,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  }
  const screen = new FirstScreen(mode)
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

test('ordered rows keep the first pending position even after the screen budget expires', async t => {
  const { screen, listeners } = environment(t, 'ordered')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let first = true, second = false
  screen.row(node(3, 300), () => true)
  screen.row(node(2, 200), () => second)
  screen.row(node(1, 100), () => first)
  screen.start(); screen.mount()
  await settle()
  t.mock.timers.tick(3000)
  assert.equal(screen.shownRows, 1)
  assert.equal(listeners.size, 0)
  first = false // An interaction with a visible row cannot hide it or hold up later rows.
  second = true
  screen.changed()
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
  const { screen } = environment(t, 'paging')
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

test('an unsettled row or covered viewport stops further geometry reads', async t => {
  const { screen } = environment(t)
  let ready = false
  const measured = []
  for (let i = 0; i < 20; i++) {
    screen.row({ ...node(i, 0), getBoundingClientRect() {
      measured.push(i)
      return { top: i * 600, bottom: (i + 1) * 600, height: 600 }
    } }, () => i > 0 || ready)
  }
  screen.mount()
  await settle()
  assert.equal(screen.waiting, true)
  assert.deepEqual(measured, [])
  ready = true
  screen.changed()
  await settle()
  assert.equal(screen.waiting, false)
  assert.deepEqual(measured, [0, 1])
})

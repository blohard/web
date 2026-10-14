import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../../scripts/harness.mjs'

const { burstCount, particles, burstKeys, sendCount, trail, sendKeys, sellCount, rise, sellKeys } = await load('features/keys/key-burst.ts')
after(teardown)

test('bigger purchases throw more keys, within bounds', () => {
  assert.deepEqual([1n, 2n, 10n, 11n, 1000n].map(burstCount), [6, 7, 15, 16, 16])
})

test('keys fan upward and every one moves', () => {
  let n = 0
  const seeded = () => (n = (n * 9301 + 49297) % 233280) / 233280
  for (const p of particles(16, seeded)) {
    assert.ok(p.dy < 0, 'every key starts upward')
    assert.ok(Math.hypot(p.dx, p.dy) >= 90)
    assert.ok(p.fall > 0 && p.delay >= 0 && p.size > 0)
  }
  const sides = particles(16, seeded).map(p => Math.sign(p.dx))
  assert.ok(sides.includes(-1) && sides.includes(1), 'both sides of the button')
})

test('no document means no burst', () => {
  assert.equal(globalThis.window, undefined)
  assert.doesNotThrow(() => burstKeys({}, 1n))
  assert.doesNotThrow(() => sendKeys({}, 1n))
  assert.doesNotThrow(() => sellKeys({}, 1n))
})

test('a sale raises a few more ETH diamonds for bigger sales', () => {
  assert.deepEqual([1n, 2n, 6n, 7n, 1000n].map(sellCount), [4, 5, 9, 9, 9])
})

test('ETH diamonds rise to either side of the button, one shortly after another', () => {
  let n = 0
  const seeded = () => (n = (n * 9301 + 49297) % 233280) / 233280
  const diamonds = rise(9, seeded)
  const sides = diamonds.map((p) => Math.sign(p.dx))
  assert.ok(sides.includes(-1) && sides.includes(1), 'both sides')
  diamonds.forEach((p, i) => {
    assert.ok(p.dy <= -110, 'every diamond rises')
    assert.ok(Math.abs(p.dx) < 90, 'close to the button')
    assert.ok(Math.abs(p.spin) <= 15 && p.fall === 0 && p.size > 0)
    if (i) assert.ok(p.delay > diamonds[i - 1].delay - 40, 'in order, give or take a little')
  })
})

test('a transfer sees off a few keys, fewer than a purchase', () => {
  assert.deepEqual([1n, 2n, 6n, 7n, 1000n].map(sendCount), [3, 4, 8, 8, 8])
  for (const amount of [1n, 6n, 1000n]) assert.ok(sendCount(amount) < burstCount(amount))
})

test('sent keys leave up and to the right, one after another, pointing where they go', () => {
  let n = 0
  const seeded = () => (n = (n * 9301 + 49297) % 233280) / 233280
  const keys = trail(8, seeded)
  keys.forEach((p, i) => {
    assert.ok(p.dx > 0 && p.dy < 0, 'up and to the right')
    assert.ok(Math.hypot(p.dx, p.dy) >= 220)
    assert.equal(p.fall, 0, 'sent keys do not drop')
    const heading = Math.atan2(p.dy, p.dx) * 180 / Math.PI
    assert.ok(Math.abs(p.spin - (heading + 45)) < 1e-9, 'each key points along its path')
    if (i) assert.ok(p.delay > keys[i - 1].delay, 'they leave in order')
  })
})

test('a failing burst never escapes into the purchase that triggered it', () => {
  const saved = { window: globalThis.window, Element: globalThis.Element }
  try {
    globalThis.window = { matchMedia: () => ({ matches: false }) }
    globalThis.Element = class { animate() {} }
    const origin = { getBoundingClientRect() { throw new Error('detached') } }
    assert.doesNotThrow(() => burstKeys(origin, 3n))
    assert.doesNotThrow(() => sendKeys(origin, 3n))
    assert.doesNotThrow(() => sellKeys(origin, 3n))
  } finally {
    globalThis.window = saved.window
    globalThis.Element = saved.Element
  }
})

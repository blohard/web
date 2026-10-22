import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expectStable } from '../tests/ui/layout-watch.mjs'

const steady = { y: 100, height: 80 }
test('layout checks allow initial hidden frames and subpixel rounding', () => {
  expectStable([[null], [steady], [{ y: 100.5, height: 80.5 }], [steady]], [1])
})
test('layout checks catch a single bad frame even when the final frame recovers', () => {
  for (const bad of [{ y: 110, height: 80 }, { y: 100, height: 20 }, null]) {
    assert.throws(() => expectStable([[steady], [bad], [steady]], [1]))
  }
})
test('layout checks require the target to have appeared', () => {
  assert.throws(() => expectStable([[null], [null], [null]], [1]))
})

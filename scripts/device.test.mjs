import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from './harness.mjs'

const { isMobile } = await load('lib/device.ts')
after(teardown)

test('phones are recognised by user agent, and anything without a navigator is not one', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  try {
    for (const [agent, touch, expected] of [
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128 Mobile', 5, true],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5, true],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5, true], // an iPad asking for desktop pages
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0, false],
      ['Mozilla/5.0 (X11; Linux x86_64) Chrome/128', 0, false],
    ]) {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: agent, maxTouchPoints: touch } })
      assert.equal(isMobile(), expected, agent)
    }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined })
    assert.equal(isMobile(), false)
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved)
  }
})

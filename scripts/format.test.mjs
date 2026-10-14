import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { parseEther } from 'viem'
import { load, teardown } from './harness.mjs'
const { ethAmount } = await load('lib/format.ts')
after(teardown)

test('key prices read as three significant digits in ordinary decimals', () => {
  // Key 1, 10, 100 and 1,000 on the market's curve, then small and large amounts.
  assert.equal(ethAmount(10_400_000_000_000n), '0.0000104')
  assert.equal(ethAmount(39_300_000_000_000n), '0.0000393')
  assert.equal(ethAmount(1_003_000_000_000_000n), '0.001')
  assert.equal(ethAmount(32_000_000_000_000_000n), '0.032')
  assert.equal(ethAmount(468_320_432_131_238n), '0.000468')
  assert.equal(ethAmount(12_700_000_000_000_000_000n), '12.7')
  assert.equal(ethAmount(0n), '0')
  assert.equal(ethAmount(104n), '0.000000000000000104', 'even tiny amounts use ordinary decimals')
  assert.throws(() => ethAmount(-1n), RangeError)
})

test('bounds round so the shown figure stays true', () => {
  assert.equal(ethAmount(1_003_000_000_000_000n, 'up'), '0.00101', 'a payment is never more than shown')
  assert.equal(ethAmount(1_003_000_000_000_000n, 'down'), '0.001', 'proceeds are never less than shown')
  assert.equal(ethAmount(999_999_999_999_999_999n, 'up'), '1')
  assert.equal(ethAmount(999_999_999_999_999_999n, 'down'), '0.999')
  assert.equal(ethAmount(10_450_000_000_000n), '0.0000105', 'a price rounds half up to nearest')
  assert.equal(ethAmount(10_449_999_999_999n), '0.0000104')
})

test('every amount reads back within three significant digits on the safe side', () => {
  const amounts = [0n, 1n, 999n, 1000n, 1001n, (1n << 256n) - 1n]
  for (let digits = 1n; digits <= 77n; digits++) {
    const power = 10n ** digits
    amounts.push(power - 1n, power, power + 1n, power * 5n - 1n, power * 5n)
  }
  for (const amount of amounts) {
    const unit = 10n ** BigInt(Math.max(0, amount.toString().length - 3))
    const upper = parseEther(ethAmount(amount, 'up'))
    const lower = parseEther(ethAmount(amount, 'down'))
    const nearest = parseEther(ethAmount(amount))
    assert.ok(upper >= amount && upper - amount < unit, `up ${amount}`)
    assert.ok(lower <= amount && amount - lower < unit, `down ${amount}`)
    assert.ok((nearest > amount ? nearest - amount : amount - nearest) * 2n <= unit, `nearest ${amount}`)
  }
})

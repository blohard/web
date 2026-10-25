import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../scripts/harness.mjs'
const { wireAddress, wireHash, uint32, uint64 } = await load('shared/wire-values.ts')
const { integer } = await load('lib/api.ts')
after(teardown)

test('wire hex validators accept either casing without normalizing or accepting malformed lengths', () => {
  for (const [check, size] of [[wireAddress, 40], [wireHash, 64]]) {
    for (const digit of ['a', 'A', '0']) assert.equal(check('0x' + digit.repeat(size)), true)
    for (const value of [null, undefined, {}, 1, '0x', '0X' + 'a'.repeat(size), '0x' + 'g'.repeat(size),
      '0x' + 'a'.repeat(size - 1), '0x' + 'a'.repeat(size + 1)]) assert.equal(check(value), false)
  }
})

test('wire integers enforce their representation and exact unsigned bounds before bigint conversion', t => {
  for (const value of [0, 1, 0xffff_ffff]) assert.equal(uint32(value), true)
  for (const value of [null, undefined, {}, '1', 1n, -1, 1.5, NaN, Infinity, 2 ** 32]) assert.equal(uint32(value), false)
  for (const value of ['0', '1', '18446744073709551615']) assert.equal(uint64(value), true)
  for (const value of [null, undefined, {}, 0, 1n, '', '00', '01', '-1', '+1', '1.0', '1e2', ' 1', '18446744073709551616']) assert.equal(uint64(value), false)
  t.mock.method(globalThis, 'BigInt', () => assert.fail('oversized integer reached bigint conversion'))
  assert.equal(uint64('1'.repeat(10_000)), false)
  assert.throws(() => integer('1'.repeat(10_000)), /exceeds uint64/)
})

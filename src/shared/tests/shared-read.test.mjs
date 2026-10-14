import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sharedRead } from '../shared-read.ts'

test('one outstanding read per key, released on success and on failure', async () => {
  const flights = new Map()
  let release, calls = 0
  const read = () => { calls++; return new Promise((resolve) => { release = resolve }) }
  const first = sharedRead(flights, 'parent', read)
  assert.equal(sharedRead(flights, 'parent', read), first)
  assert.equal(calls, 1)
  assert.equal(await sharedRead(flights, 'other', async () => 'other'), 'other')
  release('parent')
  assert.equal(await first, 'parent')
  assert.equal(flights.size, 0)
  await assert.rejects(sharedRead(flights, 'parent', async () => { throw new Error('offline') }), /offline/)
  assert.equal(flights.size, 0)
  assert.equal(await sharedRead(flights, 'parent', async () => 'retry'), 'retry')
})

test('cleanup never removes a replacement flight', async () => {
  const flights = new Map()
  let release
  const first = sharedRead(flights, 'key', () => new Promise((resolve) => { release = resolve }))
  const replacement = Promise.resolve('replacement')
  flights.set('key', replacement)
  release('first')
  assert.equal(await first, 'first')
  assert.equal(flights.get('key'), replacement)
})

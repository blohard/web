import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { load, teardown, txHash } from '../../../../scripts/harness.mjs'
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
let storageChanged
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  addEventListener: (type, listener) => { if (type === 'storage') storageChanged = listener },
} })
const { keyTransaction } = await load('features/keys/key-transaction.svelte.ts')
const { trackedTransaction } = await load('lib/tracked-transaction.svelte.ts')
// The tracker listens from its first use, so the stub stays for the whole file.
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else delete globalThis.window
})
after(teardown)

test('a late receipt cannot clear a newer transaction for the same market', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const saved = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  } })
  try {
    const first = keyTransaction('market-one')
    const secondHash = '0x' + 'cd'.repeat(32)
    first.save(txHash)
    first.clear()
    first.save(secondHash)
    first.finish(txHash)
    assert.equal(first.hash, secondHash)
    assert.equal(JSON.parse(saved.get('market-one')), secondHash)
    first.finish(secondHash)
    assert.equal(first.hash, null)
    assert.equal(saved.has('market-one'), false, 'settled transactions leave no storage entry')
    assert.equal(keyTransaction('market-one'), first)
    assert.equal(keyTransaction('market-two').hash, null)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  }
})


test('other-tab saves are adopted, but clears and unrelated storage cannot discard a pending hash', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const stored = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value),
    removeItem: key => stored.delete(key),
  } })
  try {
    const tracker = keyTransaction('other-tab-market')
    const send = (newValue, storageArea = localStorage, key = tracker.key) => storageChanged({ key, newValue, storageArea })
    send(JSON.stringify(txHash), {})
    assert.equal(tracker.hash, null, 'ignore session storage')
    send('bad json'); send(JSON.stringify('bad hash'))
    send(JSON.stringify(txHash), localStorage, 'another-key')
    assert.equal(tracker.hash, null)
    stored.set(tracker.key, JSON.stringify(txHash)); send(JSON.stringify(txHash))
    assert.equal(tracker.hash, txHash)
    send(null); send('null'); send(null, localStorage, null)
    assert.equal(tracker.hash, txHash, 'remote clears are not settlement evidence')
    const other = '0x' + 'ef'.repeat(32)
    stored.set(tracker.key, JSON.stringify(other)); send(JSON.stringify(other))
    assert.equal(tracker.hash, txHash, 'keep the transaction this tab is already tracking')
    tracker.finish(txHash)
    assert.equal(tracker.hash, other, 'finishing our transaction retains the other tab’s hash')
    assert.equal(JSON.parse(stored.get(tracker.key)), other)
    tracker.finish(other)
    assert.equal(tracker.hash, null)
    assert.equal(stored.has(tracker.key), false)
    stored.set(tracker.key, JSON.stringify(txHash)); tracker.sync()
    assert.equal(tracker.hash, txHash, 'refresh catches a missed storage event')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  }
})

test('an old release cannot unlock a newer operation', () => {
  const tracker = keyTransaction('in-flight-market')
  const release = tracker.acquire()
  assert.equal(tracker.busy, true)
  assert.equal(tracker.acquire(), null)
  release()
  const next = tracker.acquire()
  release()
  assert.equal(tracker.busy, true)
  next()
  assert.equal(tracker.busy, false)
})

test('a tracked transaction settles its owner before telling listeners, with the value it confirmed', () => {
  const order = []
  const tracked = trackedTransaction('tracked-one', () => order.push('settled'))
  tracked.onConfirmed((value) => order.push(`heard ${value}`))
  tracked.confirm(txHash, 'receipt')
  assert.deepEqual(order, ['settled', 'heard receipt'])
  assert.equal(trackedTransaction('tracked-one', () => order.push('ignored')), tracked, 'one tracker per key')
  const plain = trackedTransaction('tracked-two')
  plain.confirm(txHash)
  assert.equal(plain.hash, null)
})


test('a failed explicit clear preserves the pending transaction and can be retried', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const stored = new Map()
  let blocked = true
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: key => { if (blocked) throw new Error('storage denied'); stored.delete(key) },
  } })
  try {
    const tracker = trackedTransaction('clear-denied')
    tracker.save(txHash)
    assert.throws(() => tracker.clear(), /could not clear/)
    assert.equal(tracker.hash, txHash)
    assert.equal(JSON.parse(stored.get(tracker.key)), txHash)
    blocked = false
    tracker.clear()
    assert.equal(tracker.hash, null)
    assert.equal(tracker.saved, true)
    assert.equal(stored.has(tracker.key), false)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  }
})

import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { load, teardown, address } from '../../../../scripts/harness.mjs'
const { KeyringView } = await load('features/streams/keyring-view.svelte.ts')
after(teardown)
const alice = address('22'), bob = address('33')

test('quiet membership changes cue refresh without changing displayed authors', () => {
  const view = new KeyringView('wallet/market')
  view.observe({ truncated: { holders: false, holding: false }, active: true, holders: [alice], holding: [bob] }, true)
  const shown = view.shown
  view.observe({ truncated: { holders: false, holding: false }, active: true, holders: [bob], holding: [bob] }, false)
  assert.equal(view.shown, shown)
  assert.deepEqual(view.shown.holders, [alice])
  assert.equal(view.changed('holders'), true)
  assert.equal(view.changed('holding'), false)
  view.observe({ truncated: { holders: false, holding: false }, active: true, holders: [alice], holding: [bob] }, false)
  assert.equal(view.changed('holders'), false, 'a reverted membership change needs no refresh')
  view.observe({ truncated: { holders: false, holding: false }, active: true, holders: [bob], holding: [bob] }, true)
  assert.deepEqual(view.shown.holders, [bob])
  assert.equal(view.changed('holders'), false)
})

test('selling the last holding preserves the snapshot until refresh then applies an empty keyring', () => {
  const view = new KeyringView('wallet/market')
  view.observe({ truncated: { holders: false, holding: false }, active: false, holders: [], holding: [alice] }, true)
  const empty = { truncated: { holders: false, holding: false }, active: false, holders: [], holding: [] }
  view.observe(empty, false)
  assert.equal(view.available, false)
  assert.deepEqual(view.shown.holding, [alice])
  assert.equal(view.changed('holding'), true)
  view.observe(empty, true)
  assert.deepEqual(view.shown.holding, [])
  assert.equal(view.changed('holding'), false)
})

test('wallet or market changes do not inherit another identity snapshot', () => {
  const previous = new KeyringView('first')
  previous.observe({ truncated: { holders: false, holding: false }, active: true, holders: [alice], holding: [bob] }, true)
  const next = new KeyringView('second')
  assert.equal(next.shown, null)
  assert.equal(next.available, false)
  assert.equal(next.changed('holders'), false)
  previous.observe({ truncated: { holders: false, holding: false }, active: true, holders: [], holding: [] }, false)
  assert.equal(next.latest, null)
})

test('activation and newly purchased keys can reveal availability without moving the current view', () => {
  const view = new KeyringView('wallet/market')
  view.observe({ truncated: { holders: false, holding: false }, active: false, holders: [], holding: [] }, true)
  view.observe({ truncated: { holders: false, holding: false }, active: false, holders: [], holding: [alice] }, false)
  assert.equal(view.available, true)
  assert.deepEqual(view.shown.holding, [])
  view.observe({ truncated: { holders: false, holding: false }, active: true, holders: [], holding: [] }, false)
  assert.equal(view.available, true)
  assert.equal(view.shown.active, false)
  assert.equal(view.changed('holders'), true)
})


test('a truncation-only change highlights refresh and applies its notice only on refresh', () => {
  const view = new KeyringView('wallet/market')
  const complete = { active: true, holders: [alice], holding: [bob], truncated: { holders: false, holding: false } }
  view.observe(complete, true)
  const partial = { ...complete, truncated: { holders: true, holding: false } }
  view.observe(partial, false)
  assert.equal(view.changed('holders'), true)
  assert.equal(view.changed('holding'), false)
  assert.equal(view.shown.truncated.holders, false)
  view.observe(partial, true)
  assert.equal(view.changed('holders'), false)
  assert.equal(view.shown.truncated.holders, true)
  view.observe(complete, false)
  assert.equal(view.changed('holders'), true)
})

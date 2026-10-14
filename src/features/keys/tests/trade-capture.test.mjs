// The trade a key market page sent stands in for the live quote only while it is that page's own transaction.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown, hash } from '../../../../scripts/harness.mjs'
const { TradeCapture } = await load('features/keys/trade-capture.svelte.ts')
after(teardown)

const buy5 = { side: 'buy', amount: 5n }
const ours = hash('a1'), theirs = hash('b2')

test('a sent trade shows while it is sent and while its own transaction is pending', () => {
  const capture = new TradeCapture()
  assert.equal(capture.shown(null), null, 'nothing is captured before a send')
  capture.begin(buy5)
  assert.equal(capture.shown(null), buy5, 'shown while the wallet prompt is open, before any hash')
  capture.sent(ours)
  assert.equal(capture.shown(ours), buy5, 'and while its transaction is pending')
  capture.end()
  assert.equal(capture.shown(ours), buy5, 'a send that stopped waiting still owns its pending transaction')
  assert.equal(capture.shown(null), null, 'once it settles, the live quote shows again')
})

test('another tab\'s transaction never shows the trade this page sent earlier', () => {
  const capture = new TradeCapture()
  capture.begin(buy5); capture.sent(ours); capture.end()
  assert.equal(capture.shown(theirs), null, 'a later trade from another tab is not this one')
})

test('a send refused before any hash leaves nothing to show for later transactions', () => {
  const capture = new TradeCapture()
  capture.begin(buy5); capture.end()
  assert.equal(capture.shown(theirs), null)
  assert.equal(capture.shown(null), null)
  capture.begin(null)
  assert.equal(capture.shown(null), null, 'a claim captures no trade')
})


test('confirmation ownership includes claims and never adopts another transaction', () => {
  const capture = new TradeCapture()
  assert.equal(capture.owns(theirs), false, 'recovery has no captured action')
  capture.begin(buy5); capture.sent(ours); capture.end()
  assert.equal(capture.owns(ours), true, 'a late confirmation still belongs to its original trade')
  assert.equal(capture.owns(theirs), false)
  capture.begin(null); capture.sent(theirs); capture.end()
  assert.equal(capture.owns(theirs), true, 'claims own their hash despite capturing no quote')
  assert.equal(capture.owns(ours), false)
})

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, mock, replyArgs, address, author, authorGateChanged, txHash, response } from '../../../../scripts/host-harness.mjs'
const { saveAuthorGate } = await load('features/account/author-gate.ts')
const { pressBlock, enforceBlocks } = await load('features/account/blocking.ts')
const { accountActions } = await load('features/account/account-actions.svelte.ts')
const { gates } = await load('lib/gates.svelte.ts')
const { TOMBSTONE } = await load('lib/board.ts')
beforeEach(install)
after(teardown)

test('an account change whose receipt never came holds every account write until a check finds it', async () => {
  const { wallet } = replyArgs()
  assert.equal(wallet.account, author)
  authorGateChanged(author, TOMBSTONE, 12n)
  const fetch = globalThis.fetch
  let lost = true
  globalThis.fetch = async (url, init) => lost && String(url).includes('/transaction/') ? response({ error: 'internal' }, 500) : fetch(url, init)
  try {
    await assert.rejects(saveAuthorGate(wallet, mock.chain, author, 'deactivated'))
    assert.equal(accountActions.unsettled(mock.chain, author), txHash, 'the hash is kept')
    await assert.rejects(pressBlock(wallet, mock.chain, address('99'), true), /may still land/)
    await assert.rejects(saveAuthorGate(wallet, mock.chain, author, 'deactivated'), /may still land/)
    assert.equal(mock.calls.filter(c => c.method === 'eth_sendTransaction').length, 1, 'never sent twice')
    lost = false
    assert.equal(await accountActions.check(mock.chain, author), 'landed')
    assert.equal(gates.author(mock.chain, author), TOMBSTONE, 'the landed gate shows')
    assert.equal(accountActions.unsettled(mock.chain, author), null)
  } finally { globalThis.fetch = fetch }
})

test('a block that stopped after its list write can be finished, and only where no rule was chosen', async () => {
  const { wallet } = replyArgs()
  mock.authorGate = '0x0000000000000000000000000000000000000000'
  authorGateChanged(author, mock.chain.blocking.gate, 14n)
  mock.authorGate = '0x0000000000000000000000000000000000000000'
  assert.equal(await enforceBlocks(wallet, mock.chain), 'set')
  assert.equal(gates.author(mock.chain, author), mock.chain.blocking.gate)
  const sends = mock.calls.filter(c => c.method === 'eth_sendTransaction').length
  assert.equal(sends, 1, 'one transaction, the gate only')
  mock.authorGate = address('77')
  await assert.rejects(enforceBlocks(wallet, mock.chain), /already/)
  assert.equal(mock.calls.filter(c => c.method === 'eth_sendTransaction').length, sends, 'a chosen rule is never replaced')
})

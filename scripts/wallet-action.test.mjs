import assert from 'node:assert/strict'
import { test, beforeEach, after } from 'node:test'
import { load, install, teardown, mock, replyArgs, author, address } from './host-harness.mjs'
const { captureWallet } = await load('lib/wallet-action.ts')
const { moderate } = await load('features/messages/moderation.ts')
const { saveAuthorGate } = await load('features/account/author-gate.ts')
const { savePostReplyGate } = await load('features/account/post-reply-rule.ts')
const { pressBlock } = await load('features/account/blocking.ts')
beforeEach(install)
after(teardown)

const actions = {
  delete: w => moderate(w, mock.chain, 9n, 'delete'),
  remove: w => moderate(w, mock.chain, 9n, 'remove'),
  'account rule': w => saveAuthorGate(w, mock.chain, author, 'all'),
  deactivate: w => saveAuthorGate(w, mock.chain, author, 'deactivated'),
  'post rule': w => savePostReplyGate(w, mock.chain, { id: 9n, parentId: 0n, author }, mock.chain.blocking.gate),
  block: w => pressBlock(w, mock.chain, address('99'), true),
  unblock: w => pressBlock(w, mock.chain, address('99'), false),
}
for (const [name, action] of Object.entries(actions)) {
  for (const change of ['account', 'provider', 'disconnect']) {
    test(`${name} refuses a ${change} during the network switch`, async () => {
      const { wallet } = replyArgs()
      wallet.ensureChain = async () => {
        if (change === 'account') wallet.account = address('88')
        if (change === 'disconnect') wallet.account = null
        if (change === 'provider') wallet.provider = { request: async () => assert.fail('replacement provider used') }
      }
      if (name === 'block' || name === 'unblock') assert.deepEqual(await action(wallet), { kind: 'switched' })
      else await assert.rejects(action(wallet), /wallet.*changed/)
      assert.equal(mock.calls.some(c => c.method === 'eth_sendTransaction'), false)
    })
  }
}

test('capturing a wallet keeps its original identity and can be checked more than once', () => {
  const { wallet } = replyArgs()
  wallet.account = address('ab')
  const pressed = captureWallet(wallet)
  assert.equal(pressed.current(), true)
  wallet.account = '0x' + 'AB'.repeat(20)
  assert.equal(pressed.current(), true, 'address casing does not change the account')
  wallet.account = address('77')
  assert.equal(pressed.current(), false)
  assert.equal(pressed.account, address('ab'))
  wallet.account = null
  assert.equal(captureWallet(wallet), null)
})

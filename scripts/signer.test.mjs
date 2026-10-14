import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, mock, teardown } from './harness.mjs'
const { assertActive, guarded } = await load('lib/signer.ts')
after(teardown)

const alice = '0x' + 'a1'.repeat(20), bob = '0x' + 'b0'.repeat(20)
const fake = (accounts) => {
  const asked = []
  return { asked, provider: { on() {}, removeListener() {}, request: async ({ method }) => { asked.push(method); if (method === 'eth_accounts') return accounts; return 'ok' } } }
}

for (const method of ['eth_sendTransaction', 'wallet_sendTransaction']) {
  test(`${method} waits for saved recovery after checking the account`, async () => {
    const { asked, provider } = fake([alice])
    let release, started
    const saving = new Promise((r) => { release = r })
    const entered = new Promise((r) => { started = r })
    const wallet = guarded(provider, alice, async () => { started(); await saving })
    const flight = wallet.request({ method, params: [{}] })
    await entered
    assert.deepEqual(asked, ['eth_accounts'], 'no send while the recovery write is in flight')
    release()
    await flight
    assert.deepEqual(asked, ['eth_accounts', method])
    await assert.rejects(guarded(provider, bob, async () => assert.fail('must check account before saving')).request({ method, params: [{}] }))
  })
}

test('a signing request is refused when the wallet is on another account or names none', async () => {
  for (const [accounts, message] of [[[bob], /different account than the one connected here/], [[], /reports no connected account/], ['0x1234', /reports no connected account/]]) {
    const { asked, provider } = fake(accounts)
    await assert.rejects(guarded(provider, alice).request({ method: 'eth_sendTransaction', params: [{}] }), message)
    assert.deepEqual(asked, ['eth_accounts'], 'the signing request never reached the wallet')
  }
})

test('the check runs at each signing request, not before, and reads pass through', async () => {
  const { asked, provider } = fake([alice.toUpperCase().replace('0X', '0x')])
  const wallet = guarded(provider, alice)
  assert.equal(await wallet.request({ method: 'eth_chainId' }), 'ok')
  assert.deepEqual(asked, ['eth_chainId'], 'a read asks nothing extra')
  assert.equal(await wallet.request({ method: 'eth_signTypedData_v4', params: [] }), 'ok')
  assert.deepEqual(asked, ['eth_chainId', 'eth_accounts', 'eth_signTypedData_v4'])
  await assert.doesNotReject(assertActive(provider, alice))
  void mock
})

test('viem network reads time out before signing and a late answer cannot send', async t => {
  const { signerFor } = await load('lib/signer.ts')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release, sends = 0
  const stalled = new Promise(resolve => { release = resolve })
  const provider = { request: async ({ method }) => {
    if (method === 'eth_chainId') return stalled
    if (method === 'eth_accounts') return [alice]
    sends++; return '0x' + '11'.repeat(32)
  } }
  const signer = await signerFor(provider, alice, { ...mock.chain, id: 84532 })
  const failed = assert.rejects(signer.sendTransaction({ to: bob, value: 1n }), /wallet.*timed out/)
  await new Promise(setImmediate)
  t.mock.timers.tick(6000)
  await failed
  release('0x14a34')
  await new Promise(setImmediate)
  assert.equal(sends, 0)
})

test('wallet approval prompts remain open beyond the quick-read timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release, done = false
  const approval = new Promise(resolve => { release = resolve })
  const provider = { request: async ({ method }) => method === 'eth_accounts' ? [alice] : approval }
  const flight = guarded(provider, alice).request({ method: 'eth_sendTransaction', params: [{}] }).then(() => { done = true })
  await new Promise(setImmediate)
  t.mock.timers.tick(60_000)
  assert.equal(done, false)
  release('ok'); await flight
})

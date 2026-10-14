import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, author, mock } from './harness.mjs'
const { passkeyWallet } = await load('lib/coinbase.ts')
const { host } = await load('lib/host.svelte.ts')
beforeEach(install)
after(teardown)

test('Coinbase explicitly selects passkeys, disables telemetry and uses the standard provider', async t => {
  const old = host.status
  host.status = { chains: [mock.chain] }
  t.after(() => { host.status = old })
  const calls = []
  let options
  const provider = {
    on() {},
    async request(request) { calls.push(request.method); return [author] },
    async disconnect() { calls.push('disconnect') },
  }
  const remote = await passkeyWallet(config => { options = config; return { getProvider: () => provider } })
  assert.equal(options.preference.options, 'smartWalletOnly', 'never start the unresponsive mobile pairing flow')
  assert.equal(options.preference.telemetry, false)
  assert.equal(options.appLogoUrl, 'https://client.invalid/favicon.png')
  assert.ok(options.appChainIds.includes(mock.chain.id))
  assert.ok(options.appChainIds.includes(84532), 'restoration before host status loads')
  assert.equal(remote.provider, provider, 'keep the existing signing and transaction paths')
  assert.deepEqual(calls, [], 'initializing never asks to connect')
  assert.deepEqual(await remote.connect(mock.chain), [author])
  await remote.disconnect()
  assert.deepEqual(calls, ['eth_requestAccounts', 'disconnect'])
})

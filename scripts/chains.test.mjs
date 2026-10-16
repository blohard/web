import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown, mock, author } from './harness.mjs'

const { toViemChain } = await load('lib/chains.ts')
const { explain } = await load('lib/errors.ts')
const { Wallet } = await load('lib/wallet.svelte.ts')
const { keyDeployment } = await load('features/keys/account-keys-config.ts')
beforeEach(install)
after(teardown)

const exampleChain = () => ({ ...mock.chain, id: 424242, name: 'Example Chain', public_rpc_url: 'https://rpc.example.invalid', native_currency: { name: 'COIN', symbol: 'COIN', decimals: 18 } })

test('chain definitions use configured native currency, including non-18 decimals', () => {
  assert.deepEqual(toViemChain(exampleChain()).nativeCurrency, exampleChain().native_currency)
  const currency = { name: 'Example coin', symbol: 'COIN', decimals: 6 }
  assert.deepEqual(toViemChain({ ...exampleChain(), native_currency: currency }).nativeCurrency, currency)
  assert.deepEqual(toViemChain(mock.chain).nativeCurrency, { name: 'Ether', symbol: 'ETH', decimals: 18 }, 'older hosts default to ETH')
})

test('adding a network to a wallet uses its configured gas token', async () => {
  let current = '0x1', added
  const provider = { on: () => {}, request: async ({ method, params }) => {
    if (method === 'eth_accounts') return [author]
    if (method === 'eth_chainId') return current
    if (method === 'eth_blockNumber') return '0x10'
    if (method === 'wallet_switchEthereumChain') {
      if (!added) throw Object.assign(new Error('unknown chain'), { code: 4902 })
      current = params[0].chainId
      return null
    }
    if (method === 'wallet_addEthereumChain') { added = params[0]; return null }
    throw new Error(`unexpected ${method}`)
  } }
  const wallet = new Wallet(provider)
  await wallet.ensureChain(exampleChain(), 'required')
  assert.equal(added.chainId, '0x67932')
  assert.equal(added.chainName, 'Example Chain')
  assert.deepEqual(added.nativeCurrency, exampleChain().native_currency)
  assert.deepEqual(added.rpcUrls, ['https://rpc.example.invalid/'])
})

test('gas errors do not assume ETH or direct mainnet users to a faucet', () => {
  const message = explain(new Error('insufficient funds for gas * price + value'))
  assert.match(message, /gas/)
  assert.doesNotMatch(message, /ETH|ether|faucet|no funds/)
})

test('configuring a gas token does not enable AccountKeys on that chain', () => {
  const env = { VITE_ACCOUNT_KEYS_ADDRESS: author, VITE_ACCOUNT_KEYS_DEV_FUND: author }
  assert.equal(keyDeployment(exampleChain(), env), null)
})

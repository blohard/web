// Optional market integration. Nothing here changes Board posting or sponsorship.
import { TransactionReceiptNotFoundError, isAddress, getAddress, zeroAddress, parseEventLogs, type TransactionReceipt, type Address, type Hex } from 'viem'
import { ACCOUNT_KEYS_CHAINS, type KeyDeployment } from './account-keys-config'
export { ACCOUNT_KEYS_CHAINS, keyDeployment } from './account-keys-config'
import { accountKeysAbi } from '../../lib/abi/accountKeys'
import { keyRpc, keyReadRpc } from './key-rpc'
import { pendingInterval } from '../../lib/pending-interval'
import { chainLabel } from '../../lib/chains'
import { sameAddress } from '../../lib/format'
import { signerFor } from '../../lib/signer'
import { MAX_KEY_SUPPLY } from './key-curve'
import type { ChainInfo, Eip1193Provider } from '../../lib/types'
import { withTimeout } from '../../shared/with-timeout'

export class KeyActivationReverted extends Error {
  constructor() { super('activation transaction reverted. refresh before trying again') }
}

export class KeyTransactionReverted extends Error {
  constructor() { super('the transaction reverted. check its details in your wallet before trying again') }
}

export function tradeKeyAmount(text: string): bigint {
  const amount = initialKeyAmount(text)
  if (amount === 0n) throw new Error('choose at least one key')
  return amount
}

export type KeyQuote = { curveValue: bigint; creatorFee: bigint; devFee: bigint; total: bigint }
const verifiedMarkets = new Map<string, Promise<void>>()

// Recent account views share a minimum block across navigation and RPC changes.
// Remember receipts even when their state read fails, but never cache balances.
const accountBlocks = new Map<string, bigint>()
function rememberBlock(key: string, block: bigint): bigint {
  const known = accountBlocks.get(key)
  const latest = known !== undefined && known > block ? known : block
  accountBlocks.delete(key)
  accountBlocks.set(key, latest)
  if (accountBlocks.size > 256) accountBlocks.delete(accountBlocks.keys().next().value!)
  return latest
}

export type KeyAccount = { blockNumber: bigint; active: boolean; supply: bigint; holdings: bigint; fees: bigint }

export function initialKeyAmount(text: string): bigint {
  text = text.trim()
  if (!/^(0|[1-9][0-9]{0,9})$/.test(text) || BigInt(text) > MAX_KEY_SUPPLY) {
    throw new Error('enter a whole number of keys')
  }
  return BigInt(text)
}

export function keyMarket(chain: ChainInfo, deployment: KeyDeployment) {
  if (!ACCOUNT_KEYS_CHAINS.some(id => id === chain.id)) throw new Error('account keys are only available on Base and Base Sepolia')
  const rpc = () => keyReadRpc(chain, deployment.rpcUrl)
  const contract = { address: deployment.address, abi: accountKeysAbi } as const

  /** Display reads reuse successful checks. Every signing path requests a fresh check. */
  function verify({ cached = false } = {}, client = rpc()): Promise<void> {
    const key = JSON.stringify([chain.id, client.uid, deployment.address.toLowerCase(), deployment.devFund.toLowerCase()])
    const known = verifiedMarkets.get(key)
    if (cached && known) return known
    const checked = checkDeployment(client).catch(error => {
      if (verifiedMarkets.get(key) === checked) verifiedMarkets.delete(key)
      throw error
    })
    if (verifiedMarkets.size >= 64) verifiedMarkets.delete(verifiedMarkets.keys().next().value!)
    verifiedMarkets.set(key, checked)
    return checked
  }

  async function checkDeployment(client: ReturnType<typeof rpc>) {
    if (await client.getChainId() !== chain.id) throw new Error('the account-key RPC is on the wrong chain')
    const code = await client.getCode({ address: deployment.address })
    if (!code || code === '0x') throw new Error('the account-key market has not been deployed at its configured address')
    // One RPC read for these sender-independent views avoids public endpoint burst limits.
    // Deployless multicall runs only inside eth_call, with no transaction or helper deployment.
    const [dev, creatorFee, devFee, anchor] = await client.multicall({
      deployless: true, allowFailure: false,
      contracts: [
        { ...contract, functionName: 'DEV_FUND' },
        { ...contract, functionName: 'CREATOR_FEE_BPS' },
        { ...contract, functionName: 'DEV_FEE_BPS' },
        // 10,000 outstanding keys are backed by exactly 4,000.1 ETH on this curve.
        { ...contract, functionName: 'reserveAt', args: [10_000n] },
      ],
    })
    if (!sameAddress(dev, deployment.devFund) || creatorFee !== 450n || devFee !== 50n || anchor !== 40001n * 10n ** 17n) {
      throw new Error('the account-key market does not match this deployment configuration')
    }
  }

  async function isActive(author: Address, client = rpc()): Promise<boolean> {
    return client.readContract({ ...contract, functionName: 'active', args: [author] })
  }

  async function account(author: Address, confirmedBlock?: bigint, holder: Address = author, client = rpc()): Promise<KeyAccount> {
    const key = JSON.stringify([chain.id, deployment.address.toLowerCase(), author.toLowerCase(), holder.toLowerCase()])
    if (confirmedBlock !== undefined) rememberBlock(key, confirmedBlock)
    const head = confirmedBlock ?? await client.getBlockNumber({ cacheTime: 0 })
    let blockNumber = accountBlocks.get(key) ?? head
    if (head > blockNumber) blockNumber = head
    for (;;) {
      const [active, supply, holdings, fees] = await client.multicall({
        deployless: true, allowFailure: false, blockNumber,
        contracts: [
          { ...contract, functionName: 'active', args: [author] },
          { ...contract, functionName: 'supply', args: [author] },
          { ...contract, functionName: 'balanceOf', args: [author, holder] },
          { ...contract, functionName: 'claimableFees', args: [author] },
        ],
      })
      const latest = rememberBlock(key, blockNumber)
      if (latest === blockNumber) return { blockNumber, active, supply, holdings, fees }
      // A concurrent read or confirmation overtook this snapshot.
      blockNumber = latest
    }
  }

  async function quote(amount: bigint, client = rpc()): Promise<{ quote: KeyQuote }> {
    initialKeyAmount(String(amount))
    const q = amount === 0n ? { curveValue: 0n, creatorFee: 0n, devFee: 0n, total: 0n }
      : await client.readContract({ ...contract, functionName: 'quoteAtSupply', args: [0n, amount] })
    return { quote: q }
  }

  /** Check only the ETH sent to the contract. The wallet may sponsor gas. */
  async function checkPayment(client: ReturnType<typeof rpc>, payer: Address, value: bigint) {
    if (value > 0n && await client.getBalance({ address: payer }) < value) {
      throw new Error('not enough ETH for this payment. add ETH or reduce the amount')
    }
  }

  async function activate(provider: Eip1193Provider, author: Address, amount: bigint, reviewed: KeyQuote, beforeSend?: () => void): Promise<Hex> {
    initialKeyAmount(String(amount))
    const client = keyRpc(chain, deployment.rpcUrl, provider)
    await verify({}, client)
    if ((await account(author, undefined, author, client)).active) throw new Error('account keys are already active. refresh this page')
    const latest = await quote(amount, client)
    if (latest.quote.total !== reviewed.total) throw new Error('the quote changed. review it again before activating')
    // Initial issuance always starts at zero; no slippage allowance is needed.
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60)
    const call = { ...contract, functionName: 'activate', args: [amount, reviewed.total, deadline], value: reviewed.total } as const
    await checkPayment(client, author, call.value)
    await client.simulateContract({ ...call, account: author })
    const signer = await guardedSigner(provider, author, beforeSend)
    return signer.writeContract(call)
  }

  async function tradeQuote(creator: Address, side: 'buy' | 'sell' | 'transfer', amount: bigint, client = rpc()): Promise<KeyQuote> {
    tradeKeyAmount(String(amount))
    return client.readContract({ ...contract, functionName: side === 'buy' ? 'quoteBuy' : side === 'sell' ? 'quoteSell' : 'quoteTransfer', args: [creator, amount] })
  }

  function guardedSigner(provider: Eip1193Provider, caller: Address, beforeSend?: () => void) {
    return signerFor(provider, caller, chain, async () => {
      const current = Number(await withTimeout(provider.request({ method: 'eth_chainId' }), 6000,
        () => new Error('the wallet network check timed out. try again')))
      if (current !== chain.id) throw new Error(`the wallet changed networks. switch to ${chainLabel(chain)} and try again`)
      beforeSend?.()
    })
  }

  async function trade(provider: Eip1193Provider, caller: Address, creator: Address, side: 'buy' | 'sell', amount: bigint, reviewedTotal: bigint, beforeSend?: () => void): Promise<Hex> {
    tradeKeyAmount(String(amount))
    if (reviewedTotal < 0n) throw new Error('invalid payment bound')
    const client = keyRpc(chain, deployment.rpcUrl, provider)
    await verify({}, client)
    const latest = await tradeQuote(creator, side, amount, client)
    if (side === 'buy' ? latest.total > reviewedTotal : latest.total < reviewedTotal) {
      throw new Error('the price changed. review the updated quote before trading')
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60)
    const args = [creator, amount, reviewedTotal, deadline] as const
    const signer = await guardedSigner(provider, caller, beforeSend)
    if (side === 'buy') {
      const call = { ...contract, functionName: 'buy', args, value: reviewedTotal } as const
      await checkPayment(client, caller, call.value)
      await client.simulateContract({ ...call, account: caller })
      return signer.writeContract(call)
    }
    const call = { ...contract, functionName: 'sell', args } as const
    await client.simulateContract({ ...call, account: caller })
    return signer.writeContract(call)
  }

  function transferRecipient(text: string, caller: Address): Address {
    if (!isAddress(text)) throw new Error('enter a valid recipient wallet address')
    const to = getAddress(text)
    if ([zeroAddress, caller, deployment.address].some(address => sameAddress(address, to))) {
      throw new Error('choose another wallet as the recipient')
    }
    return to
  }

  async function transfer(provider: Eip1193Provider, caller: Address, creator: Address, recipient: string,
    amount: bigint, maxFee: bigint, beforeSend?: () => void): Promise<Hex> {
    const to = transferRecipient(recipient, caller)
    tradeKeyAmount(String(amount))
    if (maxFee < 0n) throw new Error('invalid payment bound')
    const client = keyRpc(chain, deployment.rpcUrl, provider)
    await verify({}, client)
    const latest = await tradeQuote(creator, 'transfer', amount, client)
    if (latest.total > maxFee) throw new Error('the fee changed. review the updated quote before transferring')
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60)
    const call = { ...contract, functionName: 'transfer', args: [creator, to, amount, maxFee, deadline], value: maxFee } as const
    await checkPayment(client, caller, call.value)
    await client.simulateContract({ ...call, account: caller })
    return (await guardedSigner(provider, caller, beforeSend)).writeContract(call)
  }

  function confirmTransfer(receipt: TransactionReceipt, creator: Address, from: Address, to: Address, amount: bigint) {
    const logs = parseEventLogs({ abi: accountKeysAbi, eventName: 'KeysTransferred',
      logs: receipt.logs.filter(log => sameAddress(log.address, deployment.address)), strict: true })
    if (!logs.some(({ args }) => sameAddress(args.creator, creator) && sameAddress(args.from, from)
      && sameAddress(args.to, to) && args.amount === amount)) {
      throw new Error('the receipt does not confirm the requested key transfer. check your wallet')
    }
  }

  async function claim(provider: Eip1193Provider, caller: Address, creator: Address, beforeSend?: () => void): Promise<Hex> {
    const client = keyRpc(chain, deployment.rpcUrl, provider)
    await verify({}, client)
    const call = { ...contract, functionName: 'claimFees', args: [creator] } as const
    await client.simulateContract({ ...call, account: caller })
    return (await guardedSigner(provider, caller, beforeSend)).writeContract(call)
  }

  async function settledAccount(creator: Address, block: bigint, holder: Address, action: 'activation' | 'trade' = 'trade'): Promise<KeyAccount> {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const result = await account(creator, block, holder)
        if (action !== 'activation' || result.active) return result
      } catch { /* The receipt may arrive before its state is available. */ }
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
    throw new Error('your transaction is confirmed. account details are taking longer to load. check the transaction again to update them.')
  }

  // Reopening a saved transaction must not start another two-minute receipt wait.
  // No receipt can mean pending, dropped, or an RPC that has not observed it.
  async function findReceipt(hash: Hex, action: 'activation' | 'trade' = 'trade', client = rpc()) {
    let result
    try { result = await client.getTransactionReceipt({ hash }) }
    catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return null
      throw e
    }
    if (result.status !== 'success') throw action === 'activation' ? new KeyActivationReverted() : new KeyTransactionReverted()
    return result
  }

  async function receipt(hash: Hex, action: 'activation' | 'trade' = 'activation') {
    // Follow only this hash. Replacement/cancellation recovery uses check and clear.
    // Re-select reads after wallet disconnects or network changes between polls.
    const until = Date.now() + 120_000
    let pending = 0
    for (;;) {
      const result = await findReceipt(hash, action)
      if (result) return result
      const remaining = until - Date.now()
      if (remaining <= 0) break
      await new Promise(resolve => setTimeout(resolve, Math.min(remaining, pendingInterval(++pending))))
    }
    throw new Error('the transaction has not landed yet. check its status in your wallet')
  }

  async function replyAccess(author: Address, holder: Address) {
    const client = rpc(), blockNumber = await client.getBlockNumber({ cacheTime: 0 })
    const [active, holdings] = await Promise.all([
      client.readContract({ ...contract, blockNumber, functionName: 'active', args: [author] }),
      client.readContract({ ...contract, blockNumber, functionName: 'balanceOf', args: [author, holder] }),
    ])
    return { active, holdings }
  }

  return { verify, isActive, replyAccess, account, quote, activate, receipt, findReceipt, tradeQuote, trade, transfer, transferRecipient, confirmTransfer, claim, settledAccount }
}

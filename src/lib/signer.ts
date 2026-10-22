// A wallet client that signs as the account this page shows as connected, or
// refuses. Some wallets sign from whichever account is active in the wallet
// without announcing a switch; a write from the wrong account either fails
// on-chain or lands somewhere unintended. The check runs in the transport,
// immediately before each signing request is forwarded, so an account that
// moves while a gas estimate or a nonce is being awaited is still caught.
// Best effort: the wallet is asked, and the chain remains the enforcement.
import type { Address } from 'viem'
import type { ChainInfo, Eip1193Provider } from './types'
import { withTimeout } from './wallet.svelte'

const SIGNING = new Set([
  'eth_sendTransaction', 'wallet_sendTransaction', 'eth_signTransaction', 'eth_sign', 'personal_sign',
  'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4',
])

/** Throws unless the wallet's active account is `account`. */
export async function assertActive(provider: Eip1193Provider, account: Address): Promise<void> {
  const accounts = await withTimeout(provider.request({ method: 'eth_accounts' }), 6000,
    () => new Error('the wallet account check timed out. try again'))
  const active = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null
  if (active === null) throw new Error('the wallet reports no connected account. unlock or reconnect it and try again')
  if (active.toLowerCase() !== account.toLowerCase()) {
    throw new Error('the wallet is set to a different account than the one connected here. switch accounts in the wallet or reconnect')
  }
}

// Quick reads, including viem's own pre-send reads, cannot hold an action open.
// Interactive approval methods deliberately have no timer.
const QUICK_READS = new Set(['eth_chainId', 'eth_accounts', 'eth_blockNumber', 'eth_call',
  'eth_getCode', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_estimateGas',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByNumber'])

/** `provider`, with bounded reads and every signing request checked against `account` first. */
export function guarded(provider: Eip1193Provider, account: Address, beforeSend?: () => Promise<void>): Eip1193Provider {
  return {
    ...provider,
    request: async (args) => {
      if (SIGNING.has(args.method)) await assertActive(provider, account)
      // Recovery must be saved after preflight, but before either wallet send method.
      if (args.method === 'eth_sendTransaction' || args.method === 'wallet_sendTransaction') await beforeSend?.()
      const work = provider.request(args)
      return QUICK_READS.has(args.method)
        ? withTimeout(work, 6000, () => new Error('the wallet read timed out. try again'))
        : work
    },
  }
}

/** A wallet client for `account`, loaded on first use, whose every signing request is checked by `guarded`. */
export async function signerFor(provider: Eip1193Provider, account: Address, chain: ChainInfo, beforeSend?: () => Promise<void>) {
  const { walletClient } = await import('./wallet-client')
  return walletClient(guarded(provider, account, beforeSend), account, chain)
}

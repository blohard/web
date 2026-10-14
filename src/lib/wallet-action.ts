import type { Address } from 'viem'
import { sameAddress } from './format'
import type { ChainInfo, Eip1193Provider } from './types'

export type ActionWallet = {
  readonly provider: Eip1193Provider | undefined
  readonly account: Address | null
  /** As `Wallet.ensureChain`: a signature-only action passes `'optional'`, needing no working wallet RPC. */
  ensureChain(chain: ChainInfo, rpc?: 'required' | 'optional'): Promise<void>
}

/** Capture at the press; check again after awaits without adopting a replacement wallet. */
export function captureWallet(wallet: ActionWallet) {
  const { provider, account } = wallet
  if (!provider || !account) return null
  return {
    provider, account,
    current: () => wallet.provider === provider && wallet.account !== null && sameAddress(wallet.account, account),
  }
}

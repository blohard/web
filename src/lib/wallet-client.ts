// viem's wallet client, loaded on the first signature or send: reading pages never need it.
import { createWalletClient, custom, type Address } from 'viem'
import { toViemChain } from './chains'
import type { ChainInfo, Eip1193Provider } from './types'

export function walletClient(provider: Eip1193Provider, account: Address, chain: ChainInfo) {
  return createWalletClient({ account, chain: toViemChain(chain), transport: custom(provider, { retryCount: 0 }) })
}

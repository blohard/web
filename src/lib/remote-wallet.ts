import type { ChainInfo, Eip1193Provider } from './types'

/** Wallets reached through code loaded on choice: the wallet app connector this host serves, or the passkey wallet. */
export type RemoteWalletKind = 'mobile' | 'coinbase'
export type WalletChoice = 'browser' | RemoteWalletKind | `injected:${string}`
export type RemoteWallet = {
  provider: Eip1193Provider
  connect(chain?: ChainInfo): Promise<string[]>
  disconnect(): Promise<void>
}
export type WalletFactories = Partial<Record<RemoteWalletKind, () => Promise<RemoteWallet>>>

/** What a wallet app connector is told: this site, the chains' public RPC URLs, and the chain to start on. */
export type MobileWalletConfig = { dapp: { name: string; url: string }; rpcUrls: Record<number, string>; chainId: number }
/** A connector module served by the host: its default export builds the wallet. */
export type MobileWalletModule = { default: (config: MobileWalletConfig) => Promise<RemoteWallet> }

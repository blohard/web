// The hosted passkey flow, loaded only when chosen or restoring its session.
import { createCoinbaseWalletSDK } from '@coinbase/wallet-sdk'
import { base, baseSepolia, mainnet } from 'viem/chains'
import { host } from './host.svelte'
import type { RemoteWallet } from './remote-wallet'

export async function passkeyWallet(createSDK: typeof createCoinbaseWalletSDK = createCoinbaseWalletSDK): Promise<RemoteWallet> {
  const provider = createSDK({
    appName: 'blohard',
    appLogoUrl: `${location.origin}/favicon.png`,
    appChainIds: [...new Set([baseSepolia.id, base.id, mainnet.id, ...(host.status?.chains.map(c => c.id) ?? [])])],
    preference: { options: 'smartWalletOnly', telemetry: false },
  }).getProvider()
  return {
    provider,
    connect: async () => await provider.request({ method: 'eth_requestAccounts' }) as string[],
    disconnect: () => provider.disconnect(),
  }
}

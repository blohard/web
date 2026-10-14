// A host may offer a wallet app's own connection on phones through a connector
// it serves beside the app: a module whose default export builds a RemoteWallet
// from a MobileWalletConfig. The app is given the connector's name and its URL
// on this origin when it is built, and loads it only when that choice is made
// or restored. The module carries whatever SDK it needs, so the app itself
// depends on none.
import { initialChainId, publicRpcUrl } from './chains'
import { host } from './host.svelte'
import type { MobileWalletModule, RemoteWallet } from './remote-wallet'
import { readJSON } from './storage'

export type MobileWallet = { name: string; module: string; notice: string | null }

/**
 * The connector this build was given: `VITE_MOBILE_WALLET_NAME` is the choice
 * shown, `VITE_MOBILE_WALLET_MODULE` the module's URL on this origin, and
 * `VITE_MOBILE_WALLET_NOTICE` an optional page on this origin carrying the
 * connector's license notice. Anything unusable means no such choice.
 */
export function mobileWallet(
  env: Record<string, unknown> = import.meta.env,
  origin: string | undefined = globalThis.location?.origin,
): MobileWallet | null {
  const { VITE_MOBILE_WALLET_NAME: name, VITE_MOBILE_WALLET_MODULE: module, VITE_MOBILE_WALLET_NOTICE: notice } = env
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) return null
  if (typeof module !== 'string' || !onOrigin(module, origin)) return null
  if (notice && (typeof notice !== 'string' || !onOrigin(notice, origin))) return null
  return { name: name.trim(), module, notice: typeof notice === 'string' && notice ? notice : null }
}

function onOrigin(path: string, origin: string | undefined): boolean {
  if (!origin) return false
  try {
    const url = new URL(path, origin)
    return url.origin === origin && !url.username && !url.password
  } catch {
    return false
  }
}

/** Load the connector and build its wallet from what this host serves. */
export async function loadMobileWallet(
  connector: MobileWallet,
  load: (url: string) => Promise<MobileWalletModule> = url => import(/* @vite-ignore */ url),
): Promise<RemoteWallet> {
  const chains = host.status?.chains ?? []
  const rpcUrls: Record<number, string> = {}
  for (const chain of chains) {
    const url = publicRpcUrl(chain)
    if (url) rpcUrls[chain.id] = url
  }
  const chainId = initialChainId(chains, readJSON<number | null>('blohard.chain', null)) ?? 84532
  const module = await load(new URL(connector.module, location.origin).href)
  if (typeof module?.default !== 'function') throw new Error('the wallet connector is not usable')
  return module.default({ dapp: { name: 'blohard', url: location.origin }, rpcUrls, chainId })
}

// Shared relayer availability and policy, consumed by the app-wide host state.
import type { Address } from 'viem'
import { errorMessage, responseJson } from '../shared/response-json'

export type RelayStatus = {
  relayer: Address
  policy: { per_author_per_day: number; global_per_day: number; max_gas_price_gwei: number; min_balance_eth: number }
  today: { posts: number; authors: number }
  chains: {
    id: number
    contract: Address
    curated: boolean
    name_sponsorship?: { ens: boolean; basenames: boolean }
    balance_eth: string | null
    /** A faucet on this chain (a test chain), and what one request receives. */
    faucet: { amount_eth: number } | null
  }[]
}

/** The host's relayer, or null when the host runs none. Any other failure throws: the relayer may be restarting. */
export async function relayStatus(): Promise<RelayStatus | null> {
  const res = await fetch('/api/relay/status', { signal: AbortSignal.timeout(20_000) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(errorMessage(res, await responseJson(res).catch(() => null)))
  return (await responseJson(res)) as RelayStatus
}

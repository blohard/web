import { defineChain, type Address, type Chain, type Hex } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import type { ChainInfo } from './types'
import { sameAddress } from './format'

/** Keep an explicit choice; new readers start on Base mainnet when served. */
export function initialChainId(chains: Pick<ChainInfo, 'id'>[], saved: number | null): number | null {
  return chains.find(c => c.id === saved)?.id
    ?? chains.find(c => c.id === base.id)?.id
    ?? chains[0]?.id ?? null
}

export function chainLabel(c: { id: number; name?: string | null }): string {
  if (c.id === base.id) return base.name
  if (c.id === baseSepolia.id) return baseSepolia.name
  return c.name?.trim() || 'another network'
}

/** Chains whose ETH has no value: public testnets and the local development chains. */
const TESTNETS = new Set([84532, 11155111, 560048, 31337, 31338, 810337, 810338])
export const isTestnet = (c: ChainInfo): boolean => TESTNETS.has(c.id)
/** The chain's label, marked when its ETH is not real. */
export const chainTag = (c: ChainInfo): string => isTestnet(c) ? `${chainLabel(c)} · testnet` : chainLabel(c)

/** A host-relative path becomes a URL on the origin this app was loaded from; an absolute URL is left alone. */
export const absolute = (url: string): string => new URL(url, location.origin).toString()

/**
 * The RPC URL the host publishes for wallet submission, absolute. A
 * host may publish a path such as `/rpc/810337` meaning "served by me": it is
 * resolved against the origin this app was loaded from, so the same status
 * works under every name the host answers to.
 */
export function publicRpcUrl(c: ChainInfo): string | null {
  return c.public_rpc_url ? absolute(c.public_rpc_url) : null
}

/** A viem chain definition built from what the host published. */
export function toViemChain(c: ChainInfo): Chain {
  return defineChain({
    id: c.id,
    name: chainLabel(c),
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: publicRpcUrl(c) ? [publicRpcUrl(c)!] : [] } },
  })
}

/** Saved operations are scoped to both the chain and the contract recording them. */
export const sameDeployment = (chain: ChainInfo, chainId: number, contract: string): boolean =>
  chain.id === chainId && sameAddress(chain.contract, contract)

/** Unknown chains have no explorer link rather than a link to another network. */
function explorerUrl(chain: Pick<ChainInfo, 'id'>): string | null {
  return [base, baseSepolia].find(c => c.id === chain.id)?.blockExplorers.default.url ?? null
}

export function transactionUrl(chain: Pick<ChainInfo, 'id'>, hash: Hex): string | null {
  const explorer = explorerUrl(chain)
  return explorer ? `${explorer}/tx/${hash}` : null
}

export function addressUrl(chain: Pick<ChainInfo, 'id'>, address: Address): string | null {
  const explorer = explorerUrl(chain)
  return explorer ? `${explorer}/address/${address}` : null
}

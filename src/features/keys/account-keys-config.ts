import { getAddress, isAddress, zeroAddress, type Address } from 'viem'
import { publicRpcUrl } from '../../lib/chains'
import { sameAddress } from '../../lib/format'
import type { ChainInfo, KeyringInfo } from '../../lib/types'

export const ACCOUNT_KEYS_CHAINS = [8453, 84532] as const
export type KeyDeployment = { address: Address; devFund: Address; rpcUrl: string }
/** Shared deployment addresses on supported chains, using each chain's public RPC. */
export function keyDeployment(chain: ChainInfo, env = import.meta.env): KeyDeployment | null {
  if (!ACCOUNT_KEYS_CHAINS.some(id => id === chain.id)) return null
  const address = env.VITE_ACCOUNT_KEYS_ADDRESS
  const devFund = env.VITE_ACCOUNT_KEYS_DEV_FUND
  const rpcUrl = publicRpcUrl(chain)
  if (!address || !devFund || !rpcUrl || !isAddress(address) || !isAddress(devFund)
    || sameAddress(address, zeroAddress) || sameAddress(devFund, zeroAddress)) return null
  try {
    const url = new URL(rpcUrl)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  } catch { return null }
  return { address: getAddress(address), devFund: getAddress(devFund), rpcUrl }
}

/** A key reply rule needs both verified gates and an activation read on their market. */
export function keyReplyDeployment(chain: ChainInfo, indexed: KeyringInfo | null | undefined, deployment = keyDeployment(chain)): KeyDeployment | null {
  return chain.blocking && chain.key_gates?.holders_blocklist && deployment
    && indexed?.chain === chain.id && sameAddress(indexed.market, deployment.address) ? deployment : null
}

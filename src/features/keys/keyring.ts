import { sameAddress } from '../../lib/format'
import { getAddress, isAddress, type Address } from 'viem'
import { request } from '../../lib/api'
import type { ChainInfo } from '../../lib/types'

export type Keyring = { active: boolean; holders: Address[]; holding: Address[]; truncated: { holders: boolean; holding: boolean } }
/** A failed lookup must never be presented as an empty keyring. */
export async function readKeyring(chain: ChainInfo, account: Address, market: Address): Promise<Keyring> {
  const result = await request<{ market: unknown; active: unknown; holders: unknown; holding: unknown; truncated: { holders: unknown; holding: unknown } }>(chain, `keyring/${account}`)
  if (typeof result.active !== 'boolean' || typeof result.market !== 'string'
    || !sameAddress(result.market, market)
    || typeof result.truncated?.holders !== 'boolean' || typeof result.truncated?.holding !== 'boolean') throw new Error('invalid keyring response')
  function authors(value: unknown): Address[] {
    if (!Array.isArray(value) || value.length > 256 || value.some(a => typeof a !== 'string' || !isAddress(a))) {
      throw new Error('invalid keyring response')
    }
    const addresses = value.map(a => getAddress(a as string)).sort()
    if (new Set(addresses).size !== addresses.length) throw new Error('duplicate keyring authors')
    return addresses.filter(a => !sameAddress(a, account))
  }
  return { active: result.active, holders: authors(result.holders), holding: authors(result.holding), truncated: { holders: result.truncated.holders, holding: result.truncated.holding } }
}

/** How long one read answers every view that asks, such as the navigation links on each page visit. */
const RECENT = 60_000
const recent = new Map<string, { at: number; read: Promise<Keyring> }>()

/**
 * The account's keyring, read once for every view that shows it: a read in
 * flight or under a minute old answers, and a failed one is never reused.
 * `fresh` asks again and becomes the read the next views share; polls use it.
 */
export function sharedKeyring(chain: ChainInfo, account: Address, market: Address, fresh = false): Promise<Keyring> {
  const key = `${chain.id}/${chain.contract}/${market}/${account}`.toLowerCase()
  const known = recent.get(key)
  if (!fresh && known && Date.now() - known.at < RECENT) return known.read
  const read = readKeyring(chain, account, market)
  recent.set(key, { at: Date.now(), read })
  read.catch(() => { if (recent.get(key)?.read === read) recent.delete(key) })
  return read
}

/** After a refresh or a confirmed key transaction, the next view asks the host again. */
export function forgetKeyrings() { recent.clear() }


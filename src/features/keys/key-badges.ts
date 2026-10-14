import type { Address } from 'viem'
import { readKeyringPage } from './keyring-balances'
import { sharedRead } from '../../shared/shared-read'
import type { ChainInfo } from '../../lib/types'

/** How long a "not active" answer stands. A market activates once and never closes (AccountKeys.activate), so "active" stands for the session. */
const TTL = 5 * 60_000
const MAX_ENTRIES = 512

/** Display hints from the host index, never wallet RPC or permission checks. */
export class KeyBadges {
  private cache = new Map<string, { active: boolean; at: number }>()
  private flights = new Map<string, Promise<boolean>>()

  read(chain: ChainInfo, market: Address, address: Address): Promise<boolean> {
    const key = `${chain.id}/${chain.contract}/${market}/${address}`.toLowerCase()
    const cached = this.cache.get(key)
    if (cached && (cached.active || Date.now() - cached.at < TTL)) return Promise.resolve(cached.active)
    return sharedRead(this.flights, key, async () => {
      // Failures back off just like negative answers and never invent activation.
      const active = await readKeyringPage(chain, address, market, 'holding', null, 1)
        .then(page => page.active, () => false)
      this.cache.delete(key)
      this.cache.set(key, { active, at: Date.now() })
      while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!)
      return active
    })
  }
}

export const keyBadges = new KeyBadges()

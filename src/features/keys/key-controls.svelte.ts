import type { Address } from 'viem'
import { host } from '../../lib/host.svelte'
import { sharedKeyring, type Keyring } from './keyring'
import { Resource } from '../../shared/resource.svelte'
import type { ChainInfo } from '../../lib/types'

/** Navigation hints only. Transaction paths still verify permissions before signing. */
export class KeyControls {
  private read = new Resource<Keyring>()

  private identity(chain: ChainInfo, account: Address | null): string | null {
    const market = host.keyringMarket(chain.id)
    return account && market ? `${chain.id}/${chain.contract}/${market}/${account}`.toLowerCase() : null
  }

  /** Asked on each page visit, from the keyring read every view shares: a visit within a minute of the last read asks the host nothing. */
  watch(chain: ChainInfo, account: Address | null): () => void {
    const identity = this.identity(chain, account), market = host.keyringMarket(chain.id)
    if (!identity || !account || !market) return () => {}
    return this.read.watch(sharedKeyring(chain, account, market), identity)
  }

  available(chain: ChainInfo, account: Address | null): boolean {
    const identity = this.identity(chain, account)
    const value = identity === null ? null : this.read.value(identity)
    return !!value && (value.active || value.holding.length > 0)
  }
}

export const keyControls = new KeyControls()

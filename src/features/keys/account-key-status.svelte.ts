import type { Address } from 'viem'
import { keyDeployment } from './account-keys-config'
import { sameAddress } from '../../lib/format'
import { sharedKeyring } from './keyring'
import { Resource } from '../../shared/resource.svelte'
import type { ChainInfo } from '../../lib/types'

export type KeyStatus = 'unavailable' | 'loading' | 'failed' | 'active' | 'inactive'

/**
 * One account read supplies key availability; closed controls can defer it.
 * With `indexed`, the host's keyring market, a reader without a wallet learns
 * it from the host's index instead of a chain read: it trails the chain by
 * the index's confirmations, which a page to look at can afford.
 */
export function accountKeyStatus(input: () => { chain: ChainInfo; address: Address | null; reloadRevision: number; enabled?: boolean; indexed?: Address | null }) {
  const read = new Resource<boolean>()
  let retry = $state(0)
  let context = $derived(input())
  let configured = $derived(context.address ? keyDeployment(context.chain) : null)
  /** Where the answer comes from: the chain, the host's index of the same market, or nowhere. */
  let source = $derived<'chain' | 'index' | null>(!configured ? null
    : context.enabled !== false ? 'chain'
    : context.indexed && sameAddress(context.indexed, configured.address) ? 'index' : null)
  let deployment = $derived(source ? configured : null)
  let identity = $derived(deployment && context.address
    ? `${context.chain.id}/${deployment.address}/${context.address.toLowerCase()}/${source}` : null)
  let query = $derived.by(() => {
    const { chain, address, reloadRevision } = context
    const market = deployment
    void reloadRevision
    void retry
    if (!market || !address) return null
    if (source === 'index') return sharedKeyring(chain, address, market.address).then((k) => k.active)
    return import('./account-keys').then(({ keyMarket }) => keyMarket(chain, market).isActive(address))
  })
  $effect(() => {
    if (query) return read.watch(query, identity)
  })
  let state = $derived<KeyStatus>(!deployment ? 'unavailable'
    : read.failure(identity) ? 'failed'
    : read.value(identity) === true ? 'active'
    : read.value(identity) === false ? 'inactive' : 'loading')

  return {
    get state() { return state },
    // A failed refresh should not remove a badge or tab already shown.
    get active() { return deployment !== null && read.value(identity) === true },
    retry() { retry++ },
  }
}

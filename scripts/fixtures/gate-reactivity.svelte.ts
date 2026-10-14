import { flushSync } from 'svelte'
import { gates } from '../../src/lib/gates.svelte'
import type { ChainInfo } from '../../src/lib/types'
import type { Address } from 'viem'

export { gates, flushSync }

/** Exercise browser reactivity without a DOM or a preloaded ledger. */
export function watchAuthor(chain: ChainInfo, owner: Address, changed: (gate: Address | undefined) => void) {
  return $effect.root(() => {
    const current = $derived(gates.author(chain, owner))
    $effect(() => changed(current))
  })
}

export function watchMessage(chain: ChainInfo, id: bigint, changed: (gate: Address | undefined) => void) {
  return $effect.root(() => {
    const current = $derived(gates.message(chain, id))
    $effect(() => changed(current))
  })
}

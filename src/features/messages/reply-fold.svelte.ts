import { untrack } from 'svelte'
import { gating, type Verdict } from './gating.svelte'
import { Resource } from '../../shared/resource.svelte'
import type { ChainInfo, Posted } from '../../lib/types'

/** A mounted reply keeps its verdict until its identity or explicit refresh changes. */
export function replyFold(
  input: () => { chain: ChainInfo; msg: Posted; enabled: boolean },
  gateRefreshReady: () => Promise<unknown> | null | undefined,
) {
  const view = new Resource<Verdict>()
  let context = $derived(input())
  // The reply records its parent author, independent of which ancestor cards are loaded.
  // New page and record objects must not invalidate an unchanged reply.
  let identity = $derived.by(() => {
    const { chain, msg, enabled } = context
    return `${chain.id}/${chain.contract}/${msg.id}/${msg.contentHash}/${msg.parentId}/${msg.author}/${msg.blockNumber}/${msg.parentAuthor}/${enabled}`
  })
  let request = $derived.by(() => {
    void identity
    const ready = gateRefreshReady()
    return untrack(() => {
      const { chain, msg, enabled } = context
      if (!enabled || msg.parentId === 0n) return null
      // The page refresh advances the gate ledger before the verdict is read.
      return Promise.resolve(ready).then(() => gating.check(chain, msg, msg.parentAuthor))
    })
  })
  $effect(() => { if (request) return view.watch(request, identity) })
  return {
    get checking() { return request !== null && view.value(identity) === null && !view.failure(identity) },
    get folded() { return request !== null && view.value(identity) === 'folded' },
  }
}

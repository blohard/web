import { flushSync } from 'svelte'
import { replyFold } from '../../reply-fold.svelte'
import { gating, type Verdict } from '../../gating.svelte'
import type { ChainInfo, Posted } from '../../../../lib/types'

export { flushSync }
export function reader(check: typeof gating.check) { gating.check = check }

export function card(chain: ChainInfo, msg: Posted, ready: Promise<unknown> | null = null) {
  let input = $state.raw({ chain, msg, enabled: true })
  let refresh = $state.raw(ready)
  let view!: ReturnType<typeof replyFold>
  const stop = $effect.root(() => { view = replyFold(() => input, () => refresh) })
  return {
    get verdict(): Verdict | 'checking' { return view.checking ? 'checking' : view.folded ? 'folded' : 'shown' },
    // A page update supplies fresh record/chain/parent props for an existing card.
    page(next = input.msg) { input = { ...input, chain: { ...input.chain }, msg: { ...next } } },
    refresh(ready: Promise<unknown>) { refresh = ready },
    stop,
  }
}

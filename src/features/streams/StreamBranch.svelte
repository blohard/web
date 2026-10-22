<script lang="ts">
  // A conversation opened in place under a stream card: the thread page's own
  // replies list, fed by that post's thread session. A local reload hands
  // it a fresh facade; the list keeps its rows,
  // appends to a complete branch and leaves a partial one at its length.
  import { onDestroy, untrack, type Snippet } from 'svelte'
  import { readRoot } from './replies'
  import type { RowExpansion } from './stream-expansion'
  import type { ChainInfo, Posted } from '../../lib/types'
  import Replies from './Replies.svelte'
  import Retained from '../../shared/Retained.svelte'
  import { loadingDelay } from '../../shared/loading-delay.svelte'
  import ReplyLoading from './ReplyLoading.svelte'

  let { chain, id, reloadKey, resume = false, gateRefreshReady, rowx, preview = [], kept = [], remaining, separator = true, onchanged, onloading, onready, displayed = true }: {
    chain: ChainInfo
    id: bigint
    /** The stream load this branch belongs to: a new one reloads the branch. Showing older posts is not a new load. */
    reloadKey: unknown
    /** A returning stream keeps its loaded replies until refresh. */
    resume?: boolean
    gateRefreshReady?: Promise<unknown> | null
    /** One row's saved choices, shared by previews and loaded replies. */
    rowx: RowExpansion
    /** Cards already visible before this branch was opened. */
    preview?: Posted[]
    /** Preview cards whose own parent has not been explicitly opened yet. */
    remaining?: Snippet<[Posted[], bigint?, boolean?]>
    /** The previews after this list, already filtered and ordered by their owner. */
    kept?: Posted[]
    /** The first reply needs a separator unless it joins the card or label above. */
    separator?: boolean
    onchanged?: () => void
    onloading?: (loading: boolean) => void
    onready?: (ready: boolean) => void
    displayed?: boolean
  } = $props()

  const views = untrack(() => rowx.views())
  untrack(() => rowx.retain(preview))
  let ready = $state(false)
  onDestroy(() => onready?.(false))
  // Moving an already-open card into a parent list reuses that card's session.
  // A subsequent stream refresh still reads changes.
  const opening = untrack(() => ({ key: reloadKey, resume: resume || rowx.isMounted(id) }))
  let again = $state(0)
  let identity = $derived(`${chain.id}/${chain.contract}/${id}`)
  let request = $derived.by(() => {
    void reloadKey
    void again
    return readRoot(chain, id, opening.resume && reloadKey === opening.key && again === 0)
  })
  // One wait covers reading the thread and its first list preparing, so the
  // reply count's spinner does not go out and come back between the two.
  const waited = loadingDelay(() => ready ? null : identity)
</script>

{#snippet loadingReplies()}<ReplyLoading {onloading} {waited} />{/snippet}

<Retained settleFirstScreen {request} {identity} loading={loadingReplies} what="replies" onretry={() => again++}>
  {#snippet children(page)}
    <!-- The card above folds it again with its own reply count. -->
    <Replies {kept} {remaining} {rowx} {displayed} resume={opening.resume && reloadKey === opening.key} {separator} onready={() => { ready = true; onready?.(true) }} onvisible={parent => rowx.listShown(parent)} {onloading} {waited} {gateRefreshReady} {chain} parentId={id} data={page.replies} {views} reveal={rowx.reveal(id)} {onchanged} />
  {/snippet}
</Retained>

<script lang="ts">
  // A stream card can join the previews already immediately after it.
  // The surrounding list still owns expansion and all reads.
  import type { Snippet } from 'svelte'
  import type { ChainInfo, Posted } from '../../lib/types'
  import MessageCard from '../messages/MessageCard.svelte'
  import InlineReply from '../publishing/InlineReply.svelte'
  import { replyControls } from './conversation-layout'
  import type { RowExpansion } from './stream-expansion'

  let { chain, msg, total, rowx, kept, remaining, separator, expanded, loading, interrupted, reloadKey, gateRefreshReady, onchanged }: {
    chain: ChainInfo
    msg: Posted
    total: number
    rowx: RowExpansion
    kept: Posted[]
    remaining: Snippet<[Posted[], bigint?, boolean?]>
    separator: boolean
    expanded: boolean
    loading: boolean
    interrupted: boolean
    reloadKey?: unknown
    gateRefreshReady?: Promise<unknown> | null
    onchanged?: () => void
  } = $props()
  let controls = $derived(replyControls(total, kept.filter(p => p.parentId === msg.id).length, expanded, rowx.isHidden(msg.id)))
</script>

{#snippet after(parentShown: boolean)}
  <InlineReply {chain} id={msg.id} onposted={id => { rowx.landed(msg.id, id); onchanged?.() }} />
  {#if kept.length}{@render remaining(kept, msg.id, parentShown && !interrupted)}{/if}
{/snippet}

<MessageCard {chain} {msg} {reloadKey} {gateRefreshReady} {separator} {expanded} repliesLoading={loading} continuesAbove connector={expanded || (kept.length > 0 && !interrupted)}
  replyCount={controls.replyCount} moreReplies={controls.moreReplies}
  onexpand={() => rowx.press(msg.id)} onhide={controls.moreReplies ? () => rowx.hide(msg.id) : null}
  {after} {onchanged} />

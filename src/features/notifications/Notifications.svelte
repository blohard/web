<script lang="ts">
  import type { Address } from 'viem'
  // One timeline across the chains this host serves, with a post shown once
  // even when it both replies to the reader and mentions or quotes them.
  import { untrack } from 'svelte'
  import { chainLabel } from '../../lib/chains'
  import { host } from '../../lib/host.svelte'
  import { muted } from '../../lib/muted.svelte'
  import type { Notification } from './notifications'
  import { NotificationActivity, activityId, activityAuthor } from './notification-activity'
  import { pollVisible } from '../../shared/visible-poll'
  import { refreshCue } from '../../shared/refresh-cue.svelte'
  import { notificationDot } from './notification-dot.svelte'
  import KeyTradeNotification from '../keys/KeyTradeNotification.svelte'
  import type { ChainInfo } from '../../lib/types'
  import { wallet } from '../../lib/wallet.svelte'
  import ConnectPrompt from '../../components/ConnectPrompt.svelte'
  import { rememberStream, streamPosition } from '../navigation/stream-position'
  import { FirstScreen, provideFirstScreen, revealStream } from '../../shared/first-screen.svelte'
  import FirstScreenRow from '../../shared/FirstScreenRow.svelte'
  import Loading from '../../shared/Loading.svelte'
  import { loadingDelay } from '../../shared/loading-delay.svelte'
  import { visitPlace } from '../navigation/visit-position'
  import InlineReply from '../publishing/InlineReply.svelte'
  import MessageCard from '../messages/MessageCard.svelte'
  import Retained from '../../shared/Retained.svelte'

  let { chain, refreshRevision = 0 }: { chain: ChainInfo; refreshRevision?: number } = $props()
  const place = visitPlace()
  let identity = $derived(`notifications/${chain.id}/${wallet.account}`)
  const spinnerReady = loadingDelay(() => wallet.account ? identity : null)
  let entrance = $derived.by(() => {
    const key = identity
    return untrack(() => wallet.account && !streamPosition(key, place.streams) ? new FirstScreen() : null)
  })
  provideFirstScreen(() => entrance)
  $effect(() => {
    const screen = entrance
    return () => screen?.finish()
  })

  const activity = $derived(wallet.account ? new NotificationActivity(host.status?.chains ?? [chain], wallet.account, host.status?.keyrings) : null)
  // Only explicit refreshes reset the trade cursor; loading older rows keeps the same head.
  const refreshToken = $derived.by(() => { void refreshRevision; return {} })
  $effect(() => {
    const keys = activity?.keys
    const stops = (keys ?? []).map(key => pollVisible(() => key.peek(), head => key.observe(head), () => {}, 30_000, false))
    return () => stops.forEach(stop => stop())
  })
  $effect(() => refreshCue.cueChanges(() => activity?.keys.some(key => key.changed) ?? false))
  let again = $state(0)
  let more = $state<{ account: Address; limit: number } | null>(null)
  let requested = $derived(more?.account === wallet.account ? more!.limit : 20)
  let references = $derived.by(() => {
    void again
    const me = wallet.account
    const visit = me ? notificationDot.begin(me) : null
    return activity && visit ? activity.load(requested, refreshToken).then(list => ({ ...list, visit })) : null
  })

  $effect(() => {
    const request = references, screen = entrance
    let current = true
    request?.then(
      () => { if (current) screen?.start() },
      () => { if (current) screen?.finish() },
    )
    return () => { current = false }
  })

  // Sample the new page only on an explicit refresh, not on local reloads or paging.
  let gateRefreshReady = $derived.by(() => {
    void refreshRevision
    return untrack(() => references)
  })

  /** What a reference is, with the chain named whenever it is not the one being read. */
  function describe(r: Notification): string {
    if (r.kind === 'reply') return 'replied to your post'
    if (r.kind === 'mention') return 'mentioned you'
    const q = r.quoted
    const where = q.chainId === chain.id ? '' : ` on ${host.label(q.chainId)}`
    return `quoted your post #${q.id}${where}`
  }
</script>

{#snippet loadingNotifications()}
  {#if spinnerReady()}<Loading label="reading notifications…" overlay />{/if}
{/snippet}

{#if !wallet.account}
  <ConnectPrompt {chain} toDo="to see your notifications" />
{:else}
  <p class="dim small">replies, mentions, quotes, trades of your account keys and keys sent to you, newest first.</p>
  {#if references}
    <div class="stream-start">
    <Retained request={references} {identity} loading={loadingNotifications} onretry={() => again++}
      onshown={list => notificationDot.saw(list.visit, list.items[0]?.timestamp, list.sourcesRead)}>
      {#snippet children(list)}
      {@const shown = list.items.filter((r) => !muted.has(activityAuthor(r)) && !host.blocked(activityAuthor(r)))}
      {#if entrance?.waiting}{@render loadingNotifications()}{/if}
      <div use:revealStream={entrance} inert={entrance?.waiting ?? false} style:visibility={entrance?.waiting ? 'hidden' : undefined} use:rememberStream={{ key: identity, limit: list.limit, positions: place.streams }}>
      {#if list.keyError}<p class="err small">could not update key activity. <button onclick={() => again++}>try again</button></p>{/if}
      {#if shown.length === 0}
        <p class="dim">{list.complete ? 'no notifications found.' : 'no notifications in these results.'}</p>
      {/if}
      {#each shown as r (activityId(r))}
        <FirstScreenRow id={activityId(r)}>
          {#if r.kind === 'key-trade' || r.kind === 'key-received'}
            <KeyTradeNotification notice={r} creator={wallet.account!} showChain={r.chain.id !== chain.id} />
          {:else}
          <div class="dim small ref-line">
            {describe(r)}
            {#if r.chain.id !== chain.id}<span>· on {chainLabel(r.chain)}</span>{/if}
          </div>
          <MessageCard {gateRefreshReady} reloadKey={list} chain={r.chain} msg={r.post} withParent
            separator={false} replyCount={r.post.replies} onchanged={() => again++} />
          <!-- Nothing here lists what you write, so the reply's own thread shows it. -->
          <InlineReply chain={r.chain} id={r.post.id} />
          {/if}
        </FirstScreenRow>
      {/each}
      {#if !list.complete}
        <nav class="stream-paging" aria-label="notification pagination">
          <button aria-disabled={list.limit < requested} onclick={() => { if (list.limit >= requested) more = { account: wallet.account!, limit: list.limit + 20 } }}>
            {list.limit < requested ? 'reading older notifications…' : 'show more notifications'}
          </button>
        </nav>
      {/if}
      </div>
      {/snippet}
    </Retained>
    </div>
  {/if}
{/if}

<style>
  .stream-start { position: relative; }
</style>

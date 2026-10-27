<script module lang="ts">
  /** Back resumes retained reply snapshots and UI choices; explicit refresh advances them. */
  export type { ReplyViews } from './stream-expansion'
</script>

<script lang="ts">
  // Direct replies are paged by the host, oldest first. Opening a reply reads
  // its branch only; refreshes retain those rows and their expansion choices.
  // Deleted and removed children leave the list with their whole branch.
  import { endingOf } from '../../lib/board'
  import { gates } from '../../lib/gates.svelte'
  import { onDestroy, tick, untrack, type Snippet } from 'svelte'
  import { firstDisplay, firstDisplayGroup, FIRST_DISPLAY_WAIT_MS } from '../../shared/first-screen.svelte'
  import { Resource } from '../../shared/resource.svelte'
  import { replying } from '../publishing/replying.svelte'
  import InlineReply from '../publishing/InlineReply.svelte'
  import Replies from './Replies.svelte'
  import ReplyLoading from './ReplyLoading.svelte'
  import StreamBranch from './StreamBranch.svelte'
  import StreamReply from './StreamReply.svelte'
  import LoadError from '../../shared/LoadError.svelte'
  import { replySlice, type ReplyPage, type ReplySlice } from './replies'
  import type { ReplyViews, RowExpansion } from './stream-expansion'
  import type { ChainInfo, Posted } from '../../lib/types'
  import MessageCard from '../messages/MessageCard.svelte'

  let {
    chain,
    parentId,
    depth = 0,
    separator = true,
    data,
    reloadKey,
    gateRefreshReady,
    reveal,
    omit,
    shown,
    views = new Map(),
    rowx,
    resume = false,
    onchanged,
    onloading,
    waited,
    onready,
    onvisible,
    displayed = true,
    kept = [],
    remaining,
  }: {
    chain: ChainInfo
    parentId: bigint
    depth?: number
    /** Only the first reply can join the content above this list; siblings keep their separators. */
    separator?: boolean
    /** The retained thread session and its current counts; a new facade cues a reload. */
    data: ReplyPage
    /** The thread or branch load, passed to every nested card unchanged. Paging replaces reply data without changing this key. */
    reloadKey?: unknown
    gateRefreshReady?: Promise<unknown> | null
    /** A reply just posted here: shown after the loaded page without fetching every intervening reply. */
    reveal?: bigint
    /** The child already mounted in the thread's focused path. Never render it twice. */
    omit?: bigint
    /** The thread's record of whose replies are on screen, for its quiet poll; this list adds its parent while it is mounted. */
    shown?: Set<bigint>
    /** This thread visit's paging and expansion choices, shared by its nested lists. */
    views?: ReplyViews
    /** Stream cards keep the same expansion choice when a preview joins this list. */
    rowx?: RowExpansion
    resume?: boolean
    onchanged?: () => void
    onloading?: (loading: boolean) => void
    /** The caller's wait for this list's first display, when a read before it already started one. Nested lists keep their own. */
    waited?: () => boolean
    /** Report when this list and its cards can be shown together. */
    onready?: () => void
    /** Preview cards move here only once this list and its enclosing lists show. */
    onvisible?: (parent: bigint) => void
    displayed?: boolean
    kept?: Posted[]
    remaining?: Snippet<[Posted[], bigint?, boolean?]>
  } = $props()
  const box = untrack(() => replying.box())
  const displays = firstDisplayGroup()
  let prepared = $state(false)
  function prepare() {
    if (prepared) return
    prepared = true
    onready?.()
  }
  // Like the feed, wait at most two seconds after the page arrives. Individual
  // cards still own their loading and folding checks after the list is revealed.
  $effect(() => {
    if (prepared || !pageArrived) return
    const timer = setTimeout(prepare, FIRST_DISPLAY_WAIT_MS)
    return () => clearTimeout(timer)
  })
  $effect(() => {
    if (prepared || !slice || !displays()) return
    let active = true
    // Wait for newly mounted cards to register their body and verdict reads.
    void tick().then(() => {
      if (active && displays()) prepare()
    })
    return () => { active = false }
  })
  $effect(() => {
    const parents = shown, id = parentId
    if (rowx) return rowx.watch(id)
    parents?.add(id)
    return () => void parents?.delete(id)
  })

  $effect(() => {
    if (prepared && displayed) untrack(() => onvisible?.(parentId))
  })

  /** How many replies a page of the list shows before "show more" (CLIENT.md). */
  const PAGE = 20
  const rows = new Resource<ReplySlice>()
  const target = untrack(() => ({ views, parentId }))
  const saved = target.views?.get(target.parentId)
  let requested = $state(saved?.limit ?? PAGE)
  let again = $state(0)
  let identity = $derived(`${chain.id}/${chain.contract}/${parentId}`)
  /** The outermost list is handed its load's facade, which only a reload replaces. */
  let cardReloadKey = $derived(reloadKey ?? data)

  // Keep every displayed row on reload. If the complete branch was visible,
  // append its new replies too; otherwise retain its current page length.
  async function load(data: ReplyPage, limit: number, reveal: bigint | undefined, omit: bigint | undefined, _again: number): Promise<ReplySlice> {
    const previous = untrack(() => rows.value(identity))
    const end = Math.max(limit, previous?.loaded ?? 0, previous?.more === false ? data.counts.get(parentId) ?? 0 : 0)
    // Placement changes do not reload the list; sample pins when a read is requested.
    const retained = untrack(() => rowx ? rowx.retained(parentId).map(r => r.id) : saved?.retained)
    const slice = await replySlice(chain, data, parentId, end, reveal, retained)
    // If the focused child is the only unread entry, finish the branch now.
    // Otherwise "show more" would add nothing and quiet polling would keep
    // treating a fully displayed conversation as only partly loaded.
    if (omit !== undefined && !endingOf(gates.message(chain, omit)) && slice.more && slice.total === slice.list.length + 1 && !slice.list.some(r => r.id === omit)) {
      return replySlice(chain, data, parentId, slice.loaded + 1, reveal, retained)
    }
    return slice
  }
  let request = $derived(load(data, requested, reveal, omit, again))
  $effect(() => rows.watch(request, identity))
  let slice = $derived(rows.value(identity))
  const pageArrived = $derived(slice !== null)
  let error = $derived(rows.failure(identity))
  firstDisplay(() => slice !== null || error !== null)
  let visible = $derived(slice?.list.filter(r => r.id !== omit && !endingOf(gates.message(chain, r.id))) ?? [])
  // The retained section can join only the final, closed card, with no
  // paging control, error or nested branch between them. Editors are handled
  // inside the pair so opening one never remounts the parent card.
  let last = $derived(visible.at(-1))
  let adjacent = $derived(rowx && remaining && last && !error && !slice?.more
    && !rowx.isOpen(last.id) && kept[0]?.parentId === last.id ? last.id : null)
  let more = $derived(slice ? Math.max(0, slice.total - slice.list.length - (omit !== undefined && !endingOf(gates.message(chain, omit)) && !slice.list.some(r => r.id === omit) ? 1 : 0)) : 0)
  let step = $derived(Math.min(PAGE, more))
  function showMore() {
    if (rows.pending || !slice) return
    requested = Math.max(requested, slice.loaded) + PAGE
  }
  let loadingBranches = $state<Record<string, boolean>>({})
  let open = $state<Record<string, boolean>>(saved?.open ?? {})
  /** Replies just posted here, kept beyond the loaded page until this list closes. */
  let arrived = $state<Record<string, bigint>>({})
  /**
   * Open the branch at any depth and keep the landed reply in its list,
   * even beyond the loaded page. Hiding it forgets that extra reply.
   */
  function landed(r: Posted, replyId: bigint) {
    if (rowx) { rowx.landed(r.id, replyId); onchanged?.(); return }
    open[r.id.toString()] = true
    arrived[r.id.toString()] = replyId
    onchanged?.()
  }
  /** Each card's reply count opens its replies in place and, while they are open, hides them: the control sits on the message it belongs to, so none stack where branches end. */
  function toggle(r: Posted) {
    if (rowx) { rowx.press(r.id); return }
    const k = r.id.toString()
    if (open[k]) { open[k] = false; delete arrived[k] } else open[k] = true
  }
  // The resource remains readable during teardown, after deriveds are gone.
  function saveView() {
    const list = rows.result?.value.list.filter(r => r.id !== omit && !endingOf(gates.message(chain, r.id))) ?? []
    target.views.set(target.parentId, {
      limit: Math.max(requested, rows.result?.value.loaded ?? 0),
      open: rowx ? Object.fromEntries(list.map(r => [r.id.toString(), rowx.isOpen(r.id)])) : $state.snapshot(open),
      retained: rowx ? list.map(r => r.id) : saved?.retained,
    })
  }
  // A context link can snapshot the stream before these lists unmount.
  $effect(() => { if (rowx) saveView() })
  onDestroy(saveView)
</script>

<div class="reply-list" class:preparing={!prepared}>
{#if slice?.total === 0 && !slice.more && depth === 0}
  <p class="dim small">no replies yet.</p>
{/if}
{#if slice}
  {@const children = slice.children}
  {#each visible as r, i (r.id)}
    {#if r.id === slice.tailStart}
      <p class="dim small expander">{#if r.id === reveal}your new reply is below. {/if}use “show more” to read the replies in between.</p>
    {/if}
    {@const n = children.counts.get(r.id) ?? 0}
    {@const isOpen = n > 0 && !endingOf(gates.message(chain, r.id)) && (rowx ? rowx.isOpen(r.id) : open[r.id.toString()] === true)}
    {#if rowx && remaining}
      <StreamReply {chain} msg={r} total={n} {rowx} {gateRefreshReady} reloadKey={cardReloadKey}
        separator={separator || i > 0 || r.id === slice.tailStart} kept={adjacent === r.id ? kept : []}
        expanded={isOpen} loading={loadingBranches[r.id.toString()] === true} interrupted={box.visible(chain, r.id)}
        {remaining} {onchanged} />
    {:else}
    <!-- Each reply has a short thread-line stub; siblings answer the same parent, not each other, so no line joins them. -->
    <div data-thread-card={r.id}>
    <MessageCard separator={separator || i > 0 || r.id === slice.tailStart} {gateRefreshReady} reloadKey={cardReloadKey}
      {chain}
      msg={r}
      replyCount={n}
      expanded={isOpen}
      repliesLoading={loadingBranches[r.id.toString()] === true}
      onexpand={() => toggle(r)}
      continuesAbove={true}
      connector={isOpen}
      {onchanged}
    />
    </div>
    <InlineReply {chain} id={r.id} onposted={(replyId) => landed(r, replyId)} />
    {/if}
    {#if isOpen}
      {#if rowx}
        <StreamBranch {rowx} {resume} displayed={displayed && prepared} separator={box.visible(chain, r.id)} {gateRefreshReady} {chain} id={r.id} reloadKey={cardReloadKey}
          {onchanged}
          onloading={loading => { if (loading) loadingBranches[r.id.toString()] = true; else delete loadingBranches[r.id.toString()] }} />
      {:else}
        <Replies {onvisible} displayed={displayed && prepared} separator={box.visible(chain, r.id)} onloading={loading => { if (loading) loadingBranches[r.id.toString()] = true; else delete loadingBranches[r.id.toString()] }} {gateRefreshReady} {chain} parentId={r.id} depth={depth + 1} data={children} reloadKey={cardReloadKey} reveal={arrived[r.id.toString()]} {shown} {views} {onchanged} />
      {/if}
    {/if}
  {/each}
{/if}
{#if slice?.more}
  <div class="expander small">
    <button onclick={showMore} aria-disabled={rows.pending}>{#if rows.pending}reading replies…{:else if step > 0}show {step} more {step === 1 ? 'reply' : 'replies'}{:else}show more replies{/if}</button>
  </div>
{/if}
</div>
{#if !error && !prepared}<ReplyLoading {onloading} {waited} />{/if}
{#if error}<LoadError {error} updating={slice !== null} what="replies" onretry={() => again++} />{/if}

{#if prepared && remaining && adjacent === null}{@render remaining(kept)}{/if}

<style>
  .reply-list { display: contents; }
  .reply-list.preparing { display: none; }
</style>

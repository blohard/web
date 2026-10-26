<script lang="ts">
  import Loading from '../../shared/Loading.svelte'
  import { loadingDelay } from '../../shared/loading-delay.svelte'
  // A timeline: the posts a filter selects (features/streams/feed.ts), as rows. A reply is
  // shown as a pair with the post it answers. Below
  // the rows a control reveals more cached groups before walking further
  // back. A refresh retains every still-selected displayed row; returning to a stream
  // within a visit restores its shown rows and reading position. A browser reload resets it.
  import { onDestroy, untrack } from 'svelte'
  import { FirstScreen, provideFirstScreen, revealStream } from '../../shared/first-screen.svelte'
  import { feedKey, mountFeed, loadFeed, resumeFeed, olderFeed, peekFeed, type Page } from './feed'
  import { appliesMutes, type Filter } from './feed-policy'
  import { refreshCue } from '../../shared/refresh-cue.svelte'
  import { shortDate } from '../../lib/format'
  import { muted } from '../../lib/muted.svelte'
  import { expansionOf, resetExpansion, RowExpansion } from './stream-expansion'
  import { rememberStream, streamPosition } from '../navigation/stream-position'
  import { visitPlace } from '../navigation/visit-position'
  import { router, type HomeRequest } from '../navigation/router.svelte'
  import type { ChainInfo } from '../../lib/types'
  import Empty from '../../shared/Empty.svelte'
  import ConversationRow from './ConversationRow.svelte'
  import Retained from '../../shared/Retained.svelte'
  import FirstScreenRow from '../../shared/FirstScreenRow.svelte'
  import KeyActivityRow from '../keys/KeyActivityRow.svelte'
  import { EveryoneActivity, postActivity, type ActivityPage } from './everyone-activity'
  import { host } from '../../lib/host.svelte'
  import { pollVisible } from '../../shared/visible-poll'

  // Data reloads include local actions; only reader refreshes advance refreshRevision.
  // `waited` is the opening's wait when a step before the stream, such as reading the keyring, already started it.
  let { chain, filter, emptyMessage, reloadRevision = 0, refreshRevision = 0, restorePosition = true, topRequest = null, waited, onsettled, onactivitychange }: { chain: ChainInfo; filter: Filter; emptyMessage?: string; reloadRevision?: number; refreshRevision?: number; restorePosition?: boolean; topRequest?: HomeRequest | null; waited?: () => boolean; onsettled?: (reloadRevision: number, ok: boolean) => void; onactivitychange?: (changed: boolean) => void } = $props()
  // Each stream's place in the visit this feed opened in, shared with its page's other tabs.
  const visit = untrack(() => router.visit)
  const place = visitPlace()
  const positions = place.streams
  const market = $derived(filter.kind === 'timeline' && !filter.curatedOnly ? host.keyringMarket(chain.id) : null)
  const activity = $derived.by(() => {
    const current = chain, address = market, key = feedKey(chain, filter)
    return address ? untrack(() => visit.state(`everyone-activity/${key}/${address}`, () => new EveryoneActivity(current, address))) : null
  })
  $effect(() => {
    const current = activity, changed = onactivitychange
    if (!current) { changed?.(false); return }
    const stop = pollVisible(() => current.keys.peek(), value => changed?.(current.keys.changed(value)), () => {}, 30_000, false)
    return () => { stop(); changed?.(false) }
  })
  function enrich(read: Promise<Page>, refresh: boolean, preserve: boolean): Promise<ActivityPage> {
    const current = activity, revision = current?.keys.revision
    const result = current ? current.load(read, refresh, preserve) : read.then(postActivity)
    void result.then(p => { if (activity === current && current?.keys.revision !== revision && !p.keyError) onactivitychange?.(false) }, () => {})
    return result
  }
  let entrance = $state.raw<FirstScreen | null>(null)
  provideFirstScreen(() => walk?.base === page ? walk.screen : entrance)
  onDestroy(() => { entrance?.finish(); walk?.screen.finish() })
  let inPlaceReloadRevision = $state(0)
  let identity = $derived(feedKey(chain, filter))
  // One delay spans the page read and its cards preparing their first display.
  const spinnerReady = untrack(() => waited) ?? loadingDelay(() => identity)
  $effect(() => {
    const cue = refreshCue.cueCount()
    const resume = untrack(() => !!streamPosition(feedKey(chain, filter), positions))
    const leave = mountFeed(chain, filter, cue.set, { resume })
    return () => { leave(); cue.stop() }
  })
  /**
   * Conversations opened in place under their cards, and the choices made inside
   * them, remembered per stream until the reader presses Refresh or Home.
   */
  let expansionRevision = $state(0)
  let expansion = $derived.by(() => { void expansionRevision; return expansionOf(identity) })
  /** One handle per row of this mount. Back mounts anew, so a reply revealed in a branch is not replayed. */
  const handles = $derived.by(() => { void expansion; return new Map<bigint, RowExpansion>() })
  function rowOf(row: bigint): RowExpansion {
    let h = handles.get(row)
    if (!h) {
      h = new RowExpansion(expansion, row)
      handles.set(row, h)
    }
    return h
  }

  // Reloads when the refresh counter or the muted list changes. The first
  // load restores a visited stream's limit or starts at twenty. Later loads
  // keep every still-selected row. Explicit Refresh advances `refreshRevision`,
  // resets expansion choices, recalculates previews and returns to the top. Posting, deletion
  // and retries preserve previews and reload without moving the reader. A Home
  // press resets the same choices but reuses the displayed snapshot.
  let resuming = $state(false)
  let loaded: string | null = null
  let seenRefresh = untrack(() => refreshRevision)
  const pressed = new WeakSet<Page>()
  let page = $state.raw<Promise<ActivityPage> | null>(null)
  let gateRefreshReady = $state.raw<Promise<ActivityPage> | null>(null)
  // This effect starts a read. It never subscribes to the result it updates.
  $effect(() => {
    const key = identity, currentChain = chain, currentFilter = filter, currentReload = reloadRevision, currentRefresh = refreshRevision, home = topRequest
    void inPlaceReloadRevision
    void muted.addresses
    untrack(() => {
      const firstLoad = loaded !== key
      const press = !firstLoad && currentRefresh !== seenRefresh
      const fold = !!home && !home.folded
      if (home) home.folded = true
      if ((press || fold) && resetExpansion(key)) expansionRevision++
      loaded = key
      const saved = firstLoad ? streamPosition(key, positions) : undefined
      resuming = !!saved
      entrance?.finish()
      walk?.screen.finish()
      walk = null
      if (firstLoad) entrance = new FirstScreen()
      const screen = entrance
      const posts = (saved || fold) && !press
        ? resumeFeed(currentChain, currentFilter, saved?.limit, !fold)
        : loadFeed(currentChain, currentFilter, { preserveVisibleRows: !firstLoad, preservePreviews: !press })
      const read = enrich(posts, !saved && !fold && (firstLoad || press), !firstLoad)
      if (press) read.then((p) => pressed.add(p), () => {})
      page = read
      if (firstLoad || currentRefresh !== seenRefresh) gateRefreshReady = read
      seenRefresh = currentRefresh
      read.then(
        () => { if (page === read) { screen?.start(); onsettled?.(currentReload, true) } },
        () => { if (page === read) { screen?.finish(); onsettled?.(currentReload, false) } },
      )
    })
  })
  // Home shares its poll with notifications. Profile streams need their own,
  // including a check on return to a retained snapshot.
  $effect(() => {
    const c = chain, f = filter
    if (f.kind !== 'author' && f.kind !== 'author-replies') return
    void reloadRevision
    void inPlaceReloadRevision
    void muted.addresses
    return pollVisible(() => peekFeed(c, f), () => {}, () => {}, 30_000)
  })

  /**
   * A walk belongs to the load it extended. Its result goes through the same
   * retained view as a refresh, so a later refresh keeps the walked page on
   * screen until it finishes. The reader serializes walks and refreshes.
   */
  type Walk = { base: Promise<ActivityPage>; request: Promise<ActivityPage>; looking: boolean; known: Set<string>; screen: FirstScreen }
  let walk = $state.raw<Walk | null>(null)
  let request = $derived(walk?.base === page ? walk.request : page)
  const paging = $derived(walk?.base === page ? walk : null)
  const pagingBusy = $derived(!!paging && (paging.looking || paging.screen.waiting))
  const pagingSpinner = loadingDelay(() => pagingBusy ? paging!.request : null)
  async function showOlder(shown: ActivityPage) {
    if (!page || pagingBusy) return
    const base = page
    const request = enrich(olderFeed(chain, filter, shown.limit + 20), false, true)
    const screen = new FirstScreen(true)
    const current = { base, request, looking: true, screen, known: new Set(shown.entries.slice(0, shown.limit).map(row => row.key)) }
    walk = current
    try {
      await request
      if (walk?.request === request) screen.start()
    } catch {
      screen.finish()
      // Retained shows the error with the previous page and a retry.
    } finally {
      if (walk?.request === request) walk = { ...current, looking: false }
    }
  }
  /** On a profile the reader opened on purpose, a muted author's posts are shown, not collapsed. */
  let collapseMuted = $derived(appliesMutes(filter))
</script>

{#snippet loadingPosts()}
  {#if spinnerReady()}<Loading label="loading posts…" overlay />{/if}
{/snippet}

{#if request}
<div class="stream-start">
<Retained {request} {identity} loading={loadingPosts} onretry={() => inPlaceReloadRevision++}>
  {#snippet children(p)}
  {@const w = paging}
  {#if entrance?.waiting}{@render loadingPosts()}{/if}
  <div use:revealStream={w && !w.looking ? w.screen : entrance} inert={entrance?.waiting ?? false} style:visibility={entrance?.waiting ? 'hidden' : undefined} use:rememberStream={{ key: identity, limit: p.limit, restore: restorePosition, topRequest, positions, arrived: pressed.has(p) ? p : undefined }}>
  {#if p.keyError}<p class="err small">could not update key activity. <button onclick={() => inPlaceReloadRevision++}>try again</button></p>{/if}
  {#if p.entries.length === 0 && p.complete}
    <Empty>
      {#if emptyMessage}{emptyMessage}
      {:else if filter.kind === 'following'}posts from accounts you follow and replies to you appear here.
      {:else if filter.kind === 'author'}no posts to show for this account yet.
      {:else if filter.kind === 'author-replies'}no replies to show from this account yet.
      {:else if filter.curatedOnly}no curated posts to show yet. try the everyone tab.
      {:else}no posts to show yet. start a conversation.
      {/if}
    </Empty>
  {:else}
    <!-- A conversation keeps its row when a newer reply becomes the group's lead. -->
    {#each p.entries.slice(0, p.limit) as entry (entry.key)}
      {@const staged = !!w?.screen.waiting && !w.known.has(entry.key)}
      <div data-feed-row={entry.kind === 'post' ? entry.key : undefined} class:staged inert={staged}>
        {#if entry.kind === 'key'}
          <FirstScreenRow id={entry.key}><KeyActivityRow event={entry.event} {chain} /></FirstScreenRow>
        {:else}
          {#key rowOf(entry.row.key)}
          <ConversationRow resume={resuming} {gateRefreshReady} reloadKey={page} {chain} page={p} row={entry.row} {collapseMuted} rowx={rowOf(entry.row.key)} onchanged={() => inPlaceReloadRevision++} />
          {/key}
        {/if}
      </div>
    {/each}
    <!-- Stream-wide paging is separate from each card's reply controls.
         Keep the button mounted during a read so keyboard focus stays put. -->
    <nav class="stream-paging" aria-label="stream pagination">
      {#if p.complete && p.entries.length <= p.limit && !pagingBusy}
        <p class="dim small" role="status">you've reached the end of this stream</p>
      {:else}
        <button aria-disabled={pagingBusy} aria-busy={pagingBusy} onclick={() => showOlder(p)}>
          <span class="paging-label" class:working={pagingSpinner()}>show more posts<span class="spinner" aria-hidden="true"></span></span>
        </button>
          <p class="operation-status dim small" role="status">
            {#if p.entries.length <= p.limit && p.reach}{p.entries.length === 0 ? 'nothing' : 'posts'} back to {shortDate(p.reach)}{/if}
          </p>
          {#if pagingSpinner()}<span class="visually-hidden" role="status">loading more posts…</span>{/if}
      {/if}
    </nav>
  {/if}
  </div>
  {/snippet}
</Retained>
</div>
{/if}

<style>
  .stream-start { position: relative; }
  .staged { height: 0; overflow: hidden; visibility: hidden; }
  .stream-paging button::before, .stream-paging button::after { content: none; }
  .paging-label { position: relative; display: inline-block; }
  .paging-label::before { content: '[ '; }
  .paging-label::after { content: ' ]'; }
  .paging-label > .spinner { position: absolute; left: calc(100% + .7rem); top: 50%; margin: -.5rem 0 0; width: 1rem; height: 1rem; border-radius: 0; color: var(--accent); }
</style>

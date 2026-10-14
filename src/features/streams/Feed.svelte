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
  import { feedKey, mountFeed, loadFeed, resumeFeed, olderFeed, type Page } from './feed'
  import { appliesMutes, type Filter } from './feed-policy'
  import { refreshCue } from '../../shared/refresh-cue.svelte'
  import { shortDate } from '../../lib/format'
  import { muted } from '../../lib/muted.svelte'
  import { expansionOf, RowExpansion } from './stream-expansion'
  import { rememberStream, streamPosition } from '../navigation/stream-position'
  import { visitPlace } from '../navigation/visit-position'
  import type { ChainInfo } from '../../lib/types'
  import Empty from '../../shared/Empty.svelte'
  import ConversationRow from './ConversationRow.svelte'
  import Retained from '../../shared/Retained.svelte'

  // Data reloads include local actions; only reader refreshes advance refreshRevision.
  // `waited` is the opening's wait when a step before the stream, such as reading the keyring, already started it.
  let { chain, filter, emptyMessage, reloadRevision = 0, refreshRevision = 0, restorePosition = true, topRequest = null, waited, onsettled }: { chain: ChainInfo; filter: Filter; emptyMessage?: string; reloadRevision?: number; refreshRevision?: number; restorePosition?: boolean; topRequest?: { shown: boolean } | null; waited?: () => boolean; onsettled?: (reloadRevision: number, ok: boolean) => void } = $props()
  // Each stream's place in the visit this feed opened in, shared with its page's other tabs.
  const positions = visitPlace().streams
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
   * them, remembered per stream for this tab. Only a press changes the set; a
   * refresh reopens the same branches and never adds or folds one.
   */
  let expansion = $derived(expansionOf(identity))
  /** One handle per row of this mount. Back mounts anew, so a reply revealed in a branch is not replayed. */
  const handles = new Map<string, RowExpansion>()
  function rowOf(row: bigint): RowExpansion {
    const key = `${identity}/${row}`
    let h = handles.get(key)
    if (!h) {
      h = new RowExpansion(expansion, row)
      handles.set(key, h)
    }
    return h
  }

  // Reloads when the refresh counter or the muted list changes. The first
  // load restores a visited stream's limit or starts at twenty. Later loads
  // keep every still-selected row. Explicit Refresh advances `refreshRevision`,
  // recalculates automatic previews and returns to the top. Posting, deletion
  // and retries preserve previews and reload without moving the reader.
  let resuming = $state(false)
  let loaded: string | null = null
  let seenRefresh = untrack(() => refreshRevision)
  const pressed = new WeakSet<Page>()
  let page = $state.raw<Promise<Page> | null>(null)
  let gateRefreshReady = $state.raw<Promise<Page> | null>(null)
  // This effect starts a read. It never subscribes to the result it updates.
  $effect(() => {
    const key = identity, currentChain = chain, currentFilter = filter, currentReload = reloadRevision, currentRefresh = refreshRevision
    void inPlaceReloadRevision
    void muted.addresses
    untrack(() => {
      const firstLoad = loaded !== key
      const press = !firstLoad && currentRefresh !== seenRefresh
      loaded = key
      const saved = firstLoad ? streamPosition(key, positions) : undefined
      resuming = !!saved
      entrance?.finish()
      walk?.screen.finish()
      walk = null
      if (firstLoad) entrance = saved ? null : new FirstScreen()
      const screen = entrance
      const read = saved
        ? resumeFeed(currentChain, currentFilter, saved.limit)
        : loadFeed(currentChain, currentFilter, { preserveVisibleRows: !firstLoad, preservePreviews: !press })
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
  /**
   * A walk belongs to the load it extended. Its result goes through the same
   * retained view as a refresh, so a later refresh keeps the walked page on
   * screen until it finishes. The reader serializes walks and refreshes.
   */
  type Walk = { base: Promise<Page>; request: Promise<Page>; looking: boolean; known: Set<bigint>; screen: FirstScreen }
  let walk = $state.raw<Walk | null>(null)
  let request = $derived(walk?.base === page ? walk.request : page)
  const paging = $derived(walk?.base === page ? walk : null)
  const pagingBusy = $derived(!!paging && (paging.looking || paging.screen.waiting))
  const pagingSpinner = loadingDelay(() => pagingBusy ? paging!.request : null)
  async function showOlder(shown: Page) {
    if (!page || pagingBusy) return
    const base = page
    const request = olderFeed(chain, filter)
    const screen = new FirstScreen(true)
    const current = { base, request, looking: true, screen, known: new Set(shown.rows.slice(0, shown.limit).map(row => row.key)) }
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
  {#if p.rows.length === 0 && p.complete}
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
    {#each p.rows.slice(0, p.limit) as row (row.key)}
      {@const staged = !!w?.screen.waiting && !w.known.has(row.key)}
      <div data-feed-row={row.key} class:staged inert={staged}>
        <ConversationRow resume={resuming} {gateRefreshReady} reloadKey={page} {chain} page={p} {row} {collapseMuted} rowx={rowOf(row.key)} onchanged={() => inPlaceReloadRevision++} />
      </div>
    {/each}
    <!-- Stream-wide paging is separate from each card's reply controls.
         Keep the button mounted during a read so keyboard focus stays put. -->
    <nav class="stream-paging" aria-label="stream pagination">
      {#if p.complete && p.rows.length <= p.limit && !pagingBusy}
        <p class="dim small" role="status">you've reached the end of this stream</p>
      {:else}
        <button aria-disabled={pagingBusy} aria-busy={pagingBusy} onclick={() => showOlder(p)}>
          <span class="paging-label" class:working={pagingSpinner()}>show more posts<span class="spinner" aria-hidden="true"></span></span>
        </button>
          <p class="operation-status dim small" role="status">
            {#if p.rows.length <= p.limit && p.reach}{p.rows.length === 0 ? 'nothing' : 'posts'} back to {shortDate(p.reach)}{/if}
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

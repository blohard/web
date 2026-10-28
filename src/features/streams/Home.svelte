<script lang="ts">
  import Loading from '../../shared/Loading.svelte'
  import { loadingDelay } from '../../shared/loading-delay.svelte'
  // The timeline: compose at the top, everyone's top-level posts below, with
  // your own replies shown under the posts they answer. Everyone and following
  // include direct replies to you; curated selects listed authors' posts and
  // replies, your replies to them, and replies to you when curated. Keyring
  // selects its own authors. Mutes apply.
  // Your posts and replies also live on your profile; replies to you under
  // notifications as well.
  import { tick as settled, untrack } from 'svelte'
  import { host } from '../../lib/host.svelte'
  import { placeOf } from '../navigation/visit-position'
  import { KeyringView } from './keyring-view.svelte'
  import { feedKey, peekFeed } from './feed'
  import { homePosted } from './home-posted'
  import type { HomeFilter } from './feed-policy'
  import { draft } from '../publishing/draft.svelte'
  import { follows } from '../../lib/follows.svelte'
  import { refreshCue } from '../../shared/refresh-cue.svelte'
  import { pollVisible } from '../../shared/visible-poll'
  import { notificationDot } from '../notifications/notification-dot.svelte'
  import { muted } from '../../lib/muted.svelte'
  import { leavePage } from '../navigation/page-position'
  import { href, router } from '../navigation/router.svelte'
  import { sameAddress } from '../../lib/format'
  import { readJSON, writeJSON } from '../../lib/storage'
  import type { ChainInfo } from '../../lib/types'
  import { wallet } from '../../lib/wallet.svelte'
  import Composer from '../publishing/Composer.svelte'
  import ConnectPrompt from '../../components/ConnectPrompt.svelte'
  import Empty from '../../shared/Empty.svelte'
  import Feed from './Feed.svelte'
  import PendingUploads from '../publishing/PendingUploads.svelte'

  let { chain, refreshRevision = 0, onstream = () => {} }: { chain: ChainInfo; refreshRevision?: number; onstream?: (selected: (() => Tab) | null) => void } = $props()

  let actionReloadRevision = $state(0)
  let keyActivityChanged = $state(false)
  let feedStatus = $state<'updating' | 'failed' | null>(null)
  let postedReloadRevision: number | null = null
  function reloadAfterPost() {
    actionReloadRevision++
    postedReloadRevision = refreshRevision + actionReloadRevision
    feedStatus = 'updating'
  }
  function feedSettled(loadedRevision: number, ok: boolean) {
    if (postedReloadRevision === null || loadedRevision < postedReloadRevision) return
    feedStatus = ok ? null : 'failed'
    postedReloadRevision = null
  }
  let reloadRevision = $derived(refreshRevision + actionReloadRevision)
  let focusRequest = $state<number | null>(null)
  let restorePosition = $state(true)
  // Quoting is an event the draft delivers here (a press made before this page
  // mounted arrives once it has). The effect only subscribes; a quote goes to
  // the composer, and the feed keeps no saved position, even if it mounts later.
  $effect(() =>
    draft.onPress((press) => {
      focusRequest = press
      restorePosition = false
    }),
  )
  /**
   * Four views: "following" (followed authors plus your own), "keyring"
   * (holders or held accounts), "curated" (the host's list) and "everyone".
   * The choice sticks per browser; the list view is the default where the
   * host publishes a list, everyone otherwise.
   */
  type Tab = 'following' | 'keyring' | 'curated' | 'everyone'
  const TAB_KEY = 'blohard.home.tab'
  function readTab(): Tab {
    const t = readJSON<unknown>(TAB_KEY, null)
    if (t === 'everyone' || t === 'following' || t === 'curated' || t === 'keyring') return t
    return chain.curated ? 'curated' : 'everyone'
  }
  const visit = untrack(() => router.visit)
  const saved = $derived.by(() => {
    const key = `home/${chain.id}/${chain.contract}`
    return untrack(() => visit.state(key, () => {
      const state = $state({ tab: readTab(), keyringSide: 'holding' as 'holders' | 'holding' })
      return state
    }, previous => {
      const state = $state({ ...previous })
      return state
    }))
  })
  /** The tab's stream is remounted; its position is saved first, as the router does before a page change. */
  function pick(t: Tab) {
    // Pressing the tab already shown changes nothing; saving now would end the bookmark early.
    if (t === saved.tab) return
    leavePage()
    saved.tab = t
    writeJSON(TAB_KEY, t)
  }
  /** A curated tab without a host list falls back to everyone. */
  const keyringMarket = $derived(host.keyringMarket(chain.id))
  const keyringIdentity = $derived(`${chain.id}/${keyringMarket}/${wallet.account}`)
  // Membership snapshots stay shared; the selected tab and side are copied above.
  const keyring = $derived.by(() => { void keyringIdentity; return untrack(() => visit.state(`home-keyring/${chain.contract}/${keyringIdentity}`, () => new KeyringView(), value => value)) })
  const keyringError = $derived(keyring.error)
  const activated = $derived(keyring.shown?.active ?? false)
  const keyringActive = $derived(keyring.available)
  // Quiet polls cannot remove the selected feed. Its displayed snapshot remains
  // relevant until refresh, even after the last holding has been sold.
  const keyringRelevant = $derived(!!wallet.account && !!keyringMarket
    && (keyringActive || !!keyring.shown?.active || !!keyring.shown?.holding.length))
  // Keep the selected keyring's connect prompt after restoration times out.
  // A late wallet answer must not replace an unrelated stream on screen.
  let effective = $derived<Tab>((saved.tab === 'curated' && !chain.curated) || (saved.tab === 'keyring' && !keyringMarket) ? 'everyone' : saved.tab)
  // App reads the active stream for its sticky heading and key-page colour.
  // The getter shares the effective choice without copying state.
  $effect(() => {
    onstream(() => effective)
    return () => onstream(null)
  })
  const keyringView = $derived(keyring.shown && !activated && saved.keyringSide === 'holders' ? 'holding' : saved.keyringSide)
  const heldAuthors = $derived(keyring.shown?.[keyringView] ?? null)
  // Opening a keyring view may read the keyring before its stream: one wait covers both.
  // It follows the reader's choice, not the holders-to-holding fallback once the keyring arrives.
  const keyringWait = loadingDelay(() => effective === 'keyring' && wallet.account ? `${keyringIdentity}/${saved.keyringSide}` : null)
  $effect(() => refreshCue.cueChanges(() => effective === 'keyring' ? keyring.changed(keyringView) : effective === 'everyone' && keyActivityChanged))
  /** On a narrow bar, the chosen tab is scrolled fully into view, sideways only, so the page never moves. */
  function showActive(bar: HTMLElement, _chosen: Tab) {
    const reveal = () => void settled().then(() => {
      const button = bar.querySelector<HTMLElement>('button.active')
      if (!button) return
      const edge = bar.getBoundingClientRect(), own = (button.closest('.tab-group') ?? button).getBoundingClientRect()
      if (own.left < edge.left) bar.scrollLeft += own.left - edge.left - 16
      else if (own.right > edge.right) bar.scrollLeft += own.right - edge.right + 16
    })
    reveal()
    return { update: reveal }
  }
  function pickKeyring(side: 'holders' | 'holding') {
    if (side === saved.keyringSide) return
    leavePage()
    saved.keyringSide = side
  }
  let seenRefresh = untrack(() => refreshRevision)
  $effect(() => {
    const c = chain, holder = wallet.account, market = keyringMarket, view = keyring, selected = saved.tab === 'keyring'
    const refresh = refreshRevision !== seenRefresh
    seenRefresh = refreshRevision
    if (!holder || !market) return
    return untrack(() => view.watch(c, holder, market, selected, refresh, refresh ? () => {
      // A refreshed membership may remount a previously visited filter. That
      // is still a refresh, so its feed must read current posts rather than resume.
      placeOf(visit).streams.delete(feedKey(c, filter))
    } : undefined))
  })
  let curatedOnly = $derived(effective === 'curated')
  /** The following view: the authors this browser follows, and you; with a wallet, every direct reply to your messages too. */
  let followed = $derived.by(() => {
    const me = wallet.account
    return me ? [me, ...follows.addresses.filter((a) => !sameAddress(a, me))] : follows.addresses
  })
  let filter = $derived<HomeFilter>(
    effective === 'keyring'
      ? { kind: 'following', authors: heldAuthors ?? [], viewer: wallet.account ?? undefined, includeRepliesToViewer: false }
      : effective === 'following'
      ? { kind: 'following', authors: followed, viewer: wallet.account ?? undefined, includeRepliesToViewer: true }
      : { kind: 'timeline', curatedOnly, viewer: wallet.account ?? undefined },
  )

  // Capture the sending view. A confirmation after a tab or wallet change
  // must not move the reader out of the view they chose meanwhile.
  const posted = $derived.by(() => {
    const c = chain, selection = filter
    return (id: bigint) => homePosted(c, selection, id,
      () => chain === c && filter === selection, reloadAfterPost)
  })

  // The quiet poll cues the refresh button with the posts a refresh would add
  // (shared/refresh-cue.svelte.ts); the feed itself never moves until it is pressed.
  $effect(() => {
    if (effective === 'keyring' && (!wallet.account || !heldAuthors)) return
    const c = chain
    const f = filter
    void reloadRevision
    void muted.addresses // the feed reloads when it changes, so the count starts over
    // Its answers also carry the reader's new replies, mentions and quotes to the notifications dot.
    const listener = wallet.account ? notificationDot.listen(c, wallet.account) : undefined
    return pollVisible(() => peekFeed(c, f, listener), () => {},
      () => { /* A later poll retries; keep the last cue. */ }, 30_000)
  })
</script>

<nav class="tabs small" data-tab-row use:showActive={effective}>
  <button class:active={effective === 'following'} onclick={() => pick('following')}>
    following
  </button>
  {#if keyringRelevant || effective === 'keyring'}
    <span class="tab-group">
      <button class:active={effective === 'keyring'} onclick={() => pick('keyring')}>keyring</button>
      {#if effective === 'keyring' && wallet.account}
        <span class="dim" aria-hidden="true">·</span>
        <a class="tab-action" aria-label="manage your keyring" href={keyringView === 'holders' ? href.keyHolders(chain.id, wallet.account) : href.keyring(chain.id, wallet.account)}>manage ↗</a>
      {/if}
    </span>
  {/if}
  {#if chain.curated}
    <span class="tab-group">
      <button class:active={effective === 'curated'} onclick={() => pick('curated')}>curated</button>
      {#if effective === 'curated'}
        <span class="dim" aria-hidden="true">·</span>
        <a class="tab-action" aria-label="view curated accounts" href={href.list()}>accounts ↗</a>
      {/if}
    </span>
  {/if}
  <button class:active={effective === 'everyone'} onclick={() => pick('everyone')}>everyone</button>
</nav>

<PendingUploads {chain} {reloadRevision} onchanged={() => actionReloadRevision++} />
{#if wallet.account || wallet.restoring}
  <div class="home-composer">
  {#if wallet.account}
  <Composer {chain} {focusRequest} owner={draft} {feedStatus} onposted={posted} />
  {:else}
    <p class="dim small restoring-wallet" role="status">connecting to your wallet…</p>
  {/if}
  </div>
{:else}
  <ConnectPrompt {chain} toDo="to post" {focusRequest} />
{/if}

{#if effective === 'keyring'}
  <nav class="key-tabs keyring-tabs" data-tab-row aria-label="keyring views">
    <button class:active={keyringView === 'holding'} aria-pressed={keyringView === 'holding'} onclick={() => pickKeyring('holding')}>keys I hold</button>
    <button class:active={keyringView === 'holders'} aria-pressed={keyringView === 'holders'} disabled={!activated} onclick={() => pickKeyring('holders')}>my key holders</button>
  </nav>
  {#if keyring.shown?.truncated[keyringView]}<p class="keyring-note small dim">partial feed · showing the first 256 accounts</p>{/if}
  {#if keyringError}<p class="keyring-note err" role="alert">{keyringError}. this page checks again automatically.</p>{/if}
{/if}
{#if effective === 'keyring' && !wallet.account}
  <Empty>{wallet.restoring ? 'connecting to your wallet…' : 'connect your wallet to see your keyring.'}</Empty>
{:else if effective === 'keyring' && heldAuthors === null}
  <div class="keyring-start" aria-busy={!keyringError}>{#if !keyringError && keyringWait()}<Loading label="loading your keyring…" overlay />{/if}</div>
{:else if effective === 'following' && followed.length === 0}
  <Empty>posts from accounts you follow appear here. open a profile and choose follow.</Empty>
{:else}
  <!-- The tab leads, since keyring and following can share a filter; the keyring side counts only on its own tab, so it never remounts another. -->
  {#key `${effective === 'keyring' ? keyringView : effective}/${feedKey(chain, filter)}`}
    <Feed onactivitychange={changed => keyActivityChanged = changed} {chain} {filter} {reloadRevision} emptyMessage={effective === 'keyring' ? heldAuthors?.length ? 'no posts from your keyring yet.' : keyringView === 'holders' ? 'no key holders yet.' : 'you hold no keys to other accounts yet.' : undefined} {refreshRevision} waited={effective === 'keyring' ? keyringWait : undefined} onsettled={feedSettled} {restorePosition} topRequest={router.homeTop} />
  {/key}
{/if}

<style>
  .home-composer { min-height: 10rem; border-bottom: 1px dashed var(--border); }
  .home-composer :global(.composer) { border-bottom: 0; }
  .restoring-wallet { margin: 0; padding: .8rem 1rem; }
  @media (max-width: 600px) { .home-composer { min-height: 11rem; } }
  .keyring-note { padding: 0 1rem; }
  /* One line at any width: a narrow column scrolls the tabs sideways instead of wrapping them. */
  nav.tabs { overflow-x: auto; scrollbar-width: none; overscroll-behavior-x: contain; }
  nav.tabs::-webkit-scrollbar { display: none; }
  nav.tabs button { flex-shrink: 0; white-space: nowrap; }
  .tab-group { display: inline-flex; align-items: baseline; gap: .35rem; flex-shrink: 0; white-space: nowrap; }
  .tab-action { font-size: .86em; }
  /* Styled as the keyring page's own tabs (KeyringManagement.svelte), which these mirror. */
  .keyring-tabs { margin: 1rem 1rem 0; }
  /* Where the stream's own spinner appears, so handing over cannot move it. */
  .keyring-start { position: relative; }
</style>

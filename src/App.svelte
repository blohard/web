<script lang="ts">
  import { untrack } from 'svelte'
  $effect(() => watchHostPolicy())
  import { fly } from 'svelte/transition'
  import { explain } from './lib/errors'
  import { chainTag, initialChainId, isTestnet } from './lib/chains'
  import { keyControls } from './features/keys/key-controls.svelte'
  import { forgetKeyrings } from './features/keys/keyring'
  import { refreshCue } from './shared/refresh-cue.svelte'
  import { host } from './lib/host.svelte'
  import { hostStatus, readRelay } from './lib/host-status.svelte'
  import { readHostPolicy, watchHostPolicy } from './lib/host-policy'
  import { names } from './lib/names.svelte'
  import { sponsorship } from './features/publishing/sponsorship.svelte'
  import { href, router } from './features/navigation/router.svelte'
  import { tabTitle } from './features/navigation/page-title'
  import { belowTabs } from './shared/below-tabs'
  import { readJSON, writeJSON } from './lib/storage'
  import type { ChainInfo } from './lib/types'
  import { wallet } from './lib/wallet.svelte'
  import About from './components/About.svelte'
  import Empty from './shared/Empty.svelte'
  import Following from './features/account/Following.svelte'
  import Home from './features/streams/Home.svelte'
  import Loading from './shared/Loading.svelte'
  import ListPage from './features/account/ListPage.svelte'
  import Notice from './shared/Notice.svelte'
  import Notifications from './features/notifications/Notifications.svelte'
  import Profile from './features/account/Profile.svelte'
  import Sidebar from './features/navigation/Sidebar.svelte'
  import Settings from './features/account/Settings.svelte'
  import Thread from './features/streams/Thread.svelte'
  import WalletControl from './components/WalletControl.svelte'

  const STORAGE_KEY = 'blohard.chain'
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

  let selectedId = $state<number | null>(readJSON<number | null>(STORAGE_KEY, null))
  /** Bumped by the refresh control; every page reloads what it shows. */
  let refreshRevision = $state(0)
  /** The effective stream, lent by Home while it is mounted. */
  let homeStream = $state.raw<(() => string) | null>(null)
  const stream = $derived(router.route.kind === 'home' ? homeStream?.() : null)
  const keyPage = $derived(router.route.kind === 'keys' || router.route.kind === 'keyring'
    || (router.route.kind === 'user' && !!router.route.keys)
    || stream === 'keyring')

  function select(id: number) {
    selectedId = id
    writeJSON(STORAGE_KEY, id)
    router.go(href.settings(id))
  }

  $effect(() => {
    const stopRelay = readRelay()
    const stopStatus = hostStatus.start((s) => { selectedId = initialChainId(s.chains, selectedId) })
    return () => { stopRelay(); stopStatus() }
  })

  let status = $derived(host.status)
  let selected = $derived<ChainInfo | null>(status?.chains.find((c) => c.id === selectedId) ?? null)

  /** Every view reloads; the reader's own sponsorship is asked again too, so being added shows up at once. */
  function refresh() {
    if (selected && wallet.account) {
      void readHostPolicy().catch(() => {})
      sponsorship.forget(selected, wallet.account)
    }
    forgetKeyrings()
    refreshCue.clear()
    refreshRevision++
  }

  /** Thread and profile routes name their chain; everything else uses the selector. */
  let routeChain = $derived.by((): ChainInfo | null => {
    const r = router.route
    if ('chainId' in r) return host.chain(r.chainId) ?? null
    return selected
  })
  /** The chain the page shows: the one its route names when this host serves it, otherwise the selector's. */
  let shownChain = $derived(routeChain ?? selected)
  /** The chain on screen spends worthless ETH; the page says so in large outline. */
  const testnet = $derived(!!shownChain && isTestnet(shownChain))

  $effect(() => {
    void refreshRevision
    void router.route
    if (routeChain) return keyControls.watch(routeChain, wallet.account)
  })

  let title = $derived.by(() => {
    switch (router.route.kind) {
      case 'home':
        return 'home'
      case 'notifications':
        return 'notifications'
      case 'following':
        return 'following'
      case 'list':
        return router.route.tab
      case 'keys':
        return router.route.about ? 'about account keys' : 'account keys'
      case 'about':
        return 'about'
      case 'keyring':
        return !wallet.is(router.route.address)
          ? `${names.display(router.route.address)}’s keyring` : 'my keyring'
      case 'settings':
        return 'settings'
      case 'thread':
        return 'post'
      case 'user':
        return 'profile'
      default:
        return 'not found'
    }
  })
  // A share page arrives titled by its host, with the author's name. It keeps
  // that title until the reader leaves the page; the app titles every other
  // page, including after navigating from a share page.
  const served = typeof document !== 'undefined' && document.title !== 'blohard'
  const arrived = untrack(() => router.leaves)
  $effect(() => {
    const next = tabTitle(router.route, title, (a) => names.display(a))
    if (served && router.leaves === arrived) return
    document.title = next
  })
</script>

{#if testnet}
  <!-- Decorative: the column header names the chain as a testnet in text. -->
  <div class="testnet-mark" aria-hidden="true"><span>testnet</span></div>
{/if}
<div class="shell" class:key-page={keyPage}>
  <Sidebar {keyPage} selected={shownChain} />

  <main class="column">
    <header class="colhead">
      {#if router.route.kind !== 'home'}
        <button class="back" aria-label="back" onclick={() => router.back()} title="back">←</button>
      {/if}
      <h1 class="scroll-heading">
        <button onclick={() => window.scrollTo({ top: 0, left: 0, behavior: reduceMotion ? 'instant' : 'smooth' })} title="scroll to top">
          <span>{title}</span>
          {#if stream}<span class="small">· {stream}</span>{/if}
          {#if routeChain}<span class="dim small">· {chainTag(routeChain)}</span>{/if}
        </button>
      </h1>
      {#if status && status.chains.length > 0 && refreshCue.highlighted}
        <!-- Present only when a quiet poll found something to add. It floats under the header, or under a tab row on screen, so nothing moves. -->
        <button class="refresh-control small fresh" use:belowTabs transition:fly={{ y: -6, duration: reduceMotion ? 0 : 180 }} onclick={refresh} title={refreshCue.changed ? 'keyring changes are waiting. press to show them' : 'new posts are waiting. press to show them'}>
          {refreshCue.count === Infinity ? 'refresh · new' : refreshCue.count ? `refresh · ${refreshCue.count} new` : 'refresh'}
        </button>
      {/if}
    </header>

    {#if !status && hostStatus.error}
      <Notice kind="err">could not reach the host. trying again on its own <button class="small" onclick={() => hostStatus.retry()}>try now</button> <span class="small dim">{explain(hostStatus.error)}</span></Notice>
    {:else if !status}
      <Loading label="connecting to the host…" />
    {:else if status.chains.length === 0}
      <Notice kind="err">this host serves no chains (it is running in development mode).</Notice>
    {:else if router.route.kind === 'home' && selected}
      <Home chain={selected} {refreshRevision} onstream={(selected) => { homeStream = selected }} />
    {:else if router.route.kind === 'notifications' && selected}
      <Notifications chain={selected} {refreshRevision} />
    {:else if router.route.kind === 'following' && selected}
      <Following chain={selected} />
    {:else if router.route.kind === 'keys' && routeChain && router.route.about}
      <!-- The explainer is static text: it loads without the market code. -->
      {#await import('./features/keys/AccountKeysAbout.svelte')}
        <Loading label="loading account keys…" />
      {:then page}
        {#key `${routeChain.id}/${routeChain.contract}`}<page.default chain={routeChain} />{/key}
      {:catch}
        <Notice kind="err">could not load account keys. reload the page to try again.</Notice>
      {/await}
    {:else if router.route.kind === 'keys' && routeChain}
      {#await import('./features/keys/AccountKeys.svelte')}
        <Loading label="loading account keys…" />
      {:then page}
        {#key `${routeChain.id}/${routeChain.contract}/${wallet.account}`}<page.default chain={routeChain} {refreshRevision} />{/key}
      {:catch}
        <Notice kind="err">could not load account keys. reload the page to try again.</Notice>
      {/await}
    {:else if router.route.kind === 'keyring' && routeChain}
      {#await import('./features/keys/KeyringManagement.svelte')}
        <Loading label="loading keyring…" />
      {:then page}
        {#key `${routeChain.id}/${routeChain.contract}/${router.route.address}/${host.keyringMarket(routeChain.id)}/${router.route.holders ?? false}`}
          <page.default chain={routeChain} account={router.route.address} market={host.keyringMarket(routeChain.id)} initialSide={router.route.holders ? 'holders' : 'holding'} {refreshRevision} />
        {/key}
      {:catch}
        <Notice kind="err">could not load keyring. reload the page to try again.</Notice>
      {/await}
    {:else if router.route.kind === 'about'}
      <About />
    {:else if router.route.kind === 'settings' && routeChain}
      {#key `${routeChain.id}/${routeChain.contract}/${wallet.account}`}
        <Settings chain={routeChain} address={wallet.account} {refreshRevision} onselect={select} />
      {/key}
    {:else if router.route.kind === 'list' && selected}
      {#key selected.id}
        <ListPage chain={selected} {refreshRevision} />
      {/key}
    {:else if router.route.kind === 'thread' && routeChain}
      {#key `${routeChain.id}/${router.route.id}/${router.route.commit ?? ''}`}
        <Thread chain={routeChain} id={router.route.id} commit={router.route.commit} focusReply={router.route.reply} {refreshRevision} />
      {/key}
    {:else if router.route.kind === 'user' && routeChain}
      {#key `${routeChain.id}/${router.route.address}`}
        <Profile chain={routeChain} address={router.route.address} {refreshRevision} />
      {/key}
    {:else if 'chainId' in router.route}
      <!-- A page that names a chain this host does not serve. -->
      <Notice kind="err">this host does not serve the requested chain.</Notice>
    {:else}
      <Empty>nothing at <code>{location.hash}</code>. <a href="#/">home</a></Empty>
    {/if}
  </main>

  <aside class="right">
    <WalletControl chain={shownChain} />
  </aside>
</div>

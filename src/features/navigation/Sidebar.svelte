<script lang="ts">
  // The left rail: brand and navigation. On narrow screens it becomes a
  // bar above the column, with the navigation and notice behind a menu
  // button. The wallet lives in the column header, top right.
  import mark from '../../assets/whale-mark.jpg'
  import keyMark from '../../assets/whale-key-mark.jpg'
  import { follows } from '../../lib/follows.svelte'
  import { host } from '../../lib/host.svelte'
  import { keyControls } from '../keys/key-controls.svelte'
  import { notificationDot } from '../notifications/notification-dot.svelte'
  import { plainClick, href, router } from './router.svelte'
  import type { ChainInfo } from '../../lib/types'
  import { wallet } from '../../lib/wallet.svelte'

  let {
    selected,
    keyPage = false,
  }: { keyPage?: boolean; selected: ChainInfo | null } = $props()

  let kind = $derived(router.route.kind)
  // The narrow-screen menu is open for the page it was opened on, so any
  // navigation closes it without an effect resetting state.
  let openOn = $state<object | null>(null)
  let open = $derived(openOn === router.route)
  const close = () => { openOn = null }
  /** Open at the top, reusing content from an earlier visit (router.nav). */
  function navigate(event: MouseEvent) {
    close()
    if (!plainClick(event)) return
    event.preventDefault()
    router.nav((event.currentTarget as HTMLAnchorElement).getAttribute('href')!)
  }
  function home(event: MouseEvent) {
    close()
    // Keep modified clicks as ordinary links (new tab/window).
    if (!plainClick(event)) return
    event.preventDefault()
    router.home()
  }
  // Shared stream polls plus a slower all-page check keep the favicon current while hidden.
  $effect(() => {
    const me = wallet.account, status = host.status
    if (me && status) return notificationDot.watch(status.chains, me, status.keyrings)
  })
  let dot = $derived(notificationDot.shown(wallet.account))
  // The tab's icon carries the dot too, in red so it stands out among tabs.
  $effect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (icon) icon.href = dot ? '/favicon-dot.png' : '/favicon.png'
  })
  let onOwnProfile = $derived.by(() => {
    const r = router.route
    return r.kind === 'user' && wallet.is(r.address)
  })
  let onOwnKeyring = $derived(router.route.kind === 'keyring' && wallet.account !== null
    && wallet.is(router.route.address))
</script>

<aside class="side">
  <button class="menu-toggle" aria-label={dot ? 'menu, new notifications' : 'menu'} aria-expanded={open} aria-controls="side-menu" onclick={() => { openOn = open ? null : router.route }}>☰{#if dot}<span class="dot" aria-hidden="true"></span>{/if}</button>
  <a class="brand" href={href.home()} onclick={home}><img class="mark" src={keyPage ? keyMark : mark} alt="" width="56" height="56" />blohard</a>

  <div id="side-menu" class="side-menu" class:open>
  <nav class="side">
    <a href={href.home()} onclick={home} class:active={kind === 'home'}>home</a>
    {#if wallet.account}
      <a onclick={navigate} href={href.notifications()} class:active={kind === 'notifications'}>notifications{#if dot}<span class="dot" aria-hidden="true"></span><span class="visually-hidden">{' new'}</span>{/if}</a>
      <a onclick={navigate} href={selected ? href.user(selected.id, wallet.account) : '#/'} class:active={onOwnProfile}>profile</a>
    {/if}
    <a onclick={navigate} href={href.following()} class:active={kind === 'following'}>following{#if follows.addresses.length}<span class="dim">{' · '}{follows.addresses.length}</span>{/if}</a>
    {#if selected && wallet.account && keyControls.available(selected, wallet.account)}
      <a onclick={navigate} href={href.keyring(selected.id, wallet.account)} class:active={onOwnKeyring}>keyring</a>
    {/if}
    {#if selected}
      <a onclick={navigate} href={href.settings(selected.id)} class:active={kind === 'settings'}>settings</a>
    {/if}
    <a onclick={navigate} href={href.about()} class:active={kind === 'about'}>about</a>
  </nav>

  {#if wallet.account}
    <!-- On a phone the wallet's disconnect lives here, not in the crowded top bar. -->
    <button class="menu-disconnect" disabled={wallet.busy} onclick={() => { close(); void wallet.disconnect() }}>disconnect</button>
  {/if}
  <div class="side-block small">
    {#if host.status?.notice}
      <p class="dim notice-line">{host.status.notice}</p>
    {/if}
  </div>
  </div>
</aside>

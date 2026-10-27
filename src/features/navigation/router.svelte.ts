// The app's pages, as the links below build them. Paths are pages the host
// also serves (share previews, host/src/share.rs); hashes stay in the app.
//   #/                                 home (composer, timeline)
//   #/notifications                    replies to, mentions of and quotes of the connected wallet's posts
//   #/following                        the authors this browser follows
//   #/list[/bots|/blocked]             the host’s curated, bot and blocked accounts, and list management
//   /u/<chainId>/<address>/keyring[/holders]  public key balances and holders
//   #/settings/<chainId>               chain and theme choices
//   #/keys/<chainId>                   activating the connected wallet's account keys
//   /keys/<chainId>/about              account-key explanation and fees
//   /about[?section=<name>]            what this is, in plain words
//   /p/<chainId>/<id>[?reply|?replies][&commit=<hash>]  a thread; commit pins the post
//     ?reply opens the reply box; ?replies reveals the reply list
//   /u/<chainId>/<address>[/replies|/keys]      a profile: an author's posts and replies, or their keys
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { parsePostReference } from '../../lib/reference-syntax'
import { leavePage } from './page-position'
import { Visits } from './visits'

const toTop = () => window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
/** Where the browser is, spelt as the router compares it. */
const here = () => `${location.pathname ?? '/'}${location.search ?? ''}${location.hash}`

/** Modified link clicks keep the browser's new-tab/window behavior. */
export const plainClick = (event: MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/** The account-list page's tabs, one per host list. */
export type HostListTab = 'curated' | 'bots' | 'blocked' | 'takedowns'
export type Route =
  | { kind: 'home' }
  | { kind: 'notifications' }
  | { kind: 'following' }
  | { kind: 'list'; tab: HostListTab }
  | { kind: 'about'; section?: string }
  | { kind: 'settings'; chainId: number }
  | { kind: 'keyring'; chainId: number; address: Address; holders?: boolean }
  | { kind: 'keys'; chainId: number; about?: boolean }
  | { kind: 'thread'; chainId: number; id: bigint; commit?: Hex; reply: boolean; replies?: boolean }
  | { kind: 'user'; chainId: number; address: Address; keys?: boolean; replies?: boolean }
  | { kind: 'unknown'; hash: string }

/** A chain id in a path: a positive decimal integer with no leading zero, small enough to be exact. */
const isChainId = (part: string) => /^[1-9][0-9]*$/.test(part) && Number.isSafeInteger(Number(part))

export function parse(hash: string): Route {
  const [path, rawQuery = '', extra] = hash.replace(/^#\/?/, '').split('?')
  if (extra !== undefined) return { kind: 'unknown', hash }
  // Public share URLs may acquire tracking parameters outside the app.
  // Preserve strict parsing of the parameters that carry post semantics.
  const query = hash.startsWith('/')
    ? [...new URLSearchParams(rawQuery)].filter(([key]) => hash.startsWith('/p/') && (key === 'commit' || key === 'reply' || key === 'replies'))
      .map(([key, value]) => (key === 'reply' || key === 'replies') && !value ? key : `${key}=${encodeURIComponent(value)}`).join('&')
    : rawQuery
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return { kind: 'home' }
  if (parts[0] === 'notifications' && parts.length === 1) return { kind: 'notifications' }
  if (parts[0] === 'following' && parts.length === 1) return { kind: 'following' }
  if (parts[0] === 'list' && (parts.length === 1 || (parts.length === 2 && (parts[1] === 'bots' || parts[1] === 'blocked' || parts[1] === 'takedowns'))) && !query) return { kind: 'list', tab: (parts[1] ?? 'curated') as HostListTab }
  if (parts[0] === 'settings' && parts.length === 2 && !query && isChainId(parts[1])) return { kind: 'settings', chainId: Number(parts[1]) }
  if (parts[0] === 'keys' && (parts.length === 2 || (hash.startsWith('/keys/') && parts.length === 3 && parts[2] === 'about')) && !query && isChainId(parts[1])) return { kind: 'keys', chainId: Number(parts[1]), ...(parts[2] === 'about' ? { about: true } : {}) }
  if (hash.split('?')[0] === '/about') {
    // A link may name the section to open at (an id from the page, never markup).
    const section = new URLSearchParams(rawQuery).get('section')
    return section && /^[a-z-]{1,40}$/.test(section) ? { kind: 'about', section } : { kind: 'about' }
  }
  if (hash.startsWith('/p/') && parts.length === 3) {
    const fields = query ? query.split('&') : []
    const reply = fields.includes('reply')
    const replies = fields.includes('replies')
    const pins = fields.filter((f) => f.startsWith('commit='))
    if (pins.length > 1 || (reply && replies) || fields.length !== pins.length + Number(reply) + Number(replies)) return { kind: 'unknown', hash }
    const ref = parsePostReference(`post://${parts[1]}/${parts[2]}${pins.length ? `?${pins[0]}` : ''}`)
    return ref ? { kind: 'thread', ...ref, reply, ...(replies ? { replies: true } : {}) } : { kind: 'unknown', hash }
  }
  if (hash.startsWith('/u/') && parts[3] === 'keyring' && (parts.length === 4 || (parts.length === 5 && parts[4] === 'holders'))
    && !query && isChainId(parts[1]) && isAddress(parts[2], { strict: false })) {
    return { kind: 'keyring', chainId: Number(parts[1]), address: getAddress(parts[2]), ...(parts[4] === 'holders' ? { holders: true } : {}) }
  }
  // Addresses are accepted in any casing; a hand-typed or lowercased link should still work.
  if (hash.startsWith('/u/') && (parts.length === 3 || (parts.length === 4 && ['keys', 'replies'].includes(parts[3]))) && !query && isChainId(parts[1]) && isAddress(parts[2], { strict: false })) {
    return { kind: 'user', chainId: Number(parts[1]), address: getAddress(parts[2]), ...(parts[3] === 'keys' ? { keys: true } : parts[3] === 'replies' ? { replies: true } : {}) }
  }
  return { kind: 'unknown', hash }
}

const isSharePath = (path: string) => path.startsWith('/p/') || path.startsWith('/u/') || path === '/about' || /^\/keys\/[1-9][0-9]*\/about$/.test(path)

/** A hash navigates within the app; otherwise a share path selects its thread. */
export function parseLocation(pathname = '/', search = '', hash = ''): Route {
  return hash ? parse(hash) : isSharePath(pathname) ? parse(pathname + search) : parse('')
}
function currentRoute(): Route {
  return typeof location === 'undefined' ? parse('') : parseLocation(location.pathname, location.search, location.hash)
}

/** Tabs of one page: a profile's or keyring's own tabs, or the account lists. Switching them adds no Back step. */
function tabsOfOnePage(route: Route, next: Route): boolean {
  if (route.kind === 'list' && next.kind === 'list') return true
  if (route.kind === 'user' && next.kind === 'user') return route.chainId === next.chainId && route.address === next.address
  if (route.kind === 'keyring' && next.kind === 'keyring') return route.chainId === next.chainId && route.address === next.address
  return false
}

/** Opening a reply box, or another spelling of the same route, does not leave the page. */
function pageOf(route: Route): string {
  switch (route.kind) {
    case 'thread': return `thread/${route.chainId}/${route.id}/${route.commit ?? ''}`
    case 'keys': return `keys/${route.chainId}${route.about ? "/about" : ""}`
    case 'keyring': return `keyring/${route.chainId}/${route.address}${route.holders ? '/holders' : ''}`
    case 'settings': return `settings/${route.chainId}`
    case 'list': return route.tab === 'curated' ? 'list' : `list/${route.tab}`
    case 'user': return `user/${route.chainId}/${route.address}${route.keys ? "/keys" : route.replies ? "/replies" : ""}`
    case 'unknown': return route.hash
    default: return route.kind
  }
}

/**
 * Inside the discussion widget's frame the app is elsewhere, so links are
 * absolute app URLs: copied, middle-clicked or opened through the frame's
 * default target, they land in the app. Post links retain their shareable paths.
 */
const at = (path: string) => (router.embed ? new URL(path.startsWith('#') ? '/' + path : path, location.origin).toString() : path)

export const href = {
  home: () => at('#/'),
  notifications: () => at('#/notifications'),
  following: () => at('#/following'),
  list: (tab: HostListTab = 'curated') => at(tab === 'curated' ? '#/list' : `#/list/${tab}`),
  about: (section?: string) => at(`/about${section ? `?section=${section}` : ''}`),
  keyring: (chainId: number, address: Address) => at(`/u/${chainId}/${address}/keyring`),
  keyHolders: (chainId: number, address: Address) => at(`/u/${chainId}/${address}/keyring/holders`),
  settings: (chainId: number) => at(`#/settings/${chainId}`),
  keysAbout: (chainId: number) => at(`/keys/${chainId}/about`),
  keys: (chainId: number) => at(`#/keys/${chainId}`),
  thread: (chainId: number, id: bigint, commit?: Hex) => at(`/p/${chainId}/${id}${commit ? `?commit=${commit}` : ''}`),
  reply: (chainId: number, id: bigint, commit?: Hex) => at(`/p/${chainId}/${id}?reply${commit ? `&commit=${commit}` : ''}`),
  replies: (chainId: number, id: bigint, commit?: Hex) => at(`/p/${chainId}/${id}?replies${commit ? `&commit=${commit}` : ''}`),
  userReplies: (chainId: number, address: Address) => at(`/u/${chainId}/${address}/replies`),
  userKeys: (chainId: number, address: Address) => at(`/u/${chainId}/${address}/keys`),
  user: (chainId: number, address: Address) => at(`/u/${chainId}/${address}`),
}

/** Scroll and reply reset are consumed independently, once per Home press. */
export type HomeRequest = { shown: boolean; folded: boolean }

class Router {
  private visits = new Visits(100, pageOf(currentRoute()), typeof location === 'undefined' ? '/' : here())
  visit = $state.raw(this.visits.current)
  route = $state<Route>(currentRoute())
  /** A Home press scrolls and resets reply choices without refreshing its feed. */
  homeTop = $state.raw<HomeRequest | null>(null)
  private pendingHome = false
  /** Pages left, Back and Forward included: an action waiting on a page is void once this moves. */
  leaves = 0
  private pendingResume = false
  /** A navigation click, until the route change it causes: a hash change arrives after the click. */
  private pendingTop = false
  /** The page the route names, spelt one way: what a reply box or a stream position is kept for. */
  get page(): string {
    return pageOf(this.route)
  }
  /** Inside the discussion widget's frame (embed.ts): navigation opens the full app in a new tab instead. */
  embed = false
  constructor() {
    if (typeof window === 'undefined') return
    // The browser tries to restore before asynchronously loaded rows exist.
    // Each view restores its own bookmark as its content arrives.
    history.scrollRestoration = 'manual'
    history.replaceState({ ...history.state, blohard: this.visits.entry }, '')
    let previous = here()
    const update = (event: Event) => {
      if (previous === here()) return
      previous = here()
      const next = currentRoute()
      const samePage = pageOf(next) === pageOf(this.route)
      if (!samePage) {
        this.leaves++
        leavePage()
        if (!(event instanceof CustomEvent && event.detail?.keepScroll)) toTop()
      } else if (this.pendingTop) toTop()
      this.visit = this.visits.move(history.state?.blohard, samePage, pageOf(next), this.pendingResume, here())
      history.replaceState({ ...history.state, blohard: this.visits.entry }, '')
      this.homeTop = this.pendingHome && next.kind === 'home' ? { shown: false, folded: false } : null
      this.pendingHome = false
      this.pendingResume = false
      this.pendingTop = false
      this.route = next
    }
    window.addEventListener('hashchange', update)
    window.addEventListener('popstate', update)
    window.addEventListener('blohard:navigate', update)
    window.addEventListener('click', (event) => {
      if (!plainClick(event) || event.defaultPrevented || !(event.target instanceof Element)) return
      const link = event.target.closest('a')
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return
      const raw = link.getAttribute('href')
      // Hash tabs, such as the account lists, replace the URL as path tabs do.
      if (raw?.startsWith('#/') && (isSharePath(location.pathname) || link.hasAttribute('data-page-tab'))) {
        event.preventDefault()
        this.go(raw, link.hasAttribute('data-page-tab'))
        return
      }
      const url = new URL(link.href)
      if (url.origin !== location.origin || !isSharePath(url.pathname) || url.hash) return
      if (!['thread', 'user', 'about', 'keys', 'keyring'].includes(parseLocation(url.pathname, url.search).kind)) return
      event.preventDefault()
      this.go(url.pathname + url.search, link.hasAttribute('data-page-tab'))
    })
  }

  go(target: string, replaceTab = false) {
    if (this.embed) {
      // Row clicks arrive here; links carry absolute URLs already.
      window.open(new URL(target, location.origin).toString(), '_blank', 'noopener')
      return
    }
    const next = replaceTab ? parse(target) : null
    const sameTabs = next !== null && tabsOfOnePage(this.route, next)
    if (isSharePath(target.split('?')[0]) || (target.startsWith('#/') && isSharePath(location.pathname ?? '/'))) {
      const url = target.startsWith('#') ? '/' + target : target
      if (`${location.pathname}${location.search}${location.hash}` === url) return
      // Tab links replace the URL, preserving this visit and its previous page.
      if (sameTabs) history.replaceState(history.state, '', url)
      else history.pushState(null, '', url)
      // Keyring tabs change the list at the current viewport, without a scroll action.
      window.dispatchEvent(new CustomEvent('blohard:navigate', { detail: { keepScroll: sameTabs && next?.kind === 'keyring' } }))
    } else if (sameTabs) {
      if (location.hash === target) return
      history.replaceState(history.state, '', target)
      window.dispatchEvent(new CustomEvent('blohard:navigate', { detail: { keepScroll: false } }))
    } else location.hash = target
  }

  /** Sidebar links resume retained content at the top; Back/Forward keep their bookmarks. */
  nav(target: string) {
    const before = here()
    this.pendingTop = true
    this.pendingResume = true
    this.go(target)
    if (here() !== before) return
    this.pendingTop = false
    this.pendingResume = false
    toTop()
  }

  home() {
    if (this.route.kind === 'home') {
      this.homeTop = { shown: false, folded: false }
      toTop()
    } else {
      this.pendingHome = true
      this.nav(href.home())
    }
  }

  /** The page arrow restores the previous page as a new, independently restorable browser entry. */
  back() {
    const target = this.visits.returnEntry()
    if (target) {
      history.pushState({ blohard: target.entry }, '', target.url)
      window.dispatchEvent(new Event('blohard:navigate'))
    } else {
      this.go(href.home())
    }
  }
}

export const router = new Router()

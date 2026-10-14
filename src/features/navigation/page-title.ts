// The browser tab's title for an app page. The host's share pages use the same
// forms (host/src/share.rs), so a page reached inside the app reads like its link.
import type { Address } from 'viem'
import type { Route } from './router.svelte'

/** `heading` is the page's column heading; `name` is an address's display name. */
export function tabTitle(route: Route, heading: string, name: (address: Address) => string): string {
  switch (route.kind) {
    case 'home': return 'blohard'
    case 'about': return 'about blohard'
    case 'thread': return `post #${route.id} · blohard`
    case 'keyring': return `${name(route.address)} ${route.holders ? 'key holders' : 'keyring'} · blohard`
    case 'user': return route.keys ? `${name(route.address)} account keys · blohard` : route.replies ? `${name(route.address)} replies · blohard` : `${name(route.address)} · blohard`
    default: return `${heading} · blohard`
  }
}

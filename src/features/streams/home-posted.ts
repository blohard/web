import { host } from '../../lib/host.svelte'
import type { ChainInfo } from '../../lib/types'
import { href, router } from '../navigation/router.svelte'
import type { HomeFilter } from './feed-policy'

/** Reveal a Home submission: curated cannot display a nonmember's top-level post. */
export function homePosted(
  chain: ChainInfo, filter: HomeFilter, id: bigint,
  current: () => boolean, reload: () => void,
): void {
  if (!current()) return
  if (filter.kind === 'timeline' && filter.curatedOnly && chain.curated && filter.viewer && !host.curated(filter.viewer)) {
    router.go(href.thread(chain.id, id))
    return
  }
  reload()
}

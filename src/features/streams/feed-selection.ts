// Pure grouping of eligible feed records and their loaded context.
import { oldestFirst } from '../../lib/board'
import { sameAddress } from '../../lib/format'
import type { Posted } from '../../lib/types'
import { withInlined, type Groups } from './conversation'
import { groupsSelectedOnly, type Filter } from './feed-policy'

/** Context may connect a group, but never becomes an eligible preview. */
export function selectConversations(filter: Filter, records: {
  top: Posted[]; inlined: Posted[]; replies: Posted[]; context: Posted[]
  parents: Map<bigint, Posted>; eligibleIds: ReadonlySet<bigint>; ended: ReadonlySet<bigint>
}) {
  const { context, parents, eligibleIds, ended } = records
  const groupingIds = new Set(eligibleIds)
  // Home streams group only selected records. prepareRow adds their
  // immediate parent context without bridging to a distant selected ancestor.
  if (!groupsSelectedOnly(filter)) for (const id of [...groupingIds]) {
    let parent = parents.get(id)?.parentId
    while (parent !== undefined && parents.has(parent) && !groupingIds.has(parent)) {
      groupingIds.add(parent)
      parent = parents.get(parent)?.parentId
    }
  }
  const top = records.top.filter((p) => groupingIds.has(p.id))
  const inlined = [...records.inlined, ...context].filter((p) => groupingIds.has(p.id))
  const replies = records.replies.filter((p) => groupingIds.has(p.id))
  let posts: Posted[]
  let chains = new Map<bigint, Posted[]>()
  let groups: Groups = new Map()
  let activity = new Map<bigint, Posted>()
  switch (filter.kind) {
    case 'timeline':
    case 'following':
    case 'author': {
      // Muting and deletion were applied above; a muted or deleted post left
      // in `top` is the context above a shown reply, and the pair shows it.
      const merged = withInlined(top, inlined)
      posts = merged.posts
      chains = merged.chains
      groups = merged.groups
      activity = merged.activity
      break
    }
    case 'author-replies': {
      // The author's replies as listed; the reader's answers hang beneath the reply they answer.
      posts = replies.filter((r) => sameAddress(r.author, filter.address))
      for (const r of replies) {
        if (sameAddress(r.author, filter.address)) continue
        chains.set(r.parentId, [...(chains.get(r.parentId) ?? []), r].sort(oldestFirst))
      }
      break
    }
  }
  const homeStream = filter.kind === 'timeline' || filter.kind === 'following'
  const selected = homeStream
    ? new Set([...records.top, ...records.inlined].filter(p => eligibleIds.has(p.id)).map(p => p.id))
    : undefined
  return { posts, activity, source: { chains, groups, parents, ended, selected } }
}

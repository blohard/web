// Stream selection. These rules make no reads and own no state.
// The host applies the query's list predicates; the reader applies current
// mutes and endings before handing selected records to conversation.ts.
import type { Address } from 'viem'
import { readerBlocklist } from '../account/blocking'
import type { FeedFilter } from '../../lib/api'
import { hasAddress, sameAddress } from '../../lib/format'
import type { ChainInfo, Posted } from '../../lib/types'

/** Viewer identity is separate from author selection and the replies-to-viewer option. */
export type Filter = { viewer?: Address } & (
  | { kind: 'timeline'; curatedOnly?: boolean }
  | { kind: 'following'; authors: Address[]; includeRepliesToViewer: boolean }
  | { kind: 'author'; address: Address }
  | { kind: 'author-replies'; address: Address }
)

/** Home's Following includes replies to the viewer; Keyring selects only its authors. */
export type HomeFilter = Extract<Filter, { kind: 'timeline' | 'following' }>
type PostSelection = 'selected' | 'excluded' | 'waiting-for-parent'

/** Muted authors are left out of streams, not of a profile deliberately opened. */
export const appliesMutes = (filter: Filter): boolean => filter.kind !== 'author' && filter.kind !== 'author-replies'

/** Filtered home streams connect replies only through other selected records. */
export const groupsSelectedOnly = (filter: Filter): boolean =>
  filter.kind === 'following' || (filter.kind === 'timeline' && filter.curatedOnly === true)

const viewerWrote = (filter: Filter, post: Posted): boolean =>
  filter.viewer !== undefined && sameAddress(filter.viewer, post.author)

/**
 * Classify a host candidate. A profile's own-answer rule needs a selected
 * parent, supplied by the reader; missing parents wait for a later page.
 * Other streams can decide from the record alone. Curated membership is
 * supplied by the host query, or checked separately for quiet/local records.
 */
export function selectPost(filter: Filter, post: Posted, parent?: Posted): PostSelection {
  if (post.parentId === 0n) {
    switch (filter.kind) {
      case 'timeline': return 'selected'
      case 'following': return hasAddress(filter.authors, post.author) ? 'selected' : 'excluded'
      case 'author': return sameAddress(filter.address, post.author) ? 'selected' : 'excluded'
      case 'author-replies': return 'excluded'
    }
  }
  const answersViewer = filter.viewer !== undefined && sameAddress(filter.viewer, post.parentAuthor)
  switch (filter.kind) {
    case 'timeline':
      return filter.curatedOnly || viewerWrote(filter, post) || answersViewer ? 'selected' : 'excluded'
    case 'following':
      return hasAddress(filter.authors, post.author) || (filter.includeRepliesToViewer && answersViewer) ? 'selected' : 'excluded'
    case 'author':
    case 'author-replies':
      if (filter.kind === 'author-replies' && sameAddress(filter.address, post.author)) return 'selected'
      if (!viewerWrote(filter, post) || !sameAddress(filter.address, post.parentAuthor)) return 'excluded'
      if (!parent) return 'waiting-for-parent'
      return filter.kind === 'author-replies' || parent.parentId === 0n ? 'selected' : 'excluded'
  }
}

/** A listed author qualifies; replies by or to the viewer can also qualify through their parent. */
export function curatedSubjects(filter: Filter, post: Posted): Address[] {
  const involvesViewer = viewerWrote(filter, post) || (filter.viewer !== undefined && sameAddress(filter.viewer, post.parentAuthor))
  return post.parentId !== 0n && involvesViewer ? [post.author, post.parentAuthor] : [post.author]
}

/**
 * Candidates for one host cursor. Profiles ask for the viewer's answers too;
 * selectPost waits for their parents to distinguish the posts and replies tabs.
 * The caller supplies selected authors; Home adds the viewer for Following.
 */
export function feedQuery(filter: Filter, chain: Pick<ChainInfo, 'curated' | 'blocklist'>): FeedFilter {
  const viewer = filter.viewer
  const list = viewer && appliesMutes(filter) ? readerBlocklist(chain, viewer) : undefined
  const excluded = list ? { exclude_list: list } : {}
  switch (filter.kind) {
    case 'timeline': {
      // Curated has no own-post exception. The host alone filters membership
      // on normal reads, so a stale client list cannot hide a newly listed author.
      if (filter.curatedOnly && chain.curated) return { ...excluded, any: [{ curated: true },
        ...(viewer ? [{ authors: [viewer], kind: 'replies' as const, parent_curated: true },
          { parent_authors: [viewer], parent_curated: true }] : [])] }
      return { ...excluded, any: [{ kind: 'posts' },
        ...(viewer ? [{ authors: [viewer], kind: 'replies' as const }, { parent_authors: [viewer] }] : [])] }
    }
    case 'following': return { ...excluded, any: [...(filter.authors.length ? [{ authors: filter.authors }] : []),
      ...(viewer && filter.includeRepliesToViewer ? [{ parent_authors: [viewer] }] : [])] }
    case 'author': return { any: [{ authors: [filter.address], kind: 'posts' },
      ...(viewer ? [{ authors: [viewer], parent_authors: [filter.address] }] : [])] }
    case 'author-replies': return { any: [{ authors: [filter.address], kind: 'replies' },
      ...(viewer ? [{ authors: [viewer], parent_authors: [filter.address] }] : [])] }
  }
}

// Display rules over already-loaded cards and the reader's current choices.
// Conversation grouping lives in conversation.ts; RowExpansion owns the choices.
import type { Posted } from '../../lib/types'
import { conversationCards, type ConversationRowData } from './conversation'

export type PreviewState = {
  totalReplies: number | null
  open: boolean
  hidden: boolean
  ended: boolean
  editorOpen: boolean
}

/** Only a visible preview starting directly beneath the post supplies a drawn count. */
export function replyControls(total: number | null, drawn: number, expanded: boolean, hidden: boolean) {
  const preview = !expanded && !hidden
  return {
    replyCount: total === null ? null : preview ? Math.max(0, total - drawn) : total,
    moreReplies: preview && drawn > 0,
  }
}

/**
 * visiblePosts is the subset left by RowExpansion.preview. The caller supplies
 * current display state for every card in items.
 */
export function layoutPreview(
  items: ConversationRowData['cards'],
  visiblePosts: Posted[],
  states: ReadonlyMap<bigint, PreviewState>,
  parent: { id: bigint; separator: boolean; loading: boolean; missing: boolean },
) {
  const ended = new Set(items.filter(card => states.get(card.post.id)!.ended).map(card => card.post.id))
  // Keep the prepared counts and joins until filtering changes the preview.
  const visible = visiblePosts.length === items.length ? items : conversationCards(parent.id, visiblePosts, ended)
  const cards = visible.map((card, i) => {
    const state = states.get(card.post.id)!
    const expanded = !state.ended && state.open
    const labelled = card.gap || (parent.missing && i === 0)
    const loadingParent = parent.loading && i === 0
    const previous = visible[i - 1]
    // An opened list or an editor interrupts the join to the preceding card.
    const separated = i === 0 ? parent.separator
      : !previous.joins || states.get(previous.post.id)!.open || states.get(previous.post.id)!.editorOpen
    return {
      post: card.post,
      ...replyControls(state.totalReplies, card.joins ? card.drawn : 0, expanded, state.hidden),
      expanded,
      context: labelled ? { id: card.post.parentId, separator: !loadingParent } : null,
      separator: !labelled && !loadingParent && separated,
      connector: expanded || (!state.hidden && card.joins),
      branchSeparator: state.editorOpen,
    }
  })
  return { cards, posts: visible.map(card => card.post) }
}

export type PreviewLayout = ReturnType<typeof layoutPreview>

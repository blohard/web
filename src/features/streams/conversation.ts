// The shape of a conversation in a stream, from indexed records: which
// inlined replies fold into one chain, how several replies to one post form a
// group led by the newest, which few cards a pair draws for it, which of them
// are labelled with what they answer, and the row a post stands in. Pure functions over `Posted`
// records; features/streams/feed.ts fetches their host pages.
import { newestFirst, oldestFirst } from '../../lib/board'
import type { Filter } from './feed-policy'
import type { Posted } from '../../lib/types'

/** Other streams limit previews; Curated shows every selected, loaded reply. */
const REPLY_PREVIEW = 3
/** Bound both context retrieval and the ancestor chain a profile reply shows. */
export const CONTEXT_DEPTH = 5

/**
 * Inlined replies that answer other inlined replies (you replying to your own
 * reply) fold into one chain under the first of them, so the middle reply is
 * shown once, not as the reply of one pair and the parent of the next.
 */
function chainsOf(replies: Posted[]): { roots: Posted[]; chains: Map<bigint, Posted[]> } {
  const ids = new Set(replies.map((r) => r.id))
  const children = new Map<bigint, Posted[]>()
  for (const r of replies) {
    if (ids.has(r.parentId)) {
      const siblings = children.get(r.parentId) ?? []
      siblings.push(r)
      children.set(r.parentId, siblings)
    }
  }
  const roots = replies.filter((r) => !ids.has(r.parentId))
  const chains = new Map<bigint, Posted[]>()
  for (const siblings of children.values()) siblings.sort(oldestFirst)
  for (const r of roots) {
    const rest: Posted[] = []
    const pending = [...(children.get(r.id) ?? [])].reverse()
    while (pending.length) {
      const next = pending.pop()!
      rest.push(next)
      const siblings = children.get(next.id) ?? []
      for (let i = siblings.length - 1; i >= 0; i--) pending.push(siblings[i])
    }
    if (rest.length) chains.set(r.id, rest)
  }
  return { roots, chains }
}

/** Loaded branches in depth-first order. Missing parents group their visible children without being fetched. */
export function branchOrder(posts: Posted[]): Posted[] {
  const { roots, chains } = chainsOf(posts)
  const groups = new Map<bigint, Posted[]>()
  for (const root of roots.sort(oldestFirst)) {
    const siblings = groups.get(root.parentId) ?? []
    siblings.push(root)
    groups.set(root.parentId, siblings)
  }
  return [...groups.values()].flatMap(siblings => siblings.flatMap(root => [root, ...(chains.get(root.id) ?? [])]))
}

/**
 * Merge top-level posts with replies to inline. A post that appears as the
 * parent of an inlined reply is not repeated on its own: the pair shows it.
 * Several inlined replies to the same post form one group, represented in the
 * result by the newest of them. A conversation sits where its newest member
 * falls, on whichever branch; its preview draws that member too (prepareRow).
 * Exported for the client tests; the page builder is the only other caller.
 */
export function withInlined(
  top: Posted[],
  replies: Posted[],
): { posts: Posted[]; chains: Map<bigint, Posted[]>; groups: Groups; activity: Map<bigint, Posted> } {
  const { roots, chains } = chainsOf(replies)
  const byParent = new Map<bigint, Posted[]>()
  for (const r of roots) byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r])
  const groups: Groups = new Map()
  const leads: Posted[] = []
  for (const siblings of byParent.values()) {
    siblings.sort(newestFirst)
    const lead = siblings[0]
    leads.push(lead)
    if (siblings.length > 1) groups.set(lead.id, [...siblings].reverse()) // oldest first, as a thread reads
  }
  const parents = new Set(leads.map((r) => r.parentId))
  const seen = new Set<bigint>()
  const merged: Posted[] = []
  for (const p of [...top, ...leads]) {
    const k = p.id
    if (seen.has(k)) continue
    seen.add(k)
    if (p.parentId === 0n && parents.has(k)) continue
    merged.push(p)
  }
  const newest = (p: Posted): Posted => {
    const members = [p, ...(groups.get(p.id) ?? [])]
    for (const m of [...members]) members.push(...(chains.get(m.id) ?? []))
    return members.reduce((a, b) => (newestFirst(a, b) <= 0 ? a : b))
  }
  const ranked = merged.map((post) => ({ post, newest: newest(post) }))
  ranked.sort((a, b) => newestFirst(a.newest, b.newest))
  return { posts: ranked.map((r) => r.post), chains, groups, activity: new Map(ranked.map(r => [r.post.id, r.newest])) }
}

/**
 * How many of `cards` answer each card, by the answered card's id. A pair
 * draws a reply's chain flattened, and a chain can hold siblings, so the
 * order drawn says nothing about who answers whom; counts and thread lines
 * follow this map instead.
 */
export function drawnReplies(cards: Posted[]): Map<bigint, number> {
  const drawn = new Map<bigint, number>()
  for (const c of cards) drawn.set(c.parentId, (drawn.get(c.parentId) ?? 0) + 1)
  return drawn
}

/** All loaded replies in a conversation, oldest first; prepareRow owns preview selection. */
function conversationReplies(page: { groups: Groups; chains: Map<bigint, Posted[]> }, lead: Posted): Posted[] {
  const roots = lead.parentId === 0n ? [] : page.groups.get(lead.id) ?? [lead]
  return roots.flatMap(r => [r, ...(page.chains.get(r.id) ?? [])]).sort(oldestFirst)
}

/** A new branch names its parent; consecutive siblings share that label. */
export function gapsIn(parentId: bigint, cards: Posted[]): Set<bigint> {
  return new Set(cards.filter((c, i) => i === 0
    ? c.parentId !== parentId
    : c.parentId !== cards[i - 1].id && c.parentId !== cards[i - 1].parentId).map(c => c.id))
}

/** Initial row identity. Profile replies are prepared individually, then overlapping context is grouped. */
export function rowKey(f: Filter, m: Posted): bigint {
  return f.kind === 'author-replies' ? m.id : m.parentId || m.id
}

/** Every inlined reply to one post, oldest first, by the newest of them: the grouping algorithm's intermediate shape, before a row is prepared. */
export type Groups = Map<bigint, Posted[]>
type RowSource = { chains: Map<bigint, Posted[]>; groups: Groups; parents: Map<bigint, Posted>; ended: ReadonlySet<bigint>; selected?: ReadonlySet<bigint> }

/** Prepared card structure; indexed counts and missing context are supplied separately. */
export type ConversationRowData = {
  kind: 'pair'
  /** Curated keeps loaded branches together, including retained previews after expansion. */
  depthFirst: boolean
  key: bigint
  lead: Posted
  /** Chain position that ranks this conversation, including selected replies. */
  activity?: Posted
  /** Automatic-preview cutoff, retained during paging and Back. */
  previewAfter?: Posted
  /** Retained previews exclude cards added only as their parent context. */
  previewIds?: ReadonlySet<bigint>
  root: { id: bigint; post: Posted | undefined; drawn: number; joins: boolean; omitted: boolean }
  cards: { post: Posted; drawn: number; joins: boolean; gap: boolean }[]
}

/** Prepare once for both rendering and count selection. No reads or mutable state. */
export function prepareRow(filter: Filter, lead: Posted, source: RowSource, {
  previewAfter, newSince, keep, isOpen = () => false,
}: { previewAfter?: Posted; newSince?: bigint; keep?: ReadonlySet<bigint>; isOpen?: (id: bigint) => boolean } = {}): ConversationRowData {
  const key = rowKey(filter, lead)
  const curated = filter.kind === 'timeline' && !!filter.curatedOnly
  // A profile's replies tab lists each reply as its subject, with the
  // reader's answers already ordered oldest first beneath it.
  const loaded = filter.kind === 'author-replies'
    ? [lead, ...(source.chains.get(lead.id) ?? []).slice(-(REPLY_PREVIEW - 1))]
    : conversationReplies(source, lead)
  const candidates = loaded.filter(p => !source.selected || source.selected.has(p.id))
  const automatic = candidates.filter(p => !previewAfter || isOpen(lead.parentId || lead.id) || newestFirst(p, previewAfter) < 0)
    .slice(curated ? 0 : -REPLY_PREVIEW)
  // Existing previews during local updates, newly arrived replies and explicitly
  // opened cards bypass both limits.
  // Open branches remain owned by RowExpansion, not by this presentation filter.
  const preserved = candidates.filter(p => keep?.has(p.id) || (newSince !== undefined && p.blockNumber > newSince))
  // A context card can own an open list even after its selected child folds.
  const opened = loaded.filter(p => isOpen(p.id) && !source.ended.has(p.id))
  const preview = [...new Map([...automatic, ...preserved, ...opened].map(p => [p.id, p])).values()].sort(oldestFirst)
  const ancestors: Posted[] = []
  if (filter.kind === 'author-replies') {
    let child = lead
    for (let i = 0; child.parentId !== 0n && i < CONTEXT_DEPTH; i++) {
      const parent = source.parents.get(child.parentId)
      if (!parent) break
      ancestors.push(parent)
      child = parent
    }
  }
  const id = ancestors.at(-1)?.id ?? (lead.parentId || lead.id)
  const root = ancestors.at(-1) ?? (lead.parentId === 0n ? lead : source.parents.get(id))
  const omitted = source.selected !== undefined && !source.selected.has(id)
    && !preview.some(r => r.parentId === id) && !isOpen(id)
  // Ancestors give the profile reply its context and do not compete for the
  // preview slots reserved for that reply and the reader's answers.
  const cardsById = new Map([...ancestors.slice(0, -1), ...preview].map(r => [r.id, r]))
  if (filter.kind === 'following' || filter.kind === 'timeline') for (const reply of preview) {
    const parent = source.parents.get(reply.parentId)
    if (parent && parent.id !== id) cardsById.set(parent.id, parent)
  }
  // Order the preview and its context together for display.
  const displayed = [...cardsById.values()]
  const cards = curated ? branchOrder(displayed) : displayed.sort(oldestFirst)
  return {
    kind: 'pair', depthFirst: curated, key, lead, previewAfter,
    previewIds: new Set(preview.map(p => p.id)),
    root: { id, post: root, omitted, drawn: cards.filter(p => p.parentId === id && !source.ended.has(p.id)).length, joins: !omitted && cards[0]?.parentId === id },
    cards: conversationCards(id, cards, source.ended),
  }
}

/** Layout follows the cards actually shown, including any gaps in their context. */
export function conversationCards(parent: bigint, posts: Posted[], ended: ReadonlySet<bigint> = new Set()): ConversationRowData['cards'] {
  // Ended context does not subtract from a live reply count.
  const drawn = drawnReplies(posts.filter(p => !ended.has(p.id)))
  const gaps = gapsIn(parent, posts)
  return posts.map((post, i) => ({
    post, drawn: drawn.get(post.id) ?? 0,
    joins: posts[i + 1]?.parentId === post.id, gap: gaps.has(post.id),
  }))
}


/** Combine overlapping profile context using only the cards already selected for display. */
export function groupProfileReplies(rows: ConversationRowData[], ended: ReadonlySet<bigint>): ConversationRowData[] {
  const subjects = new Set(rows.map(row => row.lead.id))
  const missingRoots = new Set(rows.filter(row => !row.root.post).map(row => row.root.id))
  const records = new Map<bigint, Posted>()
  for (const row of rows) {
    if (row.root.post) records.set(row.root.id, row.root.post)
    for (const card of row.cards) records.set(card.post.id, card.post)
  }
  const posts = [...records.values()]
  const grouped = withInlined(posts.filter(p => p.parentId === 0n), posts.filter(p => p.parentId !== 0n))
  return grouped.posts.map(post => {
    let id = post.parentId || post.id
    const cards = branchOrder(conversationReplies(grouped, post))
    // A bounded context path may stop before the actual root. Keep its first
    // loaded card as the root instead of requesting an extra ancestor.
    const root = records.get(id) ?? (missingRoots.has(id) ? undefined : cards.shift())
    if (root) id = root.id
    // Context cannot rank a conversation or become its subject. Use the newest
    // profile reply, even when an answer from the reader is newer still.
    const lead = [root, ...cards].filter((p): p is Posted => !!p && subjects.has(p.id)).sort(newestFirst)[0]!
    return {
      kind: 'pair' as const, depthFirst: true, key: lead.id, lead,
      root: { id, post: root, omitted: false, drawn: cards.filter(p => p.parentId === id && !ended.has(p.id)).length, joins: cards[0]?.parentId === id },
      cards: conversationCards(id, cards, ended),
    }
  }).sort((a, b) => newestFirst(a.lead, b.lead))
}

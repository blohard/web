// Which conversations a stream's reader opened in place, and the paging and
// nesting choices made inside them. Kept per stream for the life of this tab,
// like stream positions, so returning to a stream restores what was open.
// Explicit Refresh or Home resets these choices; polling and local changes keep them.
//
// Every card can open its own direct replies. A preview and its later copy in
// a loaded list share the same choice, without opening intervening branches.
import { SvelteMap } from 'svelte/reactivity'
import type { Posted } from '../../lib/types'
import type { ConversationRowData } from './conversation'
import { oldestFirst } from '../../lib/board'

/** Paging choices survive navigation; a returning stream reuses its reply session. */
export type ReplyViews = Map<bigint, {
  limit: number
  open: Record<string, boolean>
}>

/** A parent's retained replies and whether they still stand outside its list. */
type Preview = { posts: readonly Posted[]; separate: boolean }

export type Expansion = {
  /** Explicit choices override the default preview. Branches under stream cards, keyed by row and post: the same post standing in two rows opens in each on its own. */
  modes: SvelteMap<string, 'open' | 'hidden'>
  /** Paging and nested choices inside the branches, per row, so two rows showing one post keep their own. */
  views: Map<bigint, ReplyViews>
  /** One saved placement per parent, within each row. Empty, non-separate entries remember dismissal. */
  previews: Map<bigint, SvelteMap<bigint, Preview>>
  /** Parents whose reply lists are on screen right now, kept by the lists themselves; the refresh cue counts only those. */
  shown: Set<bigint>
  /** A handoff may briefly mount two copies of a list. */
  mounts: Map<bigint, number>
}

const expansions = new Map<string, Expansion>()

/** One branch's place in a stream: the row it stands in and the post whose replies open. */
const branchKey = (row: bigint, id: bigint): string => `${row}/${id}`

/** The expansion record of a stream, created empty on first use. */
export function expansionOf(key: string): Expansion {
  let e = expansions.get(key)
  if (!e) {
    e = { modes: new SvelteMap(), views: new Map(), previews: new Map(), shown: new Set(), mounts: new Map() }
    expansions.set(key, e)
  }
  return e
}

/** Reset saved choices only when present. Unchanged rows keep their mounted cards. */
export function resetExpansion(key: string): boolean {
  const e = expansions.get(key)
  if (!e || (!e.modes.size && !e.views.size && ![...e.previews.values()].some(previews => previews.size))) return false
  // Mounted lists finish against their old record.
  return expansions.delete(key)
}

/** The posts whose branches a stream has open, whichever rows they stand in; empty without creating a record. */
export function openRoots(key: string): ReadonlySet<bigint> {
  const e = expansions.get(key)
  return new Set([...(e?.modes ?? [])].filter(([, mode]) => mode === 'open').map(([k]) => BigInt(k.slice(k.indexOf('/') + 1))))
}

/** Read an existing row choice without creating an expansion record. */
export const branchOpen = (key: string, row: bigint, id: bigint): boolean =>
  expansions.get(key)?.modes.get(branchKey(row, id)) === 'open'

/** The parents whose reply lists a stream has on screen. */
export const shownParents = (key: string): ReadonlySet<bigint> => expansions.get(key)?.shown ?? new Set()

/**
 * Parents whose new replies would stay hidden by an explicit collapse. Use
 * only the prepared cards, in parent-before-child order, just like preview().
 * A parent visible in another row still qualifies; unknown context is not
 * fetched or assumed hidden.
 */
export function collapsedParents(key: string, rows: readonly ConversationRowData[]): ReadonlySet<bigint> {
  const expansion = expansions.get(key)
  const hidden = new Set<bigint>(), visible = new Set<bigint>()
  if (!expansion) return hidden
  for (const row of rows) {
    const collapsed = (id: bigint) => expansion.modes.get(branchKey(row.key, id)) === 'hidden'
    const rootHidden = collapsed(row.root.id)
    const concealed = new Set<bigint>()
    if (rootHidden) hidden.add(row.root.id)
    else visible.add(row.root.id)
    for (const { post } of row.cards) {
      const absent = rootHidden || collapsed(post.parentId) || concealed.has(post.parentId)
      if (absent) concealed.add(post.id)
      if (absent || collapsed(post.id)) hidden.add(post.id)
      else visible.add(post.id)
    }
  }
  for (const id of visible) hidden.delete(id)
  return hidden
}

/**
 * A row's handle on its stream's expansion record, driven by the card's count
 * and the control at the foot of an open list alike. A reply posted under an
 * open card is remembered here, per mounted row: folding forgets it, and a
 * fresh mount, Back included, never replays a reveal.
 */
export class RowExpansion {
  private readonly arrived = new SvelteMap<bigint, bigint>()
  private readonly previews: SvelteMap<bigint, Preview>
  constructor(private readonly expansion: Expansion, readonly row: bigint) {
    this.previews = expansion.previews.get(row) ?? new SvelteMap()
    expansion.previews.set(row, this.previews)
  }

  /** Keep visible cards without fetching ancestors or opening any branches. */
  retain(posts: readonly Posted[]): void {
    for (const post of posts) {
      const kept = this.previews.get(post.parentId) ?? { posts: [], separate: true }
      if (!kept.posts.some(r => r.id === post.id)) {
        this.previews.set(post.parentId, { ...kept, posts: [...kept.posts, post] })
      }
    }
  }

  /** The parent's list keeps these cards even when they fall past its first page. */
  retained(parent: bigint): readonly Posted[] {
    return this.previews.get(parent)?.posts ?? []
  }

  /** Cards whose own parent's list has not taken them over. */
  remaining(): Posted[] {
    return [...this.previews.values()].flatMap(v => v.separate ? v.posts : []).sort(oldestFirst)
  }

  /** Hide a preview copy only after its parent's loaded list is showing it. */
  listShown(parent: bigint): void {
    const kept = this.previews.get(parent)
    if (kept?.separate === false) return
    this.previews.set(parent, { posts: kept?.posts ?? [], separate: false })
  }

  /** Only relationships already in the preview matter; never read ancestors. */
  preview(posts: readonly Posted[]): Posted[] {
    const hidden = new Set<bigint>()
    return posts.filter(post => {
      if (this.isHidden(post.parentId) || hidden.has(post.parentId)) {
        hidden.add(post.id)
        return false
      }
      return this.previews.get(post.parentId)?.separate !== false
    })
  }

  isMounted(parent: bigint): boolean {
    return this.expansion.mounts.has(parent)
  }

  /** Keep the refresh cue registered while a preview list moves into a parent list. */
  watch(parent: bigint): () => void {
    const { mounts, shown } = this.expansion
    mounts.set(parent, (mounts.get(parent) ?? 0) + 1)
    shown.add(parent)
    return () => {
      const left = mounts.get(parent)! - 1
      if (left) mounts.set(parent, left)
      else { mounts.delete(parent); shown.delete(parent) }
    }
  }

  isOpen(id: bigint): boolean {
    return this.expansion.modes.get(branchKey(this.row, id)) === 'open'
  }

  isHidden(id: bigint): boolean {
    return this.expansion.modes.get(branchKey(this.row, id)) === 'hidden'
  }

  /** Hide both the automatic preview and any opened list. */
  hide(id: bigint, wholeRow = false): void {
    this.expansion.modes.set(branchKey(this.row, id), 'hidden')
    this.arrived.delete(id)
    // Dismiss the known preview beneath this card; no missing ancestors are read.
    const dismissed = new Set([id])
    const posts = [...this.previews.values()].flatMap(v => v.posts).sort(oldestFirst)
    for (const post of posts) if (dismissed.has(post.parentId)) dismissed.add(post.id)
    for (const parent of this.previews.keys()) {
      if (wholeRow || dismissed.has(parent)) this.previews.set(parent, { posts: [], separate: false })
    }
    this.previews.set(id, { posts: [], separate: false })
  }

  /** Open a card's branch, or fold it and forget any reply revealed there. */
  press(id: bigint, wholeRow = false): void {
    const key = branchKey(this.row, id)
    if (this.isOpen(id)) this.hide(id, wholeRow)
    else this.expansion.modes.set(key, 'open')
  }

  /**
   * A reply just posted under a card: its branch opens, if folded, and reveals
   * it. The feed itself may never list the reply: a keyring view lists only
   * the accounts it was given.
   */
  landed(id: bigint, replyId: bigint): void {
    this.expansion.modes.set(branchKey(this.row, id), 'open')
    this.arrived.set(id, replyId)
  }

  reveal(id: bigint): bigint | undefined {
    return this.arrived.get(id)
  }

  /** Paging and nested choices of this row's branches, apart from other rows showing the same post; the same row finds them again. */
  views(): ReplyViews {
    let v = this.expansion.views.get(this.row)
    if (!v) {
      v = new Map()
      this.expansion.views.set(this.row, v)
    }
    return v
  }

  /** Where the lists register themselves while on screen, for the stream's refresh cue. */
  get shown(): Set<bigint> {
    return this.expansion.shown
  }
}

// Which conversations a stream's reader opened in place, and the paging and
// nesting choices made inside them. Kept per stream for the life of this tab,
// like stream positions, so returning to a stream restores what was open.
// Explicit Refresh or Home resets these choices; polling and local changes keep them.
//
// Every card can open its own direct replies. A preview and its later copy in
// a loaded list share the same choice, without opening intervening branches.
import { SvelteMap } from 'svelte/reactivity'
import { acceptReply, completeBranches, type ReplySessions } from './replies'
import type * as api from '../../lib/api'
import type { ChainInfo, Posted } from '../../lib/types'
import type { ConversationRowData } from './conversation'
import { oldestFirst } from '../../lib/board'

/** Paging choices survive navigation; a returning stream reuses its reply session. */
export type ReplyViews = Map<bigint, {
  limit: number
  open: Record<string, boolean>
  /** Replies already visible beyond a paging gap when this view was inherited. */
  retained: bigint[]
}>

/** Copy paging choices without sharing their mutable arrays or open flags. */
export function copyReplyViews(views: ReplyViews): ReplyViews {
  return new Map([...views].map(([id, view]) => [id, {
    limit: view.limit, open: { ...view.open }, retained: [...view.retained],
  }]))
}

type RowState = {
  modes: SvelteMap<bigint, 'open' | 'hidden'>
  previews: SvelteMap<bigint, Preview>
  views: ReplyViews
  sessions: ReplySessions
  shown: Set<bigint>
  mounts: Map<bigint, number>
}

/** A parent's retained replies and whether they still stand outside its list. */
type Preview = { posts: readonly Posted[]; separate: boolean }

/** Every row owns its branch choices, preview placement and loaded sessions. */
export type Expansion = { rows: Map<bigint, RowState> }

const expansions = new Map<string, Expansion>()

/** The expansion record of a stream, created empty on first use. */
export function expansionOf(key: string): Expansion {
  let e = expansions.get(key)
  if (!e) {
    e = { rows: new Map() }
    expansions.set(key, e)
  }
  return e
}

/** Reset saved choices only when present. Unchanged rows keep their mounted cards. */
export function resetExpansion(key: string): boolean {
  const e = expansions.get(key)
  if (!e || ![...e.rows.values()].some(row => row.modes.size || row.views.size || row.previews.size)) return false
  // Mounted lists finish against their old record.
  return expansions.delete(key)
}

/** The posts whose branches a stream has open, whichever rows they stand in; empty without creating a record. */
export function openRoots(key: string): ReadonlySet<bigint> {
  const roots = new Set<bigint>()
  for (const row of expansions.get(key)?.rows.values() ?? []) {
    for (const [id, mode] of row.modes) if (mode === 'open') roots.add(id)
  }
  return roots
}

/** Read an existing row choice without creating an expansion record. */
export const branchOpen = (key: string, row: bigint, id: bigint): boolean =>
  expansions.get(key)?.rows.get(row)?.modes.get(id) === 'open'

/** Each open row keeps its own session, even when another row shows the same post. */
function openRows(key: string) {
  return [...(expansions.get(key)?.rows.values() ?? [])].flatMap(state => {
    const roots = new Set([...state.modes].filter(([, mode]) => mode === 'open').map(([id]) => id))
    return roots.size ? [{ ...state, roots }] : []
  })
}

/** Merge the refresh cue's known replies without sharing the rows' mutable sessions. */
export function completeStreamBranches(chain: ChainInfo, key: string): Map<bigint, ReadonlySet<bigint>> {
  const result = new Map<bigint, Set<bigint>>()
  for (const { sessions, roots, shown } of openRows(key)) {
    for (const [parent, ids] of completeBranches(sessions, chain, roots, shown)) {
      const known = result.get(parent) ?? new Set<bigint>()
      for (const id of ids) known.add(id)
      result.set(parent, known)
    }
  }
  return result
}

/** Own publications update only the named retained stream. */
export async function acceptStreamReply(chain: ChainInfo, key: string, at: api.At, record: api.RecordImage, parent?: api.RecordImage): Promise<void> {
  await Promise.all(openRows(key).map(({ sessions, roots }) => acceptReply(sessions, chain, roots, at, record, parent)))
}

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
    const modes = expansion.rows.get(row.key)?.modes
    const collapsed = (id: bigint) => modes?.get(id) === 'hidden'
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
  private readonly state: RowState
  constructor(expansion: Expansion, readonly row: bigint) {
    this.state = expansion.rows.get(row) ?? {
      modes: new SvelteMap(), previews: new SvelteMap(), views: new Map(),
      sessions: new Map(), shown: new Set(), mounts: new Map(),
    }
    expansion.rows.set(row, this.state)
  }

  /** Keep visible cards without fetching ancestors or opening any branches. */
  retain(posts: readonly Posted[]): void {
    for (const post of posts) {
      const kept = this.state.previews.get(post.parentId) ?? { posts: [], separate: true }
      if (!kept.posts.some(r => r.id === post.id)) {
        this.state.previews.set(post.parentId, { ...kept, posts: [...kept.posts, post] })
      }
    }
  }

  /** The parent's list keeps these cards even when they fall past its first page. */
  retained(parent: bigint): readonly Posted[] {
    return this.state.previews.get(parent)?.posts ?? []
  }

  /** Cards whose own parent's list has not taken them over. */
  remaining(): Posted[] {
    return [...this.state.previews.values()].flatMap(v => v.separate ? v.posts : []).sort(oldestFirst)
  }

  /** Hide a preview copy only after its parent's loaded list is showing it. */
  listShown(parent: bigint): void {
    const kept = this.state.previews.get(parent)
    if (kept?.separate === false) return
    this.state.previews.set(parent, { posts: kept?.posts ?? [], separate: false })
  }

  /** Only relationships already in the preview matter; never read ancestors. */
  preview(posts: readonly Posted[]): Posted[] {
    const hidden = new Set<bigint>()
    return posts.filter(post => {
      if (this.isHidden(post.parentId) || hidden.has(post.parentId)) {
        hidden.add(post.id)
        return false
      }
      return this.state.previews.get(post.parentId)?.separate !== false
    })
  }

  isMounted(parent: bigint): boolean {
    return this.state.mounts.has(parent)
  }

  /** Keep the refresh cue registered while a preview list moves into a parent list. */
  watch(parent: bigint): () => void {
    const { mounts, shown } = this.state
    mounts.set(parent, (mounts.get(parent) ?? 0) + 1)
    shown.add(parent)
    return () => {
      const left = mounts.get(parent)! - 1
      if (left) mounts.set(parent, left)
      else { mounts.delete(parent); shown.delete(parent) }
    }
  }

  isOpen(id: bigint): boolean {
    return this.state.modes.get(id) === 'open'
  }

  isHidden(id: bigint): boolean {
    return this.state.modes.get(id) === 'hidden'
  }

  /** Hide both the automatic preview and any opened list. */
  hide(id: bigint, wholeRow = false): void {
    this.state.modes.set(id, 'hidden')
    this.arrived.delete(id)
    // Dismiss the known preview beneath this card; no missing ancestors are read.
    const dismissed = new Set([id])
    const posts = [...this.state.previews.values()].flatMap(v => v.posts).sort(oldestFirst)
    for (const post of posts) if (dismissed.has(post.parentId)) dismissed.add(post.id)
    for (const parent of this.state.previews.keys()) {
      if (wholeRow || dismissed.has(parent)) this.state.previews.set(parent, { posts: [], separate: false })
    }
    this.state.previews.set(id, { posts: [], separate: false })
  }

  /** Open a card's branch, or fold it and forget any reply revealed there. */
  press(id: bigint, wholeRow = false): void {
    if (this.isOpen(id)) this.hide(id, wholeRow)
    else this.state.modes.set(id, 'open')
  }

  /**
   * A reply just posted under a card: its branch opens, if folded, and reveals
   * it. The feed itself may never list the reply: a keyring view lists only
   * the accounts it was given.
   */
  landed(id: bigint, replyId: bigint): void {
    this.state.modes.set(id, 'open')
    this.arrived.set(id, replyId)
  }

  reveal(id: bigint): bigint | undefined {
    return this.arrived.get(id)
  }

  /** Paging and nested choices of this row's branches, apart from other rows showing the same post; the same row finds them again. */
  views(): ReplyViews {
    return this.state.views
  }

  /** The same retained row owns all its opened branch reads. */
  get sessions(): ReplySessions { return this.state.sessions }

  /** Copy just the clicked conversation into a thread; neither view owns the other's choices. */
  inherit(root: bigint, preview: readonly Posted[]): ReplyViews {
    const choices = copyReplyViews(this.views())
    const viewFor = (id: bigint) => {
      let view = choices.get(id)
      if (!view) { view = { limit: 20, open: {}, retained: [] }; choices.set(id, view) }
      return view
    }
    for (const post of preview) {
      if (post.parentId === 0n) continue
      const view = viewFor(post.parentId)
      if (!view.retained.includes(post.id)) view.retained.push(post.id)
      view.open[post.id.toString()] = this.isOpen(post.id)
    }
    // A visible preview beneath a card becomes that card's opened branch.
    // Explicit collapses still win, including over saved choices from an older mount.
    const parents = new Set(preview.map(post => post.parentId))
    for (const view of choices.values()) for (const id of Object.keys(view.open)) {
      const post = BigInt(id)
      view.open[id] = !this.isHidden(post) && (this.isOpen(post) || parents.has(post))
    }
    const inherited: ReplyViews = new Map()
    const pending = [root]
    while (pending.length) {
      const id = pending.pop()!
      if (inherited.has(id)) continue
      const view = viewFor(id)
      inherited.set(id, view)
      for (const [child, open] of Object.entries(view.open)) if (open) pending.push(BigInt(child))
    }
    return inherited
  }

  /** Where the lists register themselves while on screen, for the stream's refresh cue. */
  get shown(): Set<bigint> {
    return this.state.shown
  }
}

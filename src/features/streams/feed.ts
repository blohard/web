// Feed retrieval owns pagination, retained snapshots and recovery. Selection
// rules live in feed-policy.ts; feed-selection.ts groups eligible records and
// context, and conversation.ts prepares their cards.
import { selectConversations } from './feed-selection'
import { listening, QuietChanges, type Listener } from './quiet-changes'
import { SerialQueue } from '../../shared/serial-queue'
import { SvelteMap } from 'svelte/reactivity'
import * as api from '../../lib/api'
import { endingOf, newestFirst, oldestFirst } from '../../lib/board'
import { ancestorsOf, readMessage, rememberMessages } from '../../lib/messages'
import { CONTEXT_DEPTH, groupProfileReplies, prepareRow, rowKey, type ConversationRowData } from './conversation'
import { gates as ledger } from '../../lib/gates.svelte'
import { sameAddress } from '../../lib/format'
import { appliesMutes, groupsSelectedOnly, curatedSubjects, feedQuery, selectPost, type Filter } from './feed-policy'
import { host } from '../../lib/host.svelte'
import { readHostPolicy } from '../../lib/host-policy'
import { muted } from '../../lib/muted.svelte'
import { wallet } from '../../lib/wallet.svelte'
import { completeBranches, acceptReply } from './replies'
import { branchOpen, collapsedParents, openRoots, shownParents } from './stream-expansion'
import type { ChainInfo, Posted } from '../../lib/types'

export type Page = {
  /** All selected groups in the fetched pages; only the first `limit` are displayed. */
  rows: ConversationRowData[]
  limit: number
  /**
   * Direct counts from indexed records. Missing context counts fill this
   * reactive map after rows arrive; a failed count stays missing, not zero.
   */
  counts: Map<bigint, number>
  /** Settles once the counts are in, or have failed; never rejects. */
  countsReady: Promise<void>
  /** True once the host cursor is exhausted. */
  complete: boolean
  /** Time of the oldest fetched post, for the control line; null before any post is fetched. */
  reach: Date | null
  /** Oldest position scanned; rows below this may still be missing. */
  scannedThrough?: { block: bigint; log: number } | null
}

export const FEED_PAGE_SIZE = 20
const ROUNDS = 8

type View = {
  chain: ChainInfo; filter: Filter; policyRevision: string | undefined
  top: Posted[]; inlined: Posted[]; replies: Posted[]
  held: Map<bigint, Posted>; seen: Set<bigint>; waiting: Map<bigint, Posted[]>
  counts: Map<bigint, number>
  at: api.At | null; cursor: api.Cursor | null; complete: boolean
  reach: Date | null; scannedThrough: { block: bigint; log: number } | null; unfinished: boolean
  selection: Selection | null; limit: number; asked: number
  loading: Promise<Page> | null; queue: SerialQueue; quiet: QuietChanges
}
const views = new Map<string, View>()
let mounted: { key: string; cue: (count: number) => void } | null = null

/** Register the visible stream; only a resumed snapshot keeps its old cue. */
export function mountFeed(chain: ChainInfo, filter: Filter, cue: (count: number) => void, { resume = false }: { resume?: boolean } = {}): () => void {
  const view = { key: feedKey(chain, filter), cue }
  mounted = view
  cue(resume ? feedCue(chain, filter) : 0)
  return () => { if (mounted === view) mounted = null }
}
/** A view as a first visit finds it. */
function blank(chain: ChainInfo, filter: Filter): View {
  return { chain, filter, policyRevision: host.status?.host_policy?.revision, top: [], inlined: [], replies: [], held: new Map(), seen: new Set(), waiting: new Map(), counts: new Map(),
    at: null, cursor: null, complete: false, reach: null, scannedThrough: null, unfinished: false,
    selection: null, limit: FEED_PAGE_SIZE, asked: FEED_PAGE_SIZE, loading: null, queue: new SerialQueue(), quiet: new QuietChanges() }
}

function takeRecords(v: View, chain: ChainInfo, at: api.At, records: api.WireRecord[]): api.RecordImage[] {
  const rows = rememberMessages(chain, at, records.map(api.record))
  for (const row of rows) v.counts.set(row.id, row.replies)
  return rows
}

/** Each completed page advances its cursor, even if personal filters hide every row. */
async function older(f: Filter, v: View, chain: ChainInfo, limit: number, preservePreviews = false): Promise<Selection> {
  v.unfinished = true
  let selected = await select(f, v, chain, preservePreviews)
  for (let round = 0; round < ROUNDS && !v.complete && selected.rows.length < limit; round++) {
    const page = await api.feed(chain, feedQuery(f, chain), v.cursor, Math.min(50, Math.max(20, limit - selected.rows.length)))
    if (page.items.length > 50 || (v.at && page.at.generation !== v.at.generation)) throw new api.ApiError(409, 'reset_required')
    if (page.next && v.cursor && api.integer(page.next.before) >= api.integer(v.cursor.before)) throw new Error('host feed cursor made no progress')
    const rows = takeRecords(v, chain, page.at, page.items)
    merge(f, v, rows)
    v.at ??= page.at
    v.cursor = page.next
    v.complete = page.next === null
    const oldest = rows.at(-1)
    if (oldest) {
      v.reach = new Date(oldest.timestamp * 1000)
      v.scannedThrough = { block: oldest.blockNumber, log: oldest.logIndex }
    }
    selected = await select(f, v, chain, preservePreviews)
  }
  v.unfinished = false
  return selected
}

/**
 * Read a view as a first visit would. It replaces the view only once loaded,
 * so a failure leaves the page shown for the next refresh to retry.
 */
async function afresh(f: Filter, view: View, chain: ChainInfo, shown: number, preservePreviews = false): Promise<Selection> {
  const next = blank(chain, f)
  // Retrying a retired cursor must keep the last completed load as the
  // new-reply baseline. A different index generation is checked in select().
  next.selection = view.selection
  next.limit = view.limit
  await ledger.advanceToHead(chain)
  const selected = await older(f, next, chain, preservePreviews ? Math.max(shown, view.limit) : shown, preservePreviews)
  Object.assign(view, { ...next, loading: view.loading, queue: view.queue, quiet: view.quiet })
  return selected
}

/** Changes include current records and direct counts. No read per retained row. */
async function refresh(f: Filter, v: View, chain: ChainInfo): Promise<void> {
  if (!v.at) return
  const scope: api.ChangeScope = { feed: feedQuery(f, chain), ids: [...v.counts.keys()].filter((id) => !v.held.has(id)).map(String) }
  for await (const { from, answer, next } of api.changePages(chain, v.at, scope)) {
    if (!ledger.follow(chain, from, answer)) await ledger.advanceToHead(chain)
    const records = takeRecords(v, chain, answer.at, answer.records)
    const byId = new Map(records.map((r) => [r.id, r]))
    const posted: Posted[] = []
    for (const message of api.postedIn(answer)) {
      const id = api.integer(message.id)
      const row = byId.get(id)
      if (!row) throw new Error('host change omitted its message')
      posted.push(row)
    }
    merge(f, v, posted.sort(oldestFirst))
    v.at = next
  }
}

/**
 * Place the events the view has not seen. On the
 * two author views, a reply by the reader to the author whose parent the view
 * does not hold yet waits, and is placed when a later look loads the parent,
 * so the order events arrive in does not decide what is shown. No other view
 * asks about the parent, so nothing else waits.
 */
function merge(f: Filter, v: View, events: Posted[]): void {
  let placed = false
  const place = (ev: Posted) => {
    const decision = selectPost(f, ev, v.held.get(ev.parentId))
    if (decision === 'selected') {
      const target = ev.parentId === 0n ? v.top : f.kind === 'author-replies' ? v.replies : v.inlined
      target.push(ev)
      v.held.set(ev.id, ev)
      placed = true
    }
    return decision
  }
  for (const ev of events) {
    const k = ev.id
    if (v.seen.has(k)) continue
    v.seen.add(k)
    if (place(ev) === 'waiting-for-parent') v.waiting.set(ev.parentId, [...(v.waiting.get(ev.parentId) ?? []), ev])
  }
  for (const [parent, list] of [...v.waiting]) {
    if (!v.held.has(parent)) continue
    v.waiting.delete(parent)
    for (const ev of list) place(ev)
  }
  if (placed) for (const arr of [v.top, v.inlined, v.replies]) arr.sort(newestFirst)
}

async function threadContext(
  chain: ChainInfo,
  held: Map<bigint, Posted>,
  replies: Posted[],
  retainPath = false,
): Promise<Posted[]> {
  const added = new Map<bigint, Posted>()
  const stop = (id: bigint) => id === 0n || held.has(id) || added.has(id)
  await Promise.all(replies.map(async (r) => {
    if (!retainPath && stop(r.parentId)) return
    try {
      for await (const record of ancestorsOf(chain, r, CONTEXT_DEPTH)) {
        if (!retainPath && (stop(record.id) || record.parentId === 0n)) break
        const ctx: Posted = record
        added.set(ctx.id, ctx)
        if (ctx.parentId === 0n || (!retainPath && stop(ctx.parentId))) break
      }
    } catch {
      // Keep the context already found; the next look retries the missing ancestors.
    }
  }))
  return [...added.values()]
}

/** The same prepared rows are counted during paging and passed to rendering. */
type Selection = Pick<Page, 'rows'> & {
  /** Completed load's checkpoint; background polls never advance it. */
  at: api.At | null
  /** Replies after this block bypass automatic limits until the next refresh. */
  newSince?: bigint
}

/**
 * Select what the view shows: filter by mutes and current gates before
 * grouping, even without new events, then keep ancestors as context,
 * including deleted or muted ones, only where a visible descendant needs
 * them, then group for display. Page records and context
 * reads already populated the shared gate ledger, including local receipt
 * overlays. Selection needs no further gate reads.
 */
async function select(f: Filter, v: View, chain: ChainInfo, preservePreviews = false): Promise<Selection> {
  const byId = new Map(v.held)
  const profileReplies = f.kind === 'author-replies'
  const context = await threadContext(chain, byId, profileReplies ? v.replies : v.inlined, profileReplies)
  for (const c of context) byId.set(c.id, c)
  const all = [...byId.values()]
  const selectedOnly = groupsSelectedOnly(f)
  const ended = new Set(all.filter(p => endingOf(ledger.message(chain, p.id))).map(p => p.id))
  const eligibleIds = new Set(all.filter(p => (!appliesMutes(f) || !muted.has(p.author))
    && (!selectedOnly || v.held.has(p.id)) && !ended.has(p.id)).map(p => p.id))
  const { posts, activity, source } = selectConversations(f, {
    top: v.top, inlined: v.inlined, replies: v.replies, context, parents: byId, eligibleIds, ended,
  })
  const homeStream = f.kind === 'timeline' || f.kind === 'following'
  // The curated tab's membership is the host's: its pages and changes carry
  // only listed authors' posts and replies, the reader's replies to listed
  // authors, and direct replies to the reader when they are listed.
  // A list change makes the view read afresh (feedQuery). A
  // cached membership check here could only disagree with it, never correct it.
  const key = feedKey(chain, f)
  const prior = v.selection?.at?.generation === v.at?.generation ? v.selection : null
  const checkpoint = prior?.at?.checkpoint
  const newSince = (preservePreviews ? prior?.newSince : undefined)
    ?? (checkpoint ? BigInt(checkpoint.block) : undefined)
  const previous = new Map(preservePreviews ? prior?.rows.slice(0, v.limit).map(row => [row.key, row]) : [])
  const rows = posts.map((p, i) => {
    const row = rowKey(f, p)
    const saved = previous.get(row)
    const after = homeStream ? saved ? saved.previewAfter : activity.get(posts[i + 1]?.id) : undefined
    return { ...prepareRow(f, p, source, {
      previewAfter: after,
      newSince: homeStream ? newSince : undefined,
      keep: homeStream ? saved?.previewIds : undefined,
      isOpen: id => homeStream && branchOpen(key, row, id),
    }), activity: activity.get(p.id) ?? p }
  })
  return { rows: profileReplies ? groupProfileReplies(rows, ended) : rows, at: v.at, newSince }
}

/** Keep every still-selected row previously displayed when new rows arrive above it. */
async function present(f: Filter, v: View, chain: ChainInfo, limit: number, preserveVisibleRows: boolean, selection?: Selection): Promise<Page> {
  const selected = selection ?? await select(f, v, chain)
  const before = new Set(preserveVisibleRows && v.selection ? v.selection.rows.slice(0, v.limit).map((r) => r.key) : [])
  limit = Math.max(limit, selected.rows.reduce((n, r, i) => before.has(r.key) ? i + 1 : n, 0))
  v.selection = selected; v.limit = limit
  const ids = [...new Set(selected.rows.slice(0, limit).flatMap((r) => [r.root.id, ...r.cards.map((c) => c.post.id)]))]
  const counts = new SvelteMap<bigint, number>()
  for (const id of ids) if (v.counts.has(id)) counts.set(id, v.counts.get(id)!)
  // A pair may name an older root outside the fetched pages. Only those
  // missing point reads follow the rows; all other counts came with records.
  const missing = ids.filter((id) => !counts.has(id))
  const countsReady = (async () => {
    for (let start = 0; start < missing.length; start += 50) {
      const answer = await api.snapshots(chain, missing.slice(start, start + 50))
      const rows = takeRecords(v, chain, answer.at, answer.items.filter((r): r is api.WireRecord => r !== null))
      for (const row of rows) counts.set(row.id, row.replies)
    }
  })().catch(() => {})
  return { rows: selected.rows, limit, counts, countsReady, complete: v.complete, reach: v.reach, scannedThrough: v.scannedThrough }
}

/**
 * Whether a new record counts toward the curated tab's refresh cue. The poll
 * is shared with the notification dot, so its answer also carries the reader's
 * mentions, from any author. The policy selects listed authors' posts and replies,
 * own replies to listed authors, and replies to the reader when listed. A change
 * to host policy cues a refresh, which reads the view afresh.
 */
function cuesCurated(f: Filter, chain: ChainInfo, r: Posted): boolean {
  if (f.kind !== 'timeline' || !f.curatedOnly || !chain.curated) return true
  return curatedSubjects(f, r).some(subject => host.curated(subject))
}

/** The quiet cue and local publications use the same stream eligibility. */
function eligible(f: Filter, v: View, chain: ChainInfo, r: api.RecordImage): boolean {
  if (host.blocked(r.author) || endingOf(r.gate) || selectPost(f, r, v.held.get(r.parentId)) !== 'selected' || (appliesMutes(f) && muted.has(r.author))) return false
  return cuesCurated(f, chain, r)
}

/**
 * A local publication updates off-screen snapshots only. One point read supplies
 * the post and, when needed, its parent's count; no feed/change cursor advances.
 * Failures leave normal refresh available and never affect the publication.
 */
export async function acceptPublication(chain: ChainInfo, id: bigint, parentId: bigint): Promise<void> {
  const matches = (v: View) => v.chain.id === chain.id && sameAddress(v.chain.contract, chain.contract)
  const visible = mounted ? views.get(mounted.key) : undefined
  // Check immediately after a local confirmation, without changing displayed records.
  const cue = visible && matches(visible) ? peekFeed(chain, visible.filter).then(() => {}, () => {}) : Promise.resolve()
  const targets = [...views].filter(([key, v]) => key !== mounted?.key && v.at && matches(v))
  if (!targets.length) return cue
  const parentNeeded = parentId !== 0n && targets.some(([key, v]) => v.counts.has(parentId) || openRoots(key).size > 0)
  let answer: Awaited<ReturnType<typeof readMessage>>
  try { answer = await readMessage(chain, id, parentNeeded ? 1 : 0) }
  catch { return }
  const { at, record, ancestors } = answer
  const parent = ancestors[0]
  await Promise.all([cue, ...targets.map(([key, v]) => v.queue.run(async () => {
    if (key === mounted?.key || v.at?.generation !== at.generation) return
    if (!v.seen.has(id) && eligible(v.filter, v, chain, record)) {
      merge(v.filter, v, [record])
      v.counts.set(id, record.replies)
      v.quiet.forget(id)
    }
    if (parent && v.counts.has(parent.id)) v.counts.set(parent.id, parent.replies)
    // Sessions may be shared with the stream currently on screen. Leave its
    // branches alone too; that stream's next explicit refresh will update them.
    const visibleRoots = mounted ? openRoots(mounted.key) : new Set<bigint>()
    await acceptReply(chain, [...openRoots(key)].filter(root => !visibleRoots.has(root)), at, record, parent)
  }))])
}

/** One identity for cached data, retained rendering and stream bookmarks. */
export const feedKey = (chain: ChainInfo, filter: Filter) => `${chain.id}/${chain.contract.toLowerCase()}/${JSON.stringify(filter)}`

/**
 * Inspect new events without mutating the page or the shared gate state. New
 * replies inside conversations the reader opened under the stream's cards count
 * too, when their branch is complete and a refresh would append them; a reply
 * that also qualifies for the stream counts once. One poll reads at most one
 * changes page, continuing from the previous quiet poll. Profiles also cue changes
 * to displayed reply counts, since other authors' replies are outside their filter.
 */
export async function peekFeed(chain: ChainInfo, filter: Filter, listener?: Listener): Promise<number | null> {
  const key = feedKey(chain, filter)
  const v = views.get(key)
  // Mounting starts the poll alongside the load or resume of its snapshot.
  if (v?.loading) await v.loading.catch(() => {})
  if (!v?.at || v.loading) return null
  const branches = completeBranches(chain, openRoots(key), shownParents(key))
  const profile = filter.kind === 'author' || filter.kind === 'author-replies'
  const displayed = new Set(profile ? v.selection?.rows.slice(0, v.limit)
    .flatMap(row => [row.root.id, ...row.cards.map(card => card.post.id)]) : [])
  const own: api.ChangeScope = { feed: feedQuery(filter, chain), gates: false }
  if (profile) own.ids = [...displayed].map(String)
  if (branches.size) own.parents = [...branches.keys()].map(String)
  const scope = listening(own, listener)
  const at = v.at, owner = mounted
  const count = await v.quiet.peek(chain, at, scope, r => {
    if (wallet.is(r.author) || host.blocked(r.author) || v.seen.has(r.id)) return false
    const branch = branches.get(r.parentId)
    // A reply already shown by an open branch is not new through the feed either.
    if (branch?.has(r.id)) return false
    if (branch && !endingOf(r.gate)) return true
    return eligible(filter, v, chain, r)
      && !collapsedParents(key, v.selection?.rows ?? []).has(r.parentId)
  }, listener?.heard, profile ? records => records.some(wire => {
    const row = api.record(wire)
    return displayed.has(row.id) && v.counts.has(row.id) && row.replies !== v.counts.get(row.id)
  }) : undefined)
  const pending = policyChanged(v) ? Infinity : count
  if (mounted === owner && owner?.key === key && v.at === at && !v.loading) owner.cue(pending)
  return pending
}

function policyChanged(view: View): boolean {
  return view.policyRevision !== host.status?.host_policy?.revision
}

type LoadOptions = {
  limit?: number
  /** Extend the limit to keep previously displayed rows when newer ones arrive. */
  preserveVisibleRows?: boolean
  /** Local updates keep previews; explicit Refresh and Home may fold them anew. */
  preservePreviews?: boolean
}

async function look(chain: ChainInfo, filter: Filter, want: 'newer' | 'older' | 'resume', { limit, preserveVisibleRows = true, preservePreviews = false }: LoadOptions): Promise<Page> {
  const key = feedKey(chain, filter)
  let v = views.get(key)
  if (!v) {
    v = blank(chain, filter)
    views.set(key, v)
  }
  const view = v
  const run = view.queue.run(async () => {
    const more = limit ?? Math.max(view.limit, Math.min(view.limit, view.selection?.rows.length ?? 0) + FEED_PAGE_SIZE)
    const shown = view.unfinished ? Math.max(more, view.asked) : more
    view.asked = shown
    let selected: Selection | undefined
    if (!view.at) {
      // A failed later page keeps the pages read so far for the next load to
      // resume after. A first read that met a rebuild the ledger had not
      // confirmed starts once more instead, from the host's head.
      try {
        await ledger.advanceToHead(chain)
        selected = await older(filter, view, chain, shown, preservePreviews)
      } catch (error) {
        if (!api.positionLost(error)) throw error
        selected = await afresh(filter, view, chain, shown, preservePreviews)
      }
    }
    else if (want === 'newer' && policyChanged(view)) selected = await afresh(filter, view, chain, shown, preservePreviews)
    else if (want === 'older') {
      try { selected = await older(filter, view, chain, shown, true) }
      catch (error) {
        // A policy edit invalidates cursors before this tab necessarily hears
        // about it. Learn the revision, but leave replacing rows to refresh.
        if (api.positionLost(error) && host.status?.host_policy) await readHostPolicy().catch(() => {})
        throw error
      }
    }
    else if (want === 'newer') {
      try {
        await refresh(filter, view, chain)
        if (view.unfinished) selected = await older(filter, view, chain, shown, preservePreviews)
      } catch (error) {
        // The host no longer serves this view's position: read it afresh.
        if (!api.positionLost(error)) throw error
        selected = await afresh(filter, view, chain, shown, preservePreviews)
      }
    }
    if (!selected) selected = await select(filter, view, chain, preservePreviews)
    const page = await present(filter, view, chain, shown, preserveVisibleRows, selected)
    if (key === mounted?.key) mounted.cue(feedCue(chain, filter))
    return page
  }, (page) => page.countsReady)
  view.loading = run
  void run.then(() => {}, () => {}).then(() => { if (view.loading === run) view.loading = null })
  return run
}

/** Read current posts; preserve the displayed range unless opening a new visit. */
export const loadFeed = (chain: ChainInfo, filter: Filter, { limit = FEED_PAGE_SIZE, preserveVisibleRows = true, preservePreviews = false }: LoadOptions = {}): Promise<Page> => look(chain, filter, 'newer', { limit, preserveVisibleRows, preservePreviews })
/** Rebuild the displayed rows from the retained view without advancing its change cursor. */
export const resumeFeed = (chain: ChainInfo, filter: Filter, limit = views.get(feedKey(chain, filter))?.limit ?? FEED_PAGE_SIZE, preservePreviews = true): Promise<Page> => look(chain, filter, 'resume', { limit, preserveVisibleRows: false, preservePreviews })

/** The quiet scan belongs to the displayed snapshot, so its cue survives leaving the page. */
export const feedCue = (chain: ChainInfo, filter: Filter): number => {
  const view = views.get(feedKey(chain, filter))
  return view?.at ? policyChanged(view) ? Infinity : view.quiet.pending(view.at) : 0
}

export const olderFeed = (chain: ChainInfo, filter: Filter, limit?: number): Promise<Page> => look(chain, filter, 'older', { limit })

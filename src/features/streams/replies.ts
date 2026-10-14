// Thread sessions retain fetched branches; the host owns direct counts and
// paging. Opening a branch reads that branch only. A refresh adds changes to
// it, so existing rows, expansion state and inline drafts need not remount.
import { listening, QuietChanges, type Listener } from './quiet-changes'
import type { Hex } from 'viem'
import * as api from '../../lib/api'
import { endingOf } from '../../lib/board'
import { gates } from '../../lib/gates.svelte'
import { wallet } from '../../lib/wallet.svelte'
import { SerialQueue } from '../../shared/serial-queue'
import { readMessage, rememberMessages, SnapshotBehind } from '../../lib/messages'
import type { ChainInfo } from '../../lib/types'

type Branch = {
  ids: Set<bigint>; started: boolean; next: api.ReplyCursor | null; ceiling: bigint
  /** Requested window, retained so a count update alone cannot fetch more replies. */
  shown: number; revealed: Set<bigint>; queue: SerialQueue
}
type Session = {
  at: api.At | null
  records: Map<bigint, { sequence: bigint; record: api.RecordImage }>
  branches: Map<bigint, Branch>
  refreshing: Promise<void> | null
  queue: SerialQueue
}
export type ReplyPage = {
  at: api.At
  counts: Map<bigint, number>
  session: Session
}
export type ReplySlice = { list: api.RecordImage[]; loaded: number; tailStart: bigint | null; children: ReplyPage; total: number; more: boolean }
const sessions = new Map<string, Session>()
const sessionKey = (chain: ChainInfo, root: bigint) => `${chain.id}/${chain.contract.toLowerCase()}/${root}`
const blankSession = (): Session => ({ at: null, records: new Map(), branches: new Map(), refreshing: null, queue: new SerialQueue() })
function sessionFor(chain: ChainInfo, root: bigint): Session {
  const key = sessionKey(chain, root)
  let s = sessions.get(key)
  if (!s) {
    s = blankSession()
    sessions.set(key, s)
  }
  return s
}
function learn(s: Session, chain: ChainInfo, at: api.At, rows: api.RecordImage[]) {
  if (s.at && s.at.generation !== at.generation) throw new api.ApiError(409, 'reset_required')
  rememberMessages(chain, at, rows)
  const sequence = api.integer(at.sequence)
  for (const record of rows) {
    if ((s.records.get(record.id)?.sequence ?? -1n) <= sequence) s.records.set(record.id, { sequence, record })
  }
  s.at ??= at
}
function pageOf(s: Session): ReplyPage {
  return {
    at: s.at!, session: s,
    counts: new Map([...s.records].map(([id, r]) => [id, r.record.replies])),
  }
}
/** The held replies among `ids`, oldest first, leaving out deleted and removed ones. */
function live(s: Session, ids: Iterable<bigint>): api.RecordImage[] {
  return [...ids].map((id) => s.records.get(id)!.record).filter((r) => !endingOf(r.gate))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
function listed(s: Session, branch: Branch): api.RecordImage[] {
  return live(s, [...branch.ids].filter((id) => branch.next === null || id <= branch.ceiling))
}
/** A branch read to its end with every reply it holds on screen: a refresh would only append to it. */
const complete = (s: Session, branch: Branch): boolean =>
  branch.started && branch.next === null && branch.shown >= listed(s, branch).length

function refresh(chain: ChainInfo, s: Session): Promise<void> {
  if (!s.at) return Promise.resolve()
  if (!s.refreshing) {
    s.refreshing = (async () => {
      const scope = { parents: [...s.branches.keys()].map(String), ids: [...s.records.keys()].filter((id) => !s.branches.has(s.records.get(id)!.record.parentId)).map(String) }
      for await (const { from, answer, next } of api.changePages(chain, s.at!, scope)) {
        if (!gates.follow(chain, from, answer)) await gates.advanceToHead(chain)
        const records = answer.records.map(api.record)
        // Keep only this thread's records and children of branches whose read
        // has begun. The chain's unrelated posts never enter this session.
        const relevant = records.filter((r) => s.records.has(r.id) || s.branches.has(r.parentId))
        learn(s, chain, answer.at, relevant)
        for (const event of api.postedIn(answer)) {
          const branch = s.branches.get(api.integer(event.parent))
          if (branch) {
            const id = api.integer(event.id)
            if (!s.records.has(id)) throw new Error('host change omitted its reply')
            branch.ids.add(id)
          }
        }
        s.at = next
      }
    })().finally(() => { s.refreshing = null })
  }
  return s.refreshing
}

/** Fresh facade, shared session: a new page cues components without replacing branch data. */
async function root(chain: ChainInfo, id: bigint, ancestors: number, pin?: Hex, resume = false) {
  const s = sessionFor(chain, id)
  return s.queue.run(async () => {
    try {
      if (s.at) {
        if (!resume) await refresh(chain, s)
        const known = reopen(chain, s, id, ancestors, pin)
        if (known) return known
        return await (ancestors === 0 && pin === undefined ? openBranch(chain, s, id) : open(chain, s, id, ancestors, pin))
      }
      // Only the requests overlap: the first read goes out with the ledger's
      // advance, and its answer is applied after the advance, in the order the
      // two ran in before. An answer never applied, because the advance failed
      // or recovery below reads afresh, is dropped.
      if (ancestors === 0 && pin === undefined) {
        const sent = api.replies(chain, id, null, PAGE)
        sent.catch(() => {})
        await gates.advanceToHead(chain)
        return await openBranch(chain, s, id, sent)
      }
      const sent = api.message(chain, id, ancestors, pin)
      sent.catch(() => {})
      await gates.advanceToHead(chain)
      return await open(chain, s, id, ancestors, pin, sent)
    } catch (error) {
      if (!api.positionLost(error)) throw error
      // The host no longer serves this thread's position, or a first read met
      // a rebuild the ledger had not confirmed: read it once more into a new
      // session, which takes over only once its first read succeeds, so a
      // failure leaves the page shown for the next open to retry.
      const next = blankSession()
      await gates.advanceToHead(chain)
      const opened = await (ancestors === 0 && pin === undefined ? openBranch(chain, next, id) : open(chain, next, id, ancestors, pin))
      sessions.set(sessionKey(chain, id), next)
      return opened
    }
  })
}
/**
 * After a refresh, the session's root and parent are as current as a read:
 * the refresh scope names both, and changes carry their updated records. Null
 * when the session lacks either or the pin differs; the caller then reads.
 */
function reopen(chain: ChainInfo, s: Session, id: bigint, ancestors: number, pin?: Hex) {
  const record = s.records.get(id)?.record
  if (!record || (pin !== undefined && record.commitment !== pin)) return null
  const parent = ancestors > 0 && record.parentId !== 0n ? s.records.get(record.parentId)?.record : null
  if (parent === undefined) return null
  const gate = gates.message(chain, id) ?? record.gate
  return { record, gate, replies: pageOf(s), parent }
}
/**
 * A branch opened in place, with no parent shown and no pin: its first page of
 * direct replies carries the root's current record from the same head, so one
 * read serves both and the list continues from that page. As for a point read,
 * an answer from before the gate baseline is asked for once more.
 */
async function openBranch(chain: ChainInfo, s: Session, id: bigint, sent?: ReturnType<typeof api.replies>) {
  const branch = branchOf(s, id)
  await branch.queue.run(async () => {
    for (let attempt = 0; !branch.started; attempt++) {
      try { await readPage(chain, s, branch, id, PAGE, attempt === 0 ? sent : undefined) }
      catch (error) { if (attempt > 0 || !(error instanceof SnapshotBehind)) throw error }
    }
  })
  const record = s.records.get(id)!.record
  const gate = gates.message(chain, id) ?? record.gate
  return { record, gate, replies: pageOf(s), parent: null }
}
async function open(chain: ChainInfo, s: Session, id: bigint, ancestors: number, pin?: Hex, sent?: ReturnType<typeof api.message>) {
  const answer = await readMessage(chain, id, ancestors, pin, sent)
  learn(s, chain, answer.at, [answer.record, ...answer.ancestors])
  const record = s.records.get(id)!.record
  const gate = gates.message(chain, id) ?? record.gate
  return { record, gate, replies: pageOf(s), parent: answer.ancestors[0] ?? null }
}
export const readRoot = (chain: ChainInfo, id: bigint, resume = false) => root(chain, id, 0, undefined, resume)
export const readThread = (chain: ChainInfo, id: bigint, pin?: Hex) => root(chain, id, 1, pin)

/** Earlier context joins this thread's session, so its counts survive Back and follow refreshes. */
export function readEarlier(chain: ChainInfo, page: ReplyPage, id: bigint, limit: number): Promise<api.RecordImage[]> {
  const s = page.session
  return s.queue.run(async () => {
    const answer = await readMessage(chain, id, limit - 1)
    const rows = [answer.record, ...answer.ancestors]
    learn(s, chain, answer.at, rows)
    for (const row of rows) page.counts.set(row.id, s.records.get(row.id)!.record.replies)
    return rows
  })
}

/** How many direct replies a first look reads, as the lists show (features/streams/Replies.svelte). */
const PAGE = 20

function branchOf(s: Session, parent: bigint): Branch {
  let b = s.branches.get(parent)
  if (!b) {
    b = { ids: new Set(), started: false, next: null, ceiling: 0n, shown: 0, revealed: new Set(), queue: new SerialQueue() }
    s.branches.set(parent, b)
  }
  return b
}

/** The branch's next page of direct replies, checked, then added to the session with its parent's record. */
async function readPage(chain: ChainInfo, s: Session, branch: Branch, parent: bigint, wanted: number, sent?: ReturnType<typeof api.replies>) {
  const answer = await (sent ?? api.replies(chain, parent, branch.next, Math.min(50, Math.max(20, wanted))))
  const parentRecord = api.record(answer.parent), rows = answer.items.map(api.record)
  if (parentRecord.id !== parent || rows.length > 50 || (s.at && answer.at.generation !== s.at.generation)) throw new Error('invalid host reply page')
  let previous = branch.next ? api.integer(branch.next.after) : 0n
  for (const row of rows) {
    if (row.parentId !== parent || row.id <= previous || (branch.next && row.id > api.integer(branch.next.ceiling))) throw new Error('host replies are out of order')
    previous = row.id
  }
  if (answer.next && (api.integer(answer.next.parent) !== parent || api.integer(answer.next.after) < previous
    || (branch.next && api.integer(answer.next.after) <= api.integer(branch.next.after)))) throw new Error('host reply cursor made no progress')
  learn(s, chain, answer.at, [parentRecord, ...rows])
  for (const row of rows) branch.ids.add(row.id)
  branch.started = true
  branch.ceiling = answer.next ? api.integer(answer.next.ceiling) : previous > branch.ceiling ? previous : branch.ceiling
  branch.next = answer.next
}

/**
 * Read only enough direct replies for this slice. Register the branch before
 * awaiting anything: changes arriving during its first request then add to it.
 * Every press has an eight-page budget. New posts and retained preview cards
 * use point reads beyond the loaded page, without walking the gap to reach them.
 */
export function replySlice(chain: ChainInfo, page: ReplyPage, parent: bigint, limit: number, reveal?: bigint, retain: readonly bigint[] = []): Promise<ReplySlice> {
  const s = page.session
  const branch = branchOf(s, parent)
  return branch.queue.run(async () => {
    // A branch added after a refresh captured its scope starts from a snapshot
    // after that refresh, so it cannot miss changes outside the captured scope.
    if (!branch.started && s.refreshing) await s.refreshing
    // A local count can include someone else's new reply. Only an explicit
    // larger window follows that gap; resuming keeps the loaded snapshot.
    const extended = limit > branch.shown
    limit = Math.max(limit, branch.shown)
    let refreshed = false
    for (let round = 0; round < 8; round++) {
      const list = listed(s, branch)
      if (branch.started && list.length >= limit) break
      if (branch.started && branch.next === null) {
        const total = s.records.get(parent)?.record.replies ?? 0
        if (extended && !refreshed && (list.length < total)) {
          refreshed = true
          await refresh(chain, s)
          continue
        }
        break
      }
      await readPage(chain, s, branch, parent, limit - list.length)
    }
    for (const kept of new Set(reveal === undefined ? retain : [...retain, reveal])) {
      if (!s.records.has(kept)) {
        const answer = await readMessage(chain, kept)
        if (answer.record.parentId !== parent) throw new Error('revealed reply has a different parent')
        learn(s, chain, answer.at, [answer.record])
      }
      if (s.records.get(kept)!.record.parentId !== parent) throw new Error('revealed reply has a different parent')
    }
    if (reveal !== undefined) branch.revealed.add(reveal)
    const all = listed(s, branch)
    const loaded = all.slice(0, limit)
    const drawn = new Set(loaded.map((r) => r.id))
    // Preview pins belong to this view, not the shared reply session.
    const pinned = new Set([...branch.revealed, ...retain])
    const tail = live(s, [...pinned].filter((id) => !drawn.has(id)))
    const list = [...loaded, ...tail]
    branch.shown = limit
    const total = s.records.get(parent)?.record.replies ?? all.length
    const more = branch.next !== null || list.length < total
    return { list, loaded: loaded.length, tailStart: more ? tail[0]?.id ?? null : null, children: pageOf(s), total, more }
  })
}

/** Update retained stream branches without opening them or crossing a paging gap. */
export async function acceptReply(chain: ChainInfo, roots: Iterable<bigint>, at: api.At, record: api.RecordImage, parent?: api.RecordImage): Promise<void> {
  if (record.parentId === 0n || endingOf(record.gate)) return
  await Promise.all([...roots].map(async root => {
    const s = sessions.get(sessionKey(chain, root))
    if (!s) return
    await s.queue.run(async () => {
      const branch = s.branches.get(record.parentId)
      if (!branch || s.at?.generation !== at.generation) return
      await branch.queue.run(() => {
        const append = complete(s, branch)
        learn(s, chain, at, [...(parent ? [parent] : []), ...(append ? [record] : [])])
        if (append) {
          branch.ids.add(record.id)
          branch.shown = Math.max(branch.shown, listed(s, branch).length)
        }
      })
    })
  }))
}

/**
 * The complete, fully shown branches on screen in the thread sessions rooted
 * at `roots`, each with the replies it already holds: what a refresh would
 * append to. `mounted` names the parents whose lists are on screen; a branch
 * the reader folded stays in its session but is not one a refresh would show.
 * A stream's cue counts new replies inside its open conversations with this,
 * in the same poll as the stream itself.
 */
export function completeBranches(chain: ChainInfo, roots: Iterable<bigint>, mounted: ReadonlySet<bigint>): Map<bigint, ReadonlySet<bigint>> {
  const out = new Map<bigint, ReadonlySet<bigint>>()
  for (const root of roots) {
    const s = sessions.get(sessionKey(chain, root))
    if (!s) continue
    for (const [parent, branch] of s.branches) {
      if (mounted.has(parent) && complete(s, branch)) out.set(parent, branch.ids)
    }
  }
  return out
}

const quietReplies = new WeakMap<ReplyPage, QuietChanges>()

/** A cue for replies a refresh would reveal in already-open, complete branches. */
export async function peekReplies(chain: ChainInfo, page: ReplyPage, shown: Iterable<bigint>, listener?: Listener): Promise<number> {
  const s = page.session
  const parents = new Set([...shown].filter((id) => {
    const branch = s.branches.get(id)
    return branch !== undefined && complete(s, branch)
  }))
  if (parents.size === 0) return 0
  let quiet = quietReplies.get(page)
  if (!quiet) { quiet = new QuietChanges(); quietReplies.set(page, quiet) }
  return quiet.peek(chain, page.at, listening({ parents: [...parents].map(String), gates: false }, listener), record =>
    !wallet.is(record.author) && parents.has(record.parentId) && !endingOf(record.gate) && !s.branches.get(record.parentId)!.ids.has(record.id), listener?.heard)
}

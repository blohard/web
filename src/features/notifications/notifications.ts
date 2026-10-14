// Replies and body references share a host-indexed timeline. Historical
// pages use a cursor; new associations, including old posts whose bodies just
// arrived, come through changes. The host excludes the reader's blocklist;
// personal mutes are applied only in this tab.
import type { Address, Hex } from 'viem'
import * as api from '../../lib/api'
import { notificationList } from '../account/blocking'
import { endingOf, newestFirst } from '../../lib/board'
import { gates } from '../../lib/gates.svelte'
import { sameAddress } from '../../lib/format'
import { rememberMessages } from '../../lib/messages'
import { muted } from '../../lib/muted.svelte'
import { SerialQueue } from '../../shared/serial-queue'
import type { ChainInfo } from '../../lib/types'

export type Notification = {
  post: api.RecordImage
  chain: ChainInfo
  timestamp: number
} & (
  | { kind: 'reply' }
  | { kind: 'mention' }
  | { kind: 'quote'; quoted: { chainId: number; id: bigint; commit: Hex } }
)
/** Every visible notification read so far, newest first. How many the page shows, and which it keeps, is notification-activity.ts's. */
type NotificationPage = { items: Notification[]; complete: boolean; sourcesRead: boolean }
type View = {
  rows: Map<bigint, Notification>; cursor: api.Cursor | null; at: api.At | null
  complete: boolean; queue: SerialQueue
}
const views = new Map<string, View>()
function viewFor(chain: ChainInfo, me: Address): View {
  const key = `${chain.id}/${chain.contract.toLowerCase()}/${me.toLowerCase()}`
  let v = views.get(key)
  if (!v) {
    v = { rows: new Map(), cursor: null, at: null, complete: false, queue: new SerialQueue() }
    views.set(key, v)
  }
  return v
}
function decode(chain: ChainInfo, me: Address, row: api.WireNotification): Notification {
  const post = api.record(row), reason = row.reference
  if (!reason) {
    if (post.parentId !== 0n && sameAddress(post.parentAuthor, me)) return { kind: 'reply', post, chain, timestamp: post.timestamp }
    throw new Error('host notification does not match this account')
  }
  if (reason.kind === 'mention' && sameAddress(reason.account, me)) return { kind: 'mention', post, chain, timestamp: post.timestamp }
  if (reason.kind !== 'quote') throw new Error('host notification reason does not match this account')
  const chainId = api.integer(reason.target.chain), id = api.integer(reason.target.id)
  if (chainId === 0n || chainId > BigInt(Number.MAX_SAFE_INTEGER) || id === 0n || !/^0x[0-9a-f]{64}$/.test(reason.target.commit)) throw new Error('invalid host quote target')
  return { kind: 'quote', post, chain, timestamp: post.timestamp, quoted: { chainId: Number(chainId), id, commit: reason.target.commit } }
}
function remember(chain: ChainInfo, me: Address, v: View, at: api.At, rows: api.WireNotification[]) {
  const found: Notification[] = []
  for (const row of rows) {
    try { found.push(decode(chain, me, row)) } catch { /* A bad row cannot hide valid notifications. */ }
  }
  rememberMessages(chain, at, found.map((r) => r.post))
  for (const r of found) v.rows.set(r.post.id, r)
}
const shows = (r: Notification, me: Address) => !sameAddress(r.post.author, me) && !muted.has(r.post.author) && !endingOf(r.post.gate)
function visible(v: View, me: Address): Notification[] {
  return [...v.rows.values()].filter((r) => shows(r, me)).sort((a, b) => newestFirst(a.post, b.post))
}
/** The newest time among rows this page would show, or null. */
function newestShown(chain: ChainInfo, me: Address, rows: api.WireNotification[]): number | null {
  let newest: number | null = null
  for (const row of rows) {
    try {
      const r = decode(chain, me, row)
      if (shows(r, me)) newest = Math.max(newest ?? 0, r.timestamp)
    } catch { /* A row that is not a notification of `me` shows nothing. */ }
  }
  return newest
}

/** Find the first visible notification with the same bounded paging budget as the page. */
export async function newestNotification(chain: ChainInfo, me: Address): Promise<{ timestamp: number | null; at: api.At }> {
  let cursor: api.Cursor | null = null, head: api.At | undefined
  for (let n = 0; n < 8; n++) {
    const page = await api.notifications(chain, me, cursor, 20, notificationList(chain, me))
    if (page.items.length > 20 || (head && page.at.generation !== head.generation)) throw new api.ApiError(409, 'reset_required')
    if (page.next && cursor && api.integer(page.next.before) >= api.integer(cursor.before)) throw new Error('host notification cursor made no progress')
    head ??= page.at
    const newest = newestShown(chain, me, page.items)
    if (newest !== null || !page.next) return { timestamp: newest, at: head }
    cursor = page.next
  }
  return { timestamp: null, at: head! }
}

/** New replies to this account and references carried by a shared changes answer. */
export function newestIn(chain: ChainInfo, me: Address, answer: api.Changes): number | null {
  const posted = new Set(api.postedIn(answer).map((message) => api.integer(message.id)))
  const replies = answer.records.filter((wire) => posted.has(api.record(wire).id)).map((wire) => ({ ...wire, reference: null }))
  return newestShown(chain, me, [...replies, ...answer.references])
}
async function refresh(chain: ChainInfo, me: Address, v: View) {
  if (!v.at) return
  for await (const { from, answer: page, next } of api.changePages(chain, v.at, { account: me, exclude_list: notificationList(chain, me), feed: { any: [{ parent_authors: [me], kind: 'replies' }], exclude_list: notificationList(chain, me) } })) {
    if (!gates.follow(chain, from, page)) await gates.advanceToHead(chain)
    remember(chain, me, v, page.at, page.references)
    for (const wire of page.records) {
      const post = api.record(wire), old = v.rows.get(post.id)
      if (old) v.rows.set(post.id, { ...old, post })
      else if (post.parentId !== 0n && sameAddress(post.parentAuthor, me)) remember(chain, me, v, page.at, [{ ...wire, reference: null }])
    }
    v.at = next
  }
}
async function older(chain: ChainInfo, me: Address, v: View, limit: number) {
  for (let n = 0; n < 8 && !v.complete && visible(v, me).length < limit; n++) {
    const page = await api.notifications(chain, me, v.cursor, 20, notificationList(chain, me))
    if (page.items.length > 20 || (v.at && page.at.generation !== v.at.generation)) throw new api.ApiError(409, 'reset_required')
    if (page.next && v.cursor && api.integer(page.next.before) >= api.integer(v.cursor.before)) throw new Error('host notification cursor made no progress')
    remember(chain, me, v, page.at, page.items)
    v.at ??= page.at
    v.cursor = page.next
    v.complete = page.next === null
  }
}

/**
 * Read each chain's notifications far enough back for `limit` visible rows,
 * and return all those read so far. One chain failing retains its earlier
 * results; all chains failing keeps the page's retry state. `complete`: every
 * chain was read and has no older history.
 */
export async function findNotifications(chains: ChainInfo[], me: Address, limit = 20): Promise<NotificationPage> {
  const selected = chains.map((chain) => ({ chain, v: viewFor(chain, me) }))
  const reads = await Promise.allSettled(selected.map(({ chain, v }) => {
    return v.queue.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          if (v.at) await refresh(chain, me, v)
          else await gates.advanceToHead(chain)
          await older(chain, me, v, limit)
          break
        } catch (error) {
          if (!api.positionLost(error)) throw error
          // Unblocking must recover references omitted from earlier pages.
          v.rows.clear(); v.at = null; v.cursor = null; v.complete = false
          if (attempt > 0) throw error
        }
      }
    })
  }))
  if (reads.length && reads.every((r) => r.status === 'rejected')) throw (reads[0] as PromiseRejectedResult).reason
  const items = selected.flatMap(({ v }) => visible(v, me))
    .sort((a, b) => b.timestamp - a.timestamp || (a.chain.id === b.chain.id ? newestFirst(a.post, b.post) : a.chain.id - b.chain.id))
  const sourcesRead = reads.every((r) => r.status === 'fulfilled')
  return { items, complete: sourcesRead && selected.every(({ v }) => v.complete), sourcesRead }
}

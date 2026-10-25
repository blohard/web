import type { Address } from 'viem'
import { findNotifications, type Notification } from './notifications'
import { KeyNotifications, keyNoticeId, keyNoticeParty, type KeyNotification } from '../keys/key-notifications.svelte'
import { SerialQueue } from '../../shared/serial-queue'
import type { ChainInfo, Status } from '../../lib/types'

type Activity = Notification | KeyNotification
const isKey = (n: Activity): n is KeyNotification => n.kind === 'key-trade' || n.kind === 'key-received'
export const activityId = (n: Activity) => isKey(n) ? keyNoticeId(n) : `post/${n.chain.id}/${n.post.id}`
export const activityAuthor = (n: Activity) => isKey(n) ? keyNoticeParty(n) : n.post.author
function newestActivity(a: Activity, b: Activity): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp
  if (a.chain.id !== b.chain.id) return a.chain.id - b.chain.id
  const ap = isKey(a) ? { block: a.block, log: a.log } : { block: a.post.blockNumber, log: a.post.logIndex }
  const bp = isKey(b) ? { block: b.block, log: b.log } : { block: b.post.blockNumber, log: b.post.logIndex }
  return ap.block === bp.block ? bp.log - ap.log : ap.block > bp.block ? -1 : 1
}
/**
 * The rows a reader's notifications page has shown, by reader and chains. Kept
 * for the tab, so a page opened again keeps them; the oldest readers go first.
 */
const shownBy = new Map<string, Set<string>>()
const READERS = 16

/**
 * The first `limit` rows, stretched to keep every row this reader's page
 * showed before, wherever newer rows have since pushed it; then remembered.
 */
function keepShown(reader: string, rows: Activity[], limit: number): { items: Activity[]; limit: number } {
  const before = shownBy.get(reader)
  const shownLimit = before ? rows.reduce((n, row, i) => before.has(activityId(row)) ? Math.max(n, i + 1) : n, limit) : limit
  const items = rows.slice(0, shownLimit)
  shownBy.delete(reader) // re-added below as the most recent reader
  if (shownBy.size >= READERS) shownBy.delete(shownBy.keys().next().value!)
  shownBy.set(reader, new Set(items.map(activityId)))
  return { items, limit: shownLimit }
}

/**
 * The notifications page: posts and key activity merged into one list. It is
 * the one place that decides how many rows show and keeps every row it showed
 * when newer ones arrive, from any source. Market failures leave ordinary
 * notifications usable. Each view owns its history cursor.
 */
export class NotificationActivity {
  readonly keys: KeyNotifications[]
  private queue = new SerialQueue()
  private readonly reader: string
  constructor(readonly chains: ChainInfo[], readonly me: Address, markets: Status['keyrings']) {
    this.keys = (markets ?? []).flatMap(market => {
      const chain = chains.find(c => c.id === market.chain)
      return chain ? [new KeyNotifications(chain, market.market, me)] : []
    })
    this.reader = `${me.toLowerCase()} ${chains.map(c => `${c.id}/${c.contract.toLowerCase()}`).join(',')}`
  }
  load(limit: number, refresh: unknown) {
    return this.queue.run(async () => {
      const [posts, trades] = await Promise.all([
        findNotifications(this.chains, this.me, limit),
        Promise.all(this.keys.map(keys => keys.load(limit, refresh)
          .then(value => ({ ...value, failed: false }), () => ({ items: keys.visible(), complete: false, truncated: false, failed: true })))),
      ])
      const rows: Activity[] = [...posts.items, ...trades.flatMap(t => t.items)]
      rows.sort(newestActivity)
      const page = keepShown(this.reader, rows, limit)
      return { ...page, complete: posts.complete && trades.every(t => t.complete) && rows.length <= page.limit,
        sourcesRead: posts.sourcesRead && trades.every(t => !t.failed),
        keyError: trades.some(t => t.failed), truncated: trades.some(t => t.truncated) }
    })
  }
}

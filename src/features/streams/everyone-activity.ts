import { newerPosition } from '../keys/key-position'
import type { Page } from './feed'
import type { ConversationRowData } from './conversation'
import { KeyActivityFeed, keyActivityId, type KeyActivity } from '../keys/key-activity'
import type { Address } from 'viem'
import type { ChainInfo } from '../../lib/types'
import { SerialQueue } from '../../shared/serial-queue'

type ActivityRow = { kind: 'post'; key: string; row: ConversationRowData } | { kind: 'key'; key: string; event: KeyActivity }
export type ActivityPage = Page & { entries: ActivityRow[]; keyError?: boolean }
export const postActivity = (page: Page): ActivityPage => ({ ...page, entries: page.rows.map(row => ({ kind: 'post', key: String(row.key), row })) })
function position(row: ActivityRow) {
  if (row.kind === 'key') return row.event
  const p = row.row.activity ?? row.row.lead
  return { block: p.blockNumber, log: p.logIndex }
}
/** Keep the conversation reader intact; merge its prepared rows with key events. */
export class EveryoneActivity {
  readonly keys: KeyActivityFeed
  private shown: ActivityRow[] = []
  private posts: { key: string; block: bigint; log: number }[] = []
  private queue = new SerialQueue()
  private retry = false
  constructor(chain: ChainInfo, market: Address) { this.keys = new KeyActivityFeed(chain, market) }
  load(read: Promise<Page>, refresh: boolean, preserve: boolean, mode?: 'older' | 'resume'): Promise<ActivityPage> {
    // Attach a rejection handler now, even while an earlier key read owns the queue.
    void read.catch(() => {})
    return this.queue.run(async () => {
      const page = await read
      let complete = false, keyError = false
      try { complete = (await this.keys.load(page.limit, refresh || this.retry)).complete; this.retry = false }
      catch { keyError = true; this.retry = true }
      const postEntries = postActivity(page).entries
      const posts = postEntries.map(row => ({ key: row.key, ...position(row) }))
      const candidates: ActivityRow[] = [...postEntries, ...this.keys.visible().map(event => ({ kind: 'key' as const, key: keyActivityId(event), event }))]
      // Never show older activity past an unfinished source's scan. Otherwise
      // the next page could insert missing rows above content already shown.
      const frontier = this.keys.frontier()
      let entries = candidates.filter(row => {
        const at = position(row)
        if (!page.complete && (!page.scannedThrough || newerPosition(at, page.scannedThrough) > 0)) return false
        return keyError || !frontier || newerPosition(at, frontier) <= 0
      })
      entries.sort((a, b) => newerPosition(position(a), position(b)))
      const shown = new Set(this.shown.map(row => row.key))
      if (mode) {
        const current = new Map(entries.map(row => [row.key, row]))
        const postKeys = new Set(posts.map(row => row.key))
        const before = this.posts.filter(row => postKeys.has(row.key))
        // A local publication can change the off-screen post page. Honor that
        // update. An ordinary Back keeps the mixed order left by paging.
        const unchanged = before.length === posts.length && before.every((row, i) =>
          posts[i].key === row.key && newerPosition(row, posts[i]) === 0)
        if (mode === 'older' || unchanged) {
          // Paging keeps displayed cards intact. Back accepts current rows so
          // filtering and local changes still apply.
          const retained = mode === 'older' ? this.shown : this.shown.flatMap(row => {
            const updated = current.get(row.key)
            return updated ? [updated] : []
          })
          entries = [...retained, ...entries.filter(row => !shown.has(row.key))]
        }
      }
      const limit = preserve ? entries.reduce((n, r, i) => shown.has(r.key) ? Math.max(n, i + 1) : n, page.limit) : page.limit
      this.shown = entries.slice(0, limit)
      this.posts = posts
      return { ...page, entries, limit, keyError, complete: page.complete && complete }
    })
  }
}

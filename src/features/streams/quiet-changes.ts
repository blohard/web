import type { Address } from 'viem'
import * as api from '../../lib/api'
import { sameAddress } from '../../lib/format'
import type { ChainInfo } from '../../lib/types'

/** Another reader of a poll's answers: the account its scope adds, and what hears each answer. */
export type Listener = { account: Address; heard: (answer: api.Changes, from: api.At) => unknown }

/**
 * A poll's scope widened for a listener: the account's new references, and
 * replies to it unless the poll's feed already selects them. No exclusion
 * list, since its membership changes would stop the poll with a reset, so
 * what the listener hears is a cue to confirm, not a verdict.
 */
export function listening(scope: api.ChangeScope, listener?: Listener): api.ChangeScope {
  if (!listener) return scope
  const me = listener.account
  const covered = scope.feed?.any.some((c) => !c.authors?.length && c.kind !== 'posts' && c.parent_authors?.some((a) => sameAddress(a, me)))
  const replies = { parent_authors: [me], kind: 'replies' as const }
  return { ...scope, account: me, ...(covered ? {} : { feed: { ...scope.feed, any: [...(scope.feed?.any ?? []), replies] } }) }
}

/** A bounded refresh cue, separate from the snapshot the reader is viewing.
 * One page per poll advances past unrelated activity. Only actual matching
 * posts count; after fifty we stop counting, and stop scanning until the
 * reader refreshes unless a listener still reads the range. */
export class QuietChanges {
  private scan: { base: api.At; scope: string; from: api.At; until?: api.At; rows: Map<bigint, api.RecordImage> } | null = null

  private resetRequired = false

  pending(base: api.At): number {
    if (this.scan?.base !== base) return 0
    return this.resetRequired || this.scan.rows.size > 50 ? Infinity : this.scan.rows.size
  }

  /** A locally merged post is no longer unseen; unrelated queued changes stay. */
  forget(id: bigint): void { this.scan?.rows.delete(id) }

  /** `heard` sees each answer too, so another reader of the same range needs no request of its own. */
  async peek(chain: ChainInfo, base: api.At, scope: api.ChangeScope, keeps: (row: api.RecordImage) => boolean | Promise<boolean>,
    heard?: (answer: api.Changes, from: api.At) => void): Promise<number> {
    const key = JSON.stringify(scope)
    if (!this.scan || this.scan.base !== base || this.scan.scope !== key) {
      // A newly opened branch needs its own scan, but posts already found for
      // this displayed snapshot remain pending until an explicit refresh.
      this.resetRequired = false
      this.scan = { base, scope: key, from: base, rows: this.scan?.base === base ? this.scan.rows : new Map() }
    }
    const scan = this.scan
    const rows = new Map(scan.rows)
    for (const [id, row] of rows) if (!await keeps(row)) rows.delete(id)
    if (rows.size > 50 && !heard) { scan.rows = rows; return Infinity }
    // Listeners share the view's cursor. Their older checkpoints must not
    // delay its refresh cue or send this request outside retained history.
    const from = scan.from
    let answer: api.Changes
    try {
      answer = await api.changes(chain, from, scope, scan.until)
    } catch (error) {
      // The host no longer serves this view's position: only a refresh,
      // which starts the view over, can show what changed.
      if (api.positionLost(error)) { this.resetRequired = true; return Infinity }
      throw error
    }
    heard?.(answer, from)
    const posted = new Set(api.postedIn(answer)
      .map(message => api.integer(message.id)))
    // Past fifty only the listener reads on: the count keeps the rows it has.
    if (rows.size <= 50) for (const wire of answer.records) {
      const row = api.record(wire)
      if (rows.has(row.id) || posted.has(row.id)) {
        if (await keeps(row)) rows.set(row.id, row)
        else rows.delete(row.id)
      }
      if (rows.size > 50) break
    }
    scan.rows = rows
    scan.from = api.afterChanges(from, answer)
    scan.until = answer.more ? answer.until : undefined
    return rows.size > 50 ? Infinity : rows.size
  }
}

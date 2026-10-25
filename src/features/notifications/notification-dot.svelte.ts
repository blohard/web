// Home and Thread carry notification cues in their existing polls. A separate
// two-minute indexed check covers other pages, key activity and hidden tabs;
// returning to a visible tab checks immediately. No check changes the stream.
// Known limitation: seen times cannot distinguish same-time activity or a mention
// whose body is discovered after a newer post was seen. No per-item history is stored.
import { untrack } from 'svelte'
import type { Address } from 'viem'
import * as api from '../../lib/api'
import type { Listener } from '../streams/quiet-changes'
import { keyNoticeParty, readKeyNotifications } from '../keys/key-notifications.svelte'
import { muted } from '../../lib/muted.svelte'
import { newestIn, newestNotification } from './notifications'
import { sharedRead } from '../../shared/shared-read'
import { readJSON, writeJSON } from '../../lib/storage'
import type { ChainInfo, Status } from '../../lib/types'

const PREFIX = 'blohard.notifications-seen.'
type NotificationVisit = { account: Address; heard: number }
const validTime = (time: unknown): time is number =>
  typeof time === 'number' && Number.isSafeInteger(time) && time >= -1 && time <= 0xffff_ffff

type Discovery = { at: api.At | null; wanted: number; confirmed: number; needsCheck: boolean; version: number }
type Schedule = (work: () => void, ms: number) => () => void
const later: Schedule = (work, ms) => {
  const timer = setTimeout(work, ms)
  return () => clearTimeout(timer)
}
/** Waits before asking again after a failed load check. */
const RECHECKS = [30_000, 60_000, 120_000]

export class NotificationDot {
  private newest = $state<Record<string, number>>({})
  private seen = $state<Record<string, number>>({})
  private flights = new Map<string, Promise<boolean>>()
  private confirmations = new Map<string, Promise<void>>()
  private checked = new Set<string>()
  private discovery = new Map<string, Discovery>()

  private chainKey(chain: ChainInfo, me: Address) { return `${me}/${chain.id}/${chain.contract}`.toLowerCase() }

  private cursor(chain: ChainInfo, me: Address): Discovery {
    const key = this.chainKey(chain, me)
    let state = this.discovery.get(key)
    if (!state) {
      state = { at: null, wanted: -1, confirmed: -1, needsCheck: true, version: 0 }
      this.discovery.set(key, state)
    }
    return state
  }

  private confirm(chain: ChainInfo, me: Address): Promise<void> {
    return sharedRead(this.confirmations, this.chainKey(chain, me), async () => {
      const state = this.cursor(chain, me), wanted = state.wanted, version = state.version
      const result = await newestNotification(chain, me)
      if (version !== state.version) return
      this.heard(me, result.timestamp)
      state.needsCheck = false
      state.confirmed = Math.max(state.confirmed, wanted)
      // A successful head read covers this range too. Never rewind discovery
      // when a slower response lands after a shared poll has advanced it.
      if (!state.at || state.at.generation !== result.at.generation || api.integer(state.at.sequence) < api.integer(result.at.sequence)) state.at = result.at
    })
  }

  listen(chain: ChainInfo, me: Address): Listener {
    const state = this.cursor(chain, me)
    return { account: me, heard: (answer, from) => {
      if (state.at && state.at.generation !== from.generation) {
        state.at = null; state.needsCheck = true; state.version++
        state.wanted = -1; state.confirmed = -1
      }
      const next = api.afterChanges(from, answer)
      // A refreshed view can skip activity discovery has not checked. Read
      // the notifications head rather than making the feed scan that gap.
      // Only a successful confirmation may cover the missing range.
      if (!state.at || api.integer(from.sequence) > api.integer(state.at.sequence)) state.needsCheck = true
      else if (api.integer(next.sequence) > api.integer(state.at.sequence)) state.at = next
      const time = newestIn(chain, me, answer)
      if (time !== null && time > this.seenBy(me.toLowerCase())) state.wanted = Math.max(state.wanted, time)
      // An unsuccessful confirmation remains pending for the next shared poll,
      // even if that next answer contains no new candidate.
      if (state.needsCheck || state.wanted > state.confirmed) return this.confirm(chain, me).catch(() => {})
    } }
  }

  private seenBy(account: string) {
    const saved = readJSON<unknown>(PREFIX + account, -1)
    return Math.max(this.seen[account] ?? -1, validTime(saved) ? saved : -1)
  }

  shown(account: Address | null): boolean {
    if (!account) return false
    const a = account.toLowerCase()
    return (this.newest[a] ?? -1) > this.seenBy(a)
  }

  heard(account: Address, time: number | null) {
    const a = account.toLowerCase()
    if (time !== null && validTime(time) && time > (this.newest[a] ?? -1)) this.newest[a] = time
  }

  /** Capture at request start without making a page depend on background results. */
  begin(account: Address): NotificationVisit {
    return untrack(() => ({ account, heard: this.newest[account.toLowerCase()] ?? -1 }))
  }

  /** Only the accepted, displayed result may acknowledge this visit. Failures acknowledge nothing. */
  saw(visit: NotificationVisit, time: number | undefined, sourcesRead: boolean) {
    if (!sourcesRead) return
    const a = visit.account.toLowerCase()
    const upTo = Math.max(validTime(time) ? time : -1, visit.heard, this.seenBy(a))
    this.seen[a] = upTo
    // Re-read storage before writing so an older tab cannot overwrite newer progress.
    writeJSON(PREFIX + a, upTo)
  }

  constructor(private schedule: Schedule = later) {}

  /** Indexed reads only. Concurrent initial checks share their requests. Whether every source was read. */
  check(chains: ChainInfo[], me: Address, markets: Status['keyrings']): Promise<boolean> {
    const key = `${me}/${chains.map(c => `${c.id}/${c.contract}`).join(',')}/${(markets ?? []).map(m => `${m.chain}/${m.market}`).join(',')}`.toLowerCase()
    return sharedRead(this.flights, key, async () => {
      const reads: Promise<void>[] = chains.map(c => this.confirm(c, me))
      for (const market of markets ?? []) {
        const keyChain = chains.find(c => c.id === market.chain)
        if (!keyChain) continue
        // The host retains at most 100 inbox entries, including muted ones.
        reads.push(readKeyNotifications(keyChain, market.market, me, null, 100)
          .then(page => this.heard(me, page.items.find(n => !muted.has(keyNoticeParty(n)))?.timestamp ?? null)))
      }
      return (await Promise.allSettled(reads)).every((r) => r.status === 'fulfilled')
    })
  }

  /** Check on load, on return and every two minutes, including while hidden. */
  watch(chains: ChainInfo[], me: Address, markets: Status['keyrings']): () => void {
    const a = me.toLowerCase()
    const storage = (event: StorageEvent) => {
      if (event.key !== PREFIX + a) return
      const time = this.seenBy(a)
      this.seen[a] = time
      // Repair an overlapping write from a tab that had not seen our progress yet.
      const saved = readJSON<unknown>(PREFIX + a, -1)
      if (!validTime(saved) || saved < time) writeJSON(PREFIX + a, time)
    }
    window.addEventListener('storage', storage)
    let cancel: (() => void) | null = null, stopped = false, running = false
    const run = (attempt = 0) => {
      if (stopped || running) return
      cancel?.(); cancel = null
      running = true
      void this.check(chains, me, markets).then((read) => {
        if (stopped) return
        if (read) this.checked.add(a)
        else if (attempt < RECHECKS.length) cancel = this.schedule(() => {
          cancel = null
          run(attempt + 1)
        }, RECHECKS[attempt]!)
      }).finally(() => { running = false })
    }
    const returned = () => { if (document.visibilityState === 'visible') run() }
    document.addEventListener('visibilitychange', returned)
    window.addEventListener('focus', returned)
    const timer = setInterval(run, 120_000)
    if (!this.checked.has(a)) run(0)
    return () => {
      stopped = true
      cancel?.()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', returned)
      window.removeEventListener('focus', returned)
      window.removeEventListener('storage', storage)
    }
  }
}

export const notificationDot = new NotificationDot()

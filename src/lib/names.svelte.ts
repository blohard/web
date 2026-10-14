// Names are display hints. The host verifies and normalizes primary names;
// the client checks the response shape before displaying them.
import { SerialQueue } from '../shared/serial-queue'
import { sharedRead } from '../shared/shared-read'
import { getAddress } from 'viem'
import { shortAddress } from './format'
import { ApiError, requestPath } from './api'
import { host } from './host.svelte'
import { readJSON, writeJSON } from './storage'

type NameEntry = {
  name: string | null
  source: 'ens' | 'basenames' | null
  /** The avatar the name's owner set, as an https URL, if any. */
  avatar: string | null
  checkedAt: number
  error?: boolean
  /** A read behind the answer failed (the avatar, or ENS ahead of a basename): kept an hour, like a negative answer. */
  partial?: true
}

const KEY = 'blohard.names.v2'
const TTL_FOUND = 24 * 60 * 60_000
const TTL_NONE = 60 * 60_000
const RETRY_AFTER_ERROR = 5 * 60_000
/** Answers arriving within this wait are saved to browser storage together. */
const SAVE_DELAY = 1_000
/** Waits before each retry of a busy host (429 or 503), about 40 seconds in all: a cold cache fills in that time. */
const RETRIES = [2000, 5000, 10_000, 20_000]
const PAUSED = Symbol('paused')
/** A day only for a whole found name. */
const ttl = (entry: NameEntry) => entry.error ? RETRY_AFTER_ERROR : entry.name && !entry.partial ? TTL_FOUND : TTL_NONE
/** Where the name's own profile lives: the ENS app, or the Basenames site (which drops the `.base.eth` suffix). */
export function profileUrl(entry: NameEntry): string | null {
  if (!entry.name) return null
  if (entry.source === 'ens') return `https://app.ens.domains/${encodeURIComponent(entry.name)}`
  if (entry.source === 'basenames') return `https://www.base.org/name/${encodeURIComponent(entry.name.replace(/\.base\.eth$/i, ''))}`
  return null
}

/**
 * Accept only a well-formed answer. The host verifies each name and shows it
 * only in ENS's normalized spelling (host/src/names.rs), so a lookalike never
 * reaches here and the page does not carry the normalization tables.
 */
export function checkedName(value: Omit<NameEntry, 'checkedAt'>): Omit<NameEntry, 'checkedAt'> {
  if (value.name === null) return { name: null, source: null, avatar: null }
  if (typeof value.name !== 'string' || new TextEncoder().encode(value.name).length > 255
    || !['ens', 'basenames'].includes(value.source ?? '')
    || (value.source === 'basenames' && !value.name.endsWith('.base.eth'))) throw new Error('invalid verified name')
  let avatar: string | null = null
  if (typeof value.avatar === 'string' && value.avatar.length <= 2100) {
    try {
      // Plain https only: no credentials or port to carry to the owner's server.
      const url = new URL(value.avatar)
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port) avatar = value.avatar
    } catch { /* No usable avatar. */ }
  }
  return { name: value.name, source: value.source, avatar, ...(value.partial === true ? { partial: true as const } : {}) }
}

/** Bound persisted addresses and serialized storage, with newest answers first. */
export function pruneNames(entries: Record<string, NameEntry>, now = Date.now()): Record<string, NameEntry> {
  const kept: Record<string, NameEntry> = {}
  let bytes = 2, count = 0
  for (const [key, entry] of Object.entries(entries).sort((a, b) => (b[1]?.checkedAt ?? 0) - (a[1]?.checkedAt ?? 0))) {
    if (!entry || entry.error || !Number.isFinite(entry.checkedAt) || entry.checkedAt > now
      || now - entry.checkedAt >= ttl(entry) || !/^0x[0-9a-f]{40}$/.test(key)) continue
    let value: NameEntry
    try { value = { ...checkedName(entry), checkedAt: entry.checkedAt } } catch { continue }
    const size = JSON.stringify([key, value]).length * 2
    if (count >= 512 || bytes + size > (1 << 20)) break
    kept[key] = value
    bytes += size; count++
  }
  return kept
}

/** Into `into`, every answer of `from` newer than the one it holds: tabs save and hear each other in any order. */
function mergeNewest(into: Record<string, NameEntry>, from: Record<string, NameEntry>): Record<string, NameEntry> {
  for (const [k, entry] of Object.entries(from)) {
    const held = into[k]
    if (!held || !(held.checkedAt > entry.checkedAt)) into[k] = entry
  }
  return into
}

class Names {
  entries = $state<Record<string, NameEntry>>(pruneNames(readJSON<Record<string, NameEntry>>(KEY, {})))
  private inflight = new Map<string, Promise<void>>()
  private lanes = [new SerialQueue(), new SerialQueue()]
  private nextLane = 0
  private pausedUntil = 0
  /** Answers not yet saved, and the timer that saves them together. */
  private unsaved: Record<string, NameEntry> = {}
  private saving: ReturnType<typeof setTimeout> | null = null

  constructor() {
    // Another tab's lookups are as good as ours: adopt them instead of asking
    // again, so every tab shows the same names and pictures.
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === KEY) this.adopt(pruneNames(readJSON<Record<string, NameEntry>>(KEY, {})))
      })
    }
  }

  /** The name to show for an address, or its short form while none is known. */
  display(address: string): string {
    return this.lookup(address)?.name ?? shortAddress(address)
  }

  /** What is known for an address; starts a lookup when nothing fresh is cached. */
  lookup(address: string): NameEntry | undefined {
    const k = address.toLowerCase()
    const e = this.entries[k]
    if (e && Date.now() - e.checkedAt < ttl(e)) return e
    if (host.status?.gateway?.names) void this.resolve(k).catch(() => { /* A full queue can be tried on the next display read. */ })
    return e
  }

  /** The fresh name already known for an address, without asking the host. */
  known(address: string): string | undefined {
    const e = this.entries[address.toLowerCase()]
    return e && !e.error && Date.now() - e.checkedAt < ttl(e) ? e.name ?? undefined : undefined
  }

  /** A profile name can help discover sponsorship, but never proves ownership. */
  async hint(address: string): Promise<string | undefined> {
    const k = address.toLowerCase()
    const cached = this.entries[k]
    // A display lookup's failure keeps its cooldown for display only; this
    // check asks again, sharing any lookup in flight and the host's pause.
    if (cached && !cached.error && Date.now() - cached.checkedAt < ttl(cached)) return cached.name ?? undefined
    if (!host.status?.gateway?.names) return undefined
    await this.resolve(k)
    if (this.entries[k]?.error) throw new Error('could not look up your name to check free posting')
    return this.entries[k]?.name ?? undefined
  }

  private resolve(k: string): Promise<void> {
    // A cold page queues names instead of flooding the host. Duplicate cards
    // already share inflight; cap the queue as well as the two active requests.
    const existing = this.inflight.get(k)
    if (existing) return existing
    if (this.inflight.size >= 512) return Promise.reject(new Error('could not look up your name to check free posting'))
    return sharedRead(this.inflight, k, () => this.fetch(k))
  }

  private async read(address: string): Promise<Omit<NameEntry, 'checkedAt'>> {
    for (;;) {
      for (let wait = this.pausedUntil - Date.now(); wait > 0; wait = this.pausedUntil - Date.now()) {
        await new Promise(resolve => setTimeout(resolve, wait))
      }
      const answer = await this.lanes[this.nextLane++ % 2]!.run(async () => {
        if (this.pausedUntil > Date.now()) return PAUSED
        try {
          return await requestPath<Omit<NameEntry, 'checkedAt'>>(`/api/names/${address.toLowerCase()}`)
        } catch (error) {
          // Publish the visitor-wide pause before queued requests take this lane.
          // A 503 leaves other names free to use the host's warm cache.
          if (error instanceof ApiError && error.status === 429) {
            this.pausedUntil = Math.max(this.pausedUntil, Date.now() + Math.max(2000, Math.min(error.retryAfter ?? 0, 30_000)))
          }
          throw error
        }
      })
      if (answer !== PAUSED) return answer
    }
  }

  private async fetch(k: string) {
    let entry: NameEntry = { name: null, source: null, avatar: null, checkedAt: Date.now() }
    try {
      const address = getAddress(k)
      let answer: Omit<NameEntry, 'checkedAt'>
      for (let attempt = 0; ; attempt++) {
        try {
          // Only the HTTP request owns a lane; backoff keeps its place in
          // the bounded inflight map without blocking unrelated names.
          answer = await this.read(address)
          break
        } catch (error) {
          if (!(error instanceof ApiError) || ![429, 503].includes(error.status) || attempt >= RETRIES.length) throw error
          // Never sooner than the host asks, and at most half a minute for any one wait.
          await new Promise(resolve => setTimeout(resolve, Math.max(RETRIES[attempt]!, Math.min(error.retryAfter ?? 0, 30_000))))
        }
      }
      const found = checkedName(answer)
      entry = { ...found, checkedAt: Date.now() }
    } catch {
      // A failed check is not evidence that a known name or avatar disappeared.
      // Keep it for display, but never treat it as an ownership check.
      entry = { ...(this.entries[k] ?? entry), error: true, checkedAt: Date.now() }
    }
    // Only this name's readers redraw; the save waits for others arriving with it.
    this.entries[k] = entry
    this.unsaved[k] = entry
    this.saving ??= setTimeout(() => this.save(), SAVE_DELAY)
  }

  /** Another tab's saved answers, where they are newer than this tab's. */
  adopt(saved: Record<string, NameEntry>) {
    mergeNewest(this.entries, saved)
  }

  /** One read, prune and write of browser storage for every answer since the last. */
  private save() {
    this.saving = null
    const batch = this.unsaved
    this.unsaved = {}
    // Another tab may have saved a newer answer while this batch waited.
    const saved = pruneNames(mergeNewest(readJSON<Record<string, NameEntry>>(KEY, {}), batch))
    if (!writeJSON(KEY, saved)) {
      // Retry with a smaller cache without touching drafts or preferences.
      writeJSON(KEY, Object.fromEntries(Object.entries(saved).slice(0, 64)))
    }
  }
}

export const names = new Names()

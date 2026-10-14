// Spending eligibility is separate from the host's curated membership list.
import { SvelteMap } from 'svelte/reactivity'
import type { Address } from 'viem'
import { host } from '../../lib/host.svelte'
import { names } from '../../lib/names.svelte'
import { sponsorEligibility, type SponsorEligibility } from './relay'
import { sharedRead } from '../../shared/shared-read'
import { setSponsorName, sponsorName } from './sponsor-name'
import type { ChainInfo } from '../../lib/types'

export type SponsorshipEntry = Omit<SponsorEligibility, 'eligible'> & { eligible: boolean | null; error?: string; at: number }
// Advisory: every sponsored send checks again, and refresh asks at once.
const ELIGIBILITY_TTL = 10 * 60_000
const RETRY_DELAYS = [10_000, 30_000, 60_000, 120_000]
/** How often a hidden tab, which asks nothing, looks whether it is shown again. */
const HIDDEN_CHECK = 60_000
type Entry = SponsorshipEntry & { discovered?: { name: string; expires: number }; retryStage?: number }
// Retry brief pauses promptly, then back off across all composers for this account.
const ttl = (entry: Entry) => entry.retryStage === undefined ? ELIGIBILITY_TTL : RETRY_DELAYS[entry.retryStage]!
const key = (chain: ChainInfo, address: string) => `${chain.id}:${chain.contract.toLowerCase()}:${address.toLowerCase()}:${host.status?.host_policy?.revision ?? "none"}`

class Sponsorship {
  private cache = new SvelteMap<string, Entry>()
  private inflight = new Map<string, Promise<boolean>>()
  private versions = new Map<string, number>()
  /** Each mounted composer's timer, by account, set again whenever any check replaces the shared answer. */
  private watchers = new Map<string, Set<() => void>>()

  policy(chain: ChainInfo) {
    return host.relay?.chains.find((c) => c.id === chain.id && c.contract.toLowerCase() === chain.contract.toLowerCase())
  }

  lookup(chain: ChainInfo, address: Address): Entry | undefined {
    const policy = this.policy(chain)
    if (!policy) return { eligible: false, reason: null, at: Date.now() }
    if (!policy.name_sponsorship) {
      if (!chain.curated) return undefined
      const curated = host.curated(address)
      return { eligible: curated, reason: curated ? 'curated' : null, at: Date.now() }
    }
    void this.require(chain, address).catch(() => {})
    return this.cache.get(key(chain, address))
  }

  /**
   * A mounted composer refreshes when its shared answer expires, only while
   * visible. It follows whichever answer is newest: a refresh or the check
   * after posting that finds a pause is retried on the pause's schedule.
   */
  watch(chain: ChainInfo, address: Address): () => void {
    // List-only eligibility follows reactive host policy and needs no polling.
    if (!this.policy(chain)?.name_sponsorship) return () => {}
    const k = key(chain, address)
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      if (stopped) return
      const entry = this.cache.get(k)
      const remaining = document.visibilityState === 'visible' && entry
        ? ttl(entry) - (Date.now() - entry.at)
        : HIDDEN_CHECK
      timer = setTimeout(() => { void poll() }, Math.max(1000, remaining))
    }
    const poll = async () => {
      if (document.visibilityState === 'visible') await this.require(chain, address).catch(() => {})
      schedule()
    }
    const watchers = this.watchers.get(k) ?? new Set<() => void>()
    watchers.add(schedule)
    this.watchers.set(k, watchers)
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      watchers.delete(schedule)
      if (watchers.size === 0 && this.watchers.get(k) === watchers) this.watchers.delete(k)
    }
  }

  /** Replace the shared answer, and set every mounted composer's next look by it. */
  private store(k: string, entry: Entry) {
    this.cache.set(k, entry)
    for (const schedule of this.watchers.get(k) ?? []) schedule()
  }

  forget(chain: ChainInfo, address: string) {
    const k = key(chain, address)
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1)
    // Keep the displayed answer while fetching again, so the composer keeps
    // its height. Expiry still forces a new check before reusing this cache.
    const cached = this.cache.get(k)
    if (cached) this.store(k, { ...cached, at: -Infinity })
  }

  async require(chain: ChainInfo, address: Address): Promise<boolean> {
    const policy = this.policy(chain)
    if (!policy) return false
    // A list-only chain: host policy owns freshness.
    const namePolicy = policy.name_sponsorship
    if (!namePolicy) return !!chain.curated && host.curated(address)
    const k = key(chain, address)
    const cached = this.cache.get(k)
    if (cached && Date.now() - cached.at < ttl(cached)) {
      if (cached.error) throw new Error(cached.error)
      return cached.eligible === true
    }
    const version = this.versions.get(k) ?? 0
    return sharedRead(this.inflight, `${k}:${version}`, async () => {
      let entry: Entry
      let discoveredHint = cached?.discovered && cached.discovered.expires > Date.now() ? cached.discovered : undefined
      try {
        const byName = namePolicy.ens || namePolicy.basenames
        const valid = (name: string | undefined) => name !== undefined && /^[^.]+\.(?:base\.)?eth$/.test(name)
        let selected = sponsorName(chain.id, address) ?? discoveredHint?.name
        // A profile name already known, usually from showing the reader's own
        // name, goes with the first request: the relayer checks the list first
        // either way, and a name owner needs one request instead of two. A name
        // not yet known is never waited for here; a list member is answered at once.
        const cachedName = !selected && byName ? names.known(address) : undefined
        if (valid(cachedName)) {
          discoveredHint = { name: cachedName!, expires: Date.now() + 300_000 }
          selected = cachedName
        }
        let answer: Awaited<ReturnType<typeof sponsorEligibility>> | undefined
        let lookupError: unknown
        try { answer = await sponsorEligibility(chain.id, address, selected) } catch (e) { lookupError = e }
        if (!answer?.eligible && !selected && byName) {
          const discovered = await names.hint(address)
          if (valid(discovered)) {
            discoveredHint = { name: discovered!, expires: Date.now() + 300_000 }
            answer = await sponsorEligibility(chain.id, address, discovered)
            if (answer.eligible && (this.versions.get(k) ?? 0) === version) setSponsorName(chain.id, address, discovered!)
          }
        }
        if (!answer) throw lookupError
        if (answer.eligible && selected && (this.versions.get(k) ?? 0) === version) setSponsorName(chain.id, address, selected)
        entry = { ...answer, discovered: discoveredHint, at: Date.now() }
      } catch (e) {
        entry = { eligible: null, reason: null, discovered: discoveredHint, error: e instanceof Error ? e.message : 'could not check free posting', at: Date.now() }
      }
      if (entry.error || entry.posting_available === false) {
        entry.retryStage = Math.min((cached?.retryStage ?? -1) + 1, RETRY_DELAYS.length - 1)
      }
      if ((this.versions.get(k) ?? 0) === version) {
        if (this.cache.size >= 128) this.cache.clear()
        this.store(k, entry)
      }
      if (entry.error) throw new Error(entry.error)
      return entry.eligible === true
    })
  }
}
export const sponsorship = new Sponsorship()

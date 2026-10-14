// What the host told us at startup (GET /api/status): chains, caps, policy.
// A rune-backed singleton so any component can read it.
import type { Address } from 'viem'
import { chainLabel } from './chains'
import type { RelayStatus } from './relay-status'
import type { ChainInfo, Status } from './types'

class Host {
  status = $state<Status | null>(null)
  /** The host's relayer, if it runs one. */
  relay = $state<RelayStatus | null>(null)

  private blockedAccounts = $derived(new Set(this.status?.host_policy?.blocked.map(a => a.toLowerCase()) ?? []))
  private curatedAccounts = $derived(new Set(this.status?.host_policy?.curated.map(a => a.toLowerCase()) ?? []))
  // A host answering from before bot labels has neither list.
  private labelledBots = $derived(new Set(this.status?.host_policy?.bots?.map(a => a.toLowerCase()) ?? []))
  private declaredBots = $derived(new Set(this.status?.host_policy?.declared_bots?.map(a => a.toLowerCase()) ?? []))

  blocked(address: string | null | undefined): boolean { return !!address && this.blockedAccounts.has(address.toLowerCase()) }
  curated(address: string): boolean { return !this.blocked(address) && this.curatedAccounts.has(address.toLowerCase()) }
  /** Whether this host shows `address` as a bot: by its own statement first, else by the admin's label. */
  bot(address: string | null | undefined): 'declared' | 'labelled' | null {
    if (!address) return null
    const a = address.toLowerCase()
    return this.declaredBots.has(a) ? 'declared' : this.labelledBots.has(a) ? 'labelled' : null
  }

  /** A chain this host serves, by id. */
  chain(id: number): ChainInfo | undefined {
    return this.status?.chains.find((c) => c.id === id)
  }

  /** The independently indexed market on this chain. */
  keyring(id: number) { return this.status?.keyrings?.find(k => k.chain === id) }

  /** The key market whose keyrings this host indexes on chain `id`. */
  keyringMarket(id: number): Address | null {
    return this.keyring(id)?.market ?? null
  }

  /** A readable network name, without exposing its numeric identifier. */
  label(id: number): string {
    const c = this.chain(id)
    return chainLabel(c ?? { id })
  }
}

export const host = new Host()

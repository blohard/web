// The host's status (GET /api/status): read at startup until it answers, then
// again while a gate it is configured with is still validating there.
import { getStatus } from './store'
import { host } from './host.svelte'
import { mergePolicy } from './host-policy'
import { relayStatus } from './relay-status'
import type { Status } from './types'

type Schedule = (work: () => void, delay: number) => () => void
const later: Schedule = (work, delay) => {
  const timer = setTimeout(work, delay)
  return () => clearTimeout(timer)
}
/** Waits after each failed first read. The page needs the status, so the last wait repeats. */
const FAILED = [2_000, 5_000, 10_000, 20_000, 30_000]
/** Waits while gates validate. The host checks them again each minute. */
const PENDING = [15_000, 30_000, 60_000, 120_000, 300_000]
/** Waits after each failed relayer status read. Free posting waits on it, nothing else does. */
const RELAY_FAILED = [5_000, 15_000, 30_000, 60_000]
const wait = (waits: number[], n: number) => waits[Math.min(n, waits.length - 1)]!

/**
 * A later answer only fills in gates that were still validating, on the chain
 * objects the page already shows: nothing else changes under a page, and no
 * view reloads for it.
 */
function adoptGates(shown: Status, fresh: Status): void {
  if (fresh.host_policy) shown.host_policy = mergePolicy(shown.host_policy, fresh.host_policy)
  else if (BigInt(shown.host_policy?.revision ?? 0) === 0n) shown.host_policy = null
  for (const chain of shown.chains) {
    const update = fresh.chains.find((c) => c.id === chain.id && c.contract.toLowerCase() === chain.contract.toLowerCase())
    if (!update) continue
    chain.blocking = update.blocking ?? null
    chain.closed_gate = update.closed_gate ?? null
    chain.key_gates = update.key_gates ?? null
    chain.gates_pending = update.gates_pending
  }
}

export class HostStatus {
  /** Why the first read failed, while it is being tried again. */
  error = $state<unknown>(null)
  private failures = 0
  private checks = 0
  private cancel: (() => void) | null = null
  private reading = false
  private stopped = false
  private first: ((status: Status) => void) | null = null

  constructor(private read: () => Promise<Status> = getStatus, private schedule: Schedule = later) {}

  /** Start reading. `first` hears the first answer. Returns the way to stop. */
  start(first: (status: Status) => void): () => void {
    this.first = first
    this.stopped = false
    void this.ask()
    return () => {
      this.stopped = true
      this.cancel?.()
      this.cancel = null
    }
  }

  /** Ask now rather than at the next wait: the try again control. */
  retry(): void {
    this.cancel?.()
    this.cancel = null
    void this.ask()
  }

  private async ask(): Promise<void> {
    if (this.reading || this.stopped) return
    this.reading = true
    let next: number | null = null
    try {
      const status = await this.read()
      if (this.stopped) return
      this.error = null
      this.failures = 0
      if (host.status) adoptGates(host.status, status)
      else {
        host.status = status
        this.first?.(status)
      }
      if (host.status.chains.some((c) => c.gates_pending)) next = wait(PENDING, this.checks++)
    } catch (e) {
      if (this.stopped) return
      // A failed recheck keeps what the host already said.
      if (host.status) next = wait(PENDING, this.checks++)
      else {
        this.error = e
        next = wait(FAILED, this.failures++)
      }
    } finally {
      this.reading = false
    }
    if (next !== null) this.cancel = this.schedule(() => {
      this.cancel = null
      void this.ask()
    }, next)
  }
}

export const hostStatus = new HostStatus()

/**
 * The host's relayer status, asked again after a failure: one met while the
 * relayer restarts must not hide free posting and the faucet for the visit.
 * Returns the way to stop.
 */
export function readRelay(read: () => ReturnType<typeof relayStatus> = relayStatus, schedule: Schedule = later): () => void {
  let failures = 0, stopped = false, cancel: (() => void) | null = null
  const ask = () => read().then((relay) => {
    if (!stopped) host.relay = relay
  }, () => {
    if (!stopped) cancel = schedule(ask, wait(RELAY_FAILED, failures++))
  })
  void ask()
  return () => {
    stopped = true
    cancel?.()
  }
}

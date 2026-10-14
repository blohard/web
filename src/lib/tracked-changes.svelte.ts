// Wallet writes to one subject (a post, an account) that must not be sent
// twice. One runs at a time per subject, across every mounted control. A
// write whose receipt never came keeps its hash (tracked-transaction.svelte.ts):
// nothing else is sent for the subject until a check finds its outcome, or the
// reader clears it, knowing it may still land.
import { SvelteSet } from 'svelte/reactivity'
import type { Hex } from 'viem'
import { trackedTransaction } from './tracked-transaction.svelte'
import { Reverted, transaction, type Receipt } from './transactions'
import type { ChainInfo } from './types'

export type Outcome = 'landed' | 'reverted' | 'pending'

/**
 * `name` and `keyOf` name the subject's storage key; `apply` makes a landed
 * receipt's effect show, as a completed write would have.
 */
export function trackedChanges<S>(name: string, keyOf: (chain: ChainInfo, subject: S) => string,
  apply: (chain: ChainInfo, subject: S, receipt: Receipt) => void) {
  const pending = new SvelteSet<string>()
  const tracked = (chain: ChainInfo, subject: S) => trackedTransaction(`blohard.${name}/${keyOf(chain, subject)}`)
  return {
    busy(chain: ChainInfo, subject: S) { return pending.has(keyOf(chain, subject)) },
    /** The hash of an earlier write that may still land, or null. */
    unsettled(chain: ChainInfo, subject: S): Hex | null { return tracked(chain, subject).hash },
    /** Whether that hash reached browser storage, so a reload still knows it. */
    saved(chain: ChainInfo, subject: S): boolean { return tracked(chain, subject).saved },
    /** `work` reports each hash the wallet returns through `sent`, before waiting for its receipt. */
    async run<T>(chain: ChainInfo, subject: S, work: (sent: (hash: Hex) => void) => Promise<T>, busyMessage: string, unsettledMessage: string): Promise<T> {
      const identity = keyOf(chain, subject), change = tracked(chain, subject)
      if (pending.has(identity)) throw new Error(busyMessage)
      change.sync()
      if (change.hash) throw new Error(unsettledMessage)
      pending.add(identity)
      let sent: Hex | null = null
      try {
        const result = await work((hash) => { sent = hash; change.save(hash) })
        if (sent) change.finish(sent)
        return result
      } catch (e) {
        // A revert settles it; any other failure keeps the hash to check.
        if (sent && e instanceof Reverted) change.finish(sent)
        throw e
      } finally { pending.delete(identity) }
    },
    /** Ask once for an unsettled write's receipt. */
    async check(chain: ChainInfo, subject: S): Promise<Outcome> {
      const identity = keyOf(chain, subject), change = tracked(chain, subject)
      const hash = change.hash
      if (!hash || pending.has(identity)) return 'pending'
      pending.add(identity)
      try {
        const receipt = await transaction(chain, hash)
        if (receipt.status === 'pending') return 'pending'
        change.finish(hash)
        if (receipt.status === 'reverted') return 'reverted'
        apply(chain, subject, receipt)
        return 'landed'
      } finally { pending.delete(identity) }
    },
    /** Forget an unsettled write. It may still land, with its effect. */
    clear(chain: ChainInfo, subject: S) { tracked(chain, subject).clear() },
  }
}

// One transaction sent from the wallet, tracked by a storage key: its hash is
// saved as soon as the wallet returns it, so a page or tab that comes back
// checks it instead of sending again, until a receipt, or an explicit clear,
// settles it. Key trades, and the moderation and list writes, share this.
import type { Hex } from 'viem'
import { readJSON, removeJSON, writeJSON } from './storage'

const hashOf = (value: unknown): Hex | null =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? value as Hex : null

/**
 * The transaction and its wallet prompt outlive any page that displays them.
 * `T` is what a confirmation reports; `settled` runs first, before its listeners.
 */
class TrackedTransaction<T = void> {
  hash = $state<Hex | null>(null)
  saved = $state(true)
  private flight = $state<symbol | null>(null)
  private confirmations = new Set<(value: T, hash: Hex) => void>()
  private reverts = new Set<(error: unknown) => void>()
  get busy() { return this.flight !== null }
  constructor(readonly key: string, private settled: () => void = () => {}) {
    this.hash = hashOf(readJSON<unknown>(key, null))
  }
  acquire(): (() => void) | null {
    if (this.busy) return null
    const flight = Symbol()
    this.flight = flight
    return () => { if (this.flight === flight) this.flight = null }
  }
  // A clear in another tab is not proof that our own transaction has settled.
  adopt(value: unknown) {
    const hash = hashOf(value)
    if (hash && !this.hash) { this.hash = hash; this.saved = true }
  }
  sync() { if (this.saved) this.adopt(readJSON<unknown>(this.key, null)) }
  save(hash: Hex | null) {
    this.hash = hash
    this.saved = hash === null ? removeJSON(this.key) : writeJSON(this.key, hash)
  }
  private forget(requireSave: boolean) {
    const other = hashOf(readJSON<unknown>(this.key, null))
    // Completing this tab's transaction must not erase a different tab's hash.
    if (other && other !== this.hash) { this.hash = other; this.saved = true; return }
    const saved = removeJSON(this.key)
    if (requireSave && !saved) throw new Error('could not clear the saved transaction. browser storage is unavailable')
    this.hash = null
    this.saved = saved
  }
  finish(hash: Hex) {
    if (this.hash === hash) this.forget(false)
  }
  onConfirmed(listener: (value: T, hash: Hex) => void): () => void {
    this.confirmations.add(listener)
    return () => { this.confirmations.delete(listener) }
  }
  confirm(hash: Hex, value: T) {
    this.finish(hash)
    this.settled()
    for (const listener of this.confirmations) listener(value, hash)
  }
  onReverted(listener: (error: unknown) => void): () => void {
    this.reverts.add(listener)
    return () => { this.reverts.delete(listener) }
  }
  revert(hash: Hex, error: unknown) {
    this.finish(hash)
    for (const listener of this.reverts) listener(error)
  }
  clear() { this.forget(true) }
}
const transactions = new Map<string, TrackedTransaction<unknown>>()
let listening = false
/** Another tab's saves, heard from the first tracker on, whatever imported this module first. */
function listen() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('storage', event => {
    if (!event.key || !event.newValue) return
    try {
      if (event.storageArea === localStorage) transactions.get(event.key)?.adopt(JSON.parse(event.newValue))
    } catch { /* Browser storage may be unavailable or contain malformed data. */ }
  })
}
/** The one tracker for `key` in this tab; `settled` is fixed by its first caller. */
export function trackedTransaction<T = void>(key: string, settled?: () => void): TrackedTransaction<T> {
  listen()
  let transaction = transactions.get(key) as TrackedTransaction<T> | undefined
  if (!transaction) {
    transaction = new TrackedTransaction<T>(key, settled)
    transactions.set(key, transaction as TrackedTransaction<unknown>)
  }
  return transaction
}

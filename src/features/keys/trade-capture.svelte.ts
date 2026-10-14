// The trade a key market page sent, shown in place of the live quote while it
// is being signed and while its own transaction is pending, so the amount on
// screen is the amount authorised. A transaction started in another tab, or
// any later one, is not this trade: it falls back to the live quote.
import type { Hex } from 'viem'

export class TradeCapture<T> {
  #trade = $state.raw<T | null>(null)
  #hash = $state<Hex | null>(null)
  #sending = $state(false)

  /** This page starts sending `trade`; a claim captures none. */
  begin(trade: T | null) {
    this.#trade = trade
    this.#hash = null
    this.#sending = true
  }
  /** The wallet returned the transaction's hash. */
  sent(hash: Hex) { this.#hash = hash }
  /** This page's send returned, settled or not. */
  end() { this.#sending = false }

  /** Whether a confirmation belongs to this page's own send, claims included. */
  owns(hash: Hex): boolean { return this.#hash === hash }

  /** The captured trade while this page sends it, or while its own transaction is the pending one. */
  shown(pending: Hex | null): T | null {
    const trade = this.#trade
    if (trade === null) return null
    return this.#sending || (this.#hash !== null && this.#hash === pending) ? trade : null
  }
}

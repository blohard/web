// A control's one action at a time, for whichever chain, account or post the
// control currently shows. The pending choice and the outcome note belong to
// the identity the action started for: switch accounts, chains or posts while
// it runs, and neither its choice nor its late answer shows on the other one.
import { explain } from './errors'

export type ActionNote = { identity: string; ok: boolean; text: string }

export class ScopedAction<P = undefined> {
  #identity: () => string
  #busy = $state(false)
  #pending = $state<{ identity: string; value: P } | null>(null)
  #result = $state<ActionNote | null>(null)

  constructor(identity: () => string) { this.#identity = identity }

  /** An action is running, for any identity: one at a time per control. */
  get busy() { return this.#busy }
  /** The action is running for the identity now shown. */
  get running() { return this.#busy && this.#pending?.identity === this.#identity() }
  /** What the running action chose, when it was started for the identity now shown. */
  get pending(): P | undefined {
    const p = this.#pending
    return p && p.identity === this.#identity() ? p.value : undefined
  }
  /** The latest progress or outcome, when it belongs to the identity now shown. */
  get note(): ActionNote | null {
    const r = this.#result
    return r?.identity === this.#identity() ? r : null
  }

  /**
   * Run `task` for the identity now shown. Progress it reports, then `done` or
   * the explained failure, become that identity's note; `start` is shown
   * until then. A null `done` leaves no note on success, for a change the
   * control itself already shows. The pending choice and the busy flag clear together.
   */
  async run(choice: P, task: (progress: (text: string) => void) => unknown, done: string | null, start: string | null = null): Promise<void> {
    const identity = this.#identity()
    this.#pending = { identity, value: choice }
    this.#busy = true
    this.#result = start === null ? null : { identity, ok: true, text: start }
    try {
      await task(text => { this.#result = { identity, ok: true, text } })
      this.#result = done === null ? null : { identity, ok: true, text: done }
    } catch (error) {
      this.#result = { identity, ok: false, text: explain(error) }
    } finally {
      this.#pending = null
      this.#busy = false
    }
  }
}

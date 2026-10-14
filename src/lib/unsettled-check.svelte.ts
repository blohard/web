// A recovery notice asks once, quietly, whether its outstanding change landed.
// Once per hash: the check makes the notice busy while it asks, and a pending
// or failed answer must not start another. Further checks are the button's.
import { untrack } from 'svelte'
import type { Outcome } from './tracked-changes.svelte'

/** Call during component init. Waits for a send or check that is running to finish first. */
export function checkOnce(input: () => { hash: string | null; busy: boolean }, check: () => Promise<Outcome>, onlanded: () => void) {
  let checked: string | null = null
  $effect(() => {
    const { hash, busy } = input()
    if (!hash || busy || checked === hash) return
    checked = hash
    untrack(() => { void check().then((outcome) => { if (outcome === 'landed') onlanded() }, () => {}) })
  })
}

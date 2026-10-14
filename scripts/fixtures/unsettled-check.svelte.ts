import { flushSync } from 'svelte'
import { checkOnce } from '../../src/lib/unsettled-check.svelte'
import type { Outcome } from '../../src/lib/tracked-changes.svelte'

export { flushSync }
/** The notice's automatic check, under a hash and busy flag the test sets, as the component passes them. */
export function notice(check: () => Promise<Outcome>) {
  let input = $state<{ hash: string | null; busy: boolean }>({ hash: null, busy: false })
  let landed = 0
  const stop = $effect.root(() => { checkOnce(() => input, check, () => { landed++ }) })
  return {
    set(next: Partial<{ hash: string | null; busy: boolean }>) { input = { ...input, ...next } },
    get landed() { return landed },
    stop,
  }
}

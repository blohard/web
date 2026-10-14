import { flushSync } from 'svelte'
import { cardBody } from '../../card-body.svelte'

export { flushSync }
/** A card's body under a verdict the test sets: 'checking', 'shown' or 'folded'. A body of 'missing' or 'error' may be asked for again. */
export function card(start: (attempt: number) => Promise<string>, verdict0: 'checking' | 'shown' = 'checking') {
  let verdict = $state<'checking' | 'shown' | 'folded'>(verdict0)
  let revealed = $state(false)
  const timers: { run: () => void; ms: number }[] = []
  let body!: ReturnType<typeof cardBody<string>>
  const stop = $effect.root(() => {
    body = cardBody(start, () => ({ identity: 'post', hidden: verdict === 'folded' && !revealed, checking: verdict === 'checking' }), {
      retryable: (v) => v === 'missing' || v === 'error',
      reask: (v) => v === 'missing',
      later: (run, ms) => {
        const timer = { run, ms }
        timers.push(timer)
        return () => { timers.splice(timers.indexOf(timer), 1) }
      },
    })
  })
  return {
    get value() { return body.value },
    get failure() { return body.failure },
    get retryable() { return body.retryable },
    retry() { body.retry() },
    timers,
    decide(next: 'shown' | 'folded') { verdict = next },
    reveal() { revealed = true },
    stop,
  }
}

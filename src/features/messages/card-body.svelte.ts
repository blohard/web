// A card's record and body, read while its reply's gate verdict is still out,
// so a reply that may show does so a round trip sooner. Nothing is exposed
// until the verdict: while it is out the card shows neither the body nor a
// failure. A hidden card (deleted, muted or folded) starts no read, and one
// hidden while reading ignores the answer; revealed later, it shows the
// answer, a failure included. A failed read, or a body the host does not
// have, can be asked for again; a missing body is asked for once more on its
// own, since a new post's body reaches the host's store a moment after it.
import { Resource } from '../../shared/resource.svelte'

type Later = (work: () => void, ms: number) => () => void
const after: Later = (work, ms) => {
  const timer = setTimeout(work, ms)
  return () => clearTimeout(timer)
}
/** Past the host's promotion of a newly accepted post's held body, every 3 seconds. */
const REASK_MS = 4_000

type Options<T> = {
  /** An answer worth asking for again: the body was missing or could not be fetched. */
  retryable?: (value: T) => boolean
  /** An answer asked for once more on its own. */
  reask?: (value: T) => boolean
  later?: Later
}

/** `read` returns the card's request for an attempt, the same promise until its inputs or the attempt change. */
export function cardBody<T>(read: (attempt: number) => Promise<T>, state: () => { identity: string; hidden: boolean; checking: boolean }, options: Options<T> = {}) {
  const { retryable = () => false, reask = () => false, later = after } = options
  const content = new Resource<T>()
  let attempt = $state(0)
  const request = $derived(read(attempt))
  // The verdict's arrival alone starts no new watch: only hiding, revealing, another post or a retry does.
  const hidden = $derived(state().hidden)
  const identity = $derived(state().identity)
  $effect(() => {
    if (!hidden) return content.watch(request, identity)
  })
  let reasked = false
  $effect(() => {
    const value = content.value(identity)
    if (reasked || hidden || value === null || !reask(value)) return
    reasked = true
    return later(() => { attempt++ }, REASK_MS)
  })
  const shown = () => { const s = state(); return s.hidden || s.checking ? null : s.identity }
  return {
    get value(): T | null { const key = shown(); return key === null ? null : content.value(key) },
    get failure(): { cause: unknown } | null { const key = shown(); return key === null ? null : content.failure(key) },
    /** Shown, and either failed or not worth keeping: the card offers to try again. */
    get retryable(): boolean {
      const key = shown()
      if (key === null || content.pending) return false
      const value = content.value(key)
      return content.failure(key) !== null || (value !== null && retryable(value))
    },
    retry(): void { attempt++ },
  }
}

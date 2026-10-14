/**
 * Wait 300 ms for one operation; pass null while idle. Keep the same identity
 * across loading stages, so preparing cards does not restart a page's delay.
 */
export function loadingDelay(identity: () => unknown | null): () => boolean {
  // A fresh token also distinguishes A -> B -> A, and repeated paging reads.
  const key = $derived(identity())
  const operation = $derived(key === null ? null : { key })
  let elapsed = $state.raw<typeof operation>(null)
  $effect(() => {
    const current = operation
    if (!current) return
    const timer = setTimeout(() => { elapsed = current }, 300)
    return () => clearTimeout(timer)
  })
  return () => operation !== null && elapsed === operation
}

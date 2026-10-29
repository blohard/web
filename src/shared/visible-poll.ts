// Background polling for what a visible page shows: the refresh cue's quiet
// poll, keyring pages and key notifications share it.

/** A read that fails right after the page returns is tried once more this soon, not at the next interval. */
const RETURN_RETRY_MS = 5_000

/** Read immediately when requested, then poll visible pages and on return; never overlap or update after cleanup. */
export function pollVisible<T>(read: () => Promise<T>, update: (value: T) => void,
  failed: (error: unknown) => void, interval: number, immediate = true): () => void {
  let stopped = false, running = false, away = false, recheck = false
  let retry: ReturnType<typeof setTimeout> | null = null
  async function poll(initial = false, returning = false) {
    if (stopped || running || (!initial && document.visibilityState !== 'visible')) return
    if (retry !== null) { clearTimeout(retry); retry = null }
    running = true
    try {
      const value = await read()
      if (!stopped) update(value)
    } catch (error) {
      if (stopped) return
      failed(error)
      // Give a failed return check one retry without changing interval polling.
      if (returning) retry = setTimeout(() => { retry = null; void poll() }, RETURN_RETRY_MS)
    } finally {
      running = false
      if (recheck) { recheck = false; void poll(false, true) }
    }
  }
  // A newly opened tab may still be hidden when its view mounts. Its first
  // display must not wait for the background polling interval.
  if (immediate) void poll(true)
  const left = () => { away = true }
  const returned = () => {
    if (document.visibilityState !== 'visible') { left(); return }
    // An outstanding read may have captured its answer before we left.
    // Remember this return, but coalesce its focus and visibility events.
    if (away && running) recheck = true
    away = false
    void poll(false, true)
  }
  // Reconnection needs a fresh answer even when the page stayed visible.
  const connected = () => { away = true; returned() }
  document.addEventListener('visibilitychange', returned)
  window.addEventListener('focus', returned)
  // Connectivity back after a sleep counts as a return: the read that failed is tried now.
  window.addEventListener('online', connected)
  window.addEventListener('blur', left)
  const timer = setInterval(poll, interval)
  return () => {
    stopped = true
    clearInterval(timer)
    if (retry !== null) { clearTimeout(retry); retry = null }
    document.removeEventListener('visibilitychange', returned)
    window.removeEventListener('focus', returned)
    window.removeEventListener('online', connected)
    window.removeEventListener('blur', left)
  }
}

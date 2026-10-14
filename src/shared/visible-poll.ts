// Background polling for what a visible page shows: the refresh cue's quiet
// poll, keyring pages and key notifications share it.

/** Read immediately when requested, then poll visible pages and on return; never overlap or update after cleanup. */
export function pollVisible<T>(read: () => Promise<T>, update: (value: T) => void,
  failed: (error: unknown) => void, interval: number, immediate = true): () => void {
  let stopped = false, running = false, away = false, recheck = false
  async function poll(initial = false) {
    if (stopped || running || (!initial && document.visibilityState !== 'visible')) return
    running = true
    try {
      const value = await read()
      if (!stopped) update(value)
    } catch (error) { if (!stopped) failed(error) }
    finally {
      running = false
      if (recheck) { recheck = false; void poll() }
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
    void poll()
  }
  document.addEventListener('visibilitychange', returned)
  window.addEventListener('focus', returned)
  window.addEventListener('blur', left)
  const timer = setInterval(poll, interval)
  return () => {
    stopped = true
    clearInterval(timer)
    document.removeEventListener('visibilitychange', returned)
    window.removeEventListener('focus', returned)
    window.removeEventListener('blur', left)
  }
}

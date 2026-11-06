// Background polling for what a visible page shows: the refresh cue's quiet
// poll, keyring pages and key notifications share it.
import { notePoll } from './poll-log'

/** A read that fails right after the page returns is tried once more this soon, not at the next interval. */
const RETURN_RETRY_MS = 5_000

/**
 * What started a check: the view opening, the interval, the page coming back,
 * the retry after a failed return check, or the check owed to a return that
 * arrived while another check was running.
 */
type Trigger = 'opened' | 'interval' | 'return' | 'retry' | 'recheck'

/**
 * Read immediately when requested, then poll visible pages and on return; never overlap or update after cleanup.
 * A `label` puts this poller's checks in the opt-in poll log (shared/poll-log.ts).
 */
export function pollVisible<T>(read: () => Promise<T>, update: (value: T) => void,
  failed: (error: unknown) => void, interval: number, immediate = true, label?: string): () => void {
  let stopped = false, running = false, away = false, recheck = false
  let retry: ReturnType<typeof setTimeout> | null = null
  async function poll(trigger: Trigger, cause?: string) {
    if (stopped || running || (trigger !== 'opened' && document.visibilityState !== 'visible')) return
    if (retry !== null) { clearTimeout(retry); retry = null }
    running = true
    if (label) notePoll('check started', { poller: label, trigger, cause })
    try {
      const value = await read()
      if (!stopped) update(value)
    } catch (error) {
      if (stopped) return
      if (label) notePoll('check failed', { poller: label, error: error instanceof Error ? error.message : String(error) })
      failed(error)
      // Give a failed return check one retry without changing interval polling.
      if (trigger === 'return' || trigger === 'recheck') retry = setTimeout(() => { retry = null; void poll('retry') }, RETURN_RETRY_MS)
    } finally {
      running = false
      if (recheck) { recheck = false; void poll('recheck') }
    }
  }
  // A newly opened tab may still be hidden when its view mounts. Its first
  // display must not wait for the background polling interval.
  if (immediate) void poll('opened')
  // Every leave and return is logged before any guard, so the log tells an
  // event that never arrived from one that arrived and started no check.
  const left = (event?: Event) => {
    if (label) notePoll('page left', { poller: label, cause: event?.type })
    away = true
  }
  const returned = (event?: Event) => {
    if (document.visibilityState !== 'visible') { left(event); return }
    if (label) notePoll('page returned', { poller: label, cause: event?.type, running, away, recheck })
    // An outstanding read may have captured its answer before we left.
    // Remember this return, but coalesce its focus and visibility events.
    if (away && running) {
      recheck = true
      if (label) notePoll('return during a check, checking again after it', { poller: label, cause: event?.type })
    }
    away = false
    void poll('return', event?.type)
  }
  // Reconnection needs a fresh answer even when the page stayed visible.
  const connected = (event: Event) => { away = true; returned(event) }
  document.addEventListener('visibilitychange', returned)
  window.addEventListener('focus', returned)
  // Connectivity back after a sleep counts as a return: the read that failed is tried now.
  window.addEventListener('online', connected)
  window.addEventListener('blur', left)
  // The callback returns the check, so a test driving the interval can wait for it.
  const timer = setInterval(() => poll('interval'), interval)
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

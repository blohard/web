import { pollVisible } from './visible-poll'
import { notePoll } from './poll-log'

// What a quiet poll found: how many posts a refresh would add to the view on
// screen. The mounted stream or thread owns the count, the refresh button
// shows it, and a refresh clears it. Nothing on screen moves until the reader
// presses refresh. Changes to the count go to the opt-in poll log.
class RefreshCue {
  private value = $state(0)
  /** The same count outside reactivity: views take and set it inside effects, which must not subscribe to it. */
  private logged = 0
  private countedBy: object | null = null
  get count() { return this.value }
  clear() { this.write(0, 'refresh') }

  private reading = $state.raw<object | null>(null)
  get busy() { return this.reading !== null }

  /** Keep the control busy for this view's refresh. Return the cleanup when the view leaves or replaces its read. */
  during(request: Promise<unknown>): () => void {
    const reading = {}
    this.reading = reading
    const stop = () => { if (this.reading === reading) this.reading = null }
    void request.then(stop, stop)
    return stop
  }

  private write(count: number, by: string) {
    if (count !== this.logged) notePoll('refresh count changed', { from: this.logged, to: count, by })
    this.logged = count
    this.value = count
  }

  /** The mounted view owns its count; an older view cannot update or clear it. */
  cueCount(initial = 0) {
    const owner = {}
    this.countedBy = owner
    this.write(initial, 'a new view')
    return {
      set: (count: number) => {
        if (this.countedBy === owner) this.write(count, 'its view')
        else if (count) notePoll('refresh count from a departed view ignored', { count })
      },
      stop: () => { if (this.countedBy === owner) { this.countedBy = null; this.write(0, 'its view leaving') } },
    }
  }
  // Key activity or membership changes can require refresh without adding posts. The page on
  // screen lends a getter, so the cue is read live and never copied into state.
  private changedBy = $state<(() => boolean) | null>(null)
  get changed() { return this.changedBy?.() ?? false }
  get highlighted() { return this.count > 0 || this.changed }

  /** Call from an effect and return the cleanup. Reads nothing, so it runs once per view. */
  cueChanges(source: () => boolean): () => void {
    this.changedBy = source
    return () => { if (this.changedBy === source) this.changedBy = null }
  }

  /**
   * The quiet poll: every half minute while the tab is visible, `peek` says
   * how many rows a refresh of the view on screen would add, and the number
   * cues the refresh button; null keeps the count it has. Call from an effect
   * after reading what the view depends on and return the cleanup, which also
   * clears the count: a new view or a refresh starts over. `label` names the
   * view in the opt-in poll log.
   */
  poll(peek: () => Promise<number | null>, label?: string): () => void {
    const cue = this.cueCount()
    const stop = pollVisible(peek, (n) => { if (n !== null) cue.set(n) },
      () => { /* A later poll retries; keep the last cue. */ }, 30_000, false, label)
    return () => {
      stop()
      cue.stop()
    }
  }
}

export const refreshCue = new RefreshCue()

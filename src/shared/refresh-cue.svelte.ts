import { pollVisible } from './visible-poll'

// What a quiet poll found: how many posts a refresh would add to the view on
// screen. The mounted stream or thread owns the count, the refresh button
// shows it, and a refresh clears it. Nothing on screen moves until the reader
// presses refresh.
class RefreshCue {
  private value = $state(0)
  private countedBy: object | null = null
  get count() { return this.value }
  clear() { this.value = 0 }

  /** The mounted view owns its count; an older view cannot update or clear it. */
  cueCount(initial = 0) {
    const owner = {}
    this.countedBy = owner
    this.value = initial
    return {
      set: (count: number) => { if (this.countedBy === owner) this.value = count },
      stop: () => { if (this.countedBy === owner) { this.countedBy = null; this.clear() } },
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
   * clears the count: a new view or a refresh starts over.
   */
  poll(peek: () => Promise<number | null>): () => void {
    const cue = this.cueCount()
    const stop = pollVisible(peek, (n) => { if (n !== null) cue.set(n) },
      () => { /* A later poll retries; keep the last cue. */ }, 30_000, false)
    return () => {
      stop()
      cue.stop()
    }
  }
}

export const refreshCue = new RefreshCue()

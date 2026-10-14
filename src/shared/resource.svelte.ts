import { tick } from 'svelte'

/** A view keeps its last successful result during refresh. Only the latest request may replace it. */
export class Resource<T> {
  result = $state.raw<{ key: unknown; value: T } | null>(null)
  error = $state.raw<{ key: unknown; cause: unknown } | null>(null)
  pending = $state(false)
  private generation = 0
  /** The key of the latest request, the one the view shows. */
  private key: unknown = null

  /** The result for `key`, or null while another key's result stands or none has arrived. */
  value(key: unknown = null): T | null {
    const r = this.result
    return r !== null && r.key === key ? r.value : null
  }

  /** The failure for `key`, when its last request failed. */
  failure(key: unknown = null): { key: unknown; cause: unknown } | null {
    return this.error?.key === key ? this.error : null
  }

  /**
   * A result known for certain, from an action that just happened: it
   * stands, a request still out is ignored when it lands, and a failure on
   * show is cleared. A result for a key the view has moved on from (an
   * account switched while the chain confirmed) is dropped, and the newer
   * key's request goes on.
   */
  settle(key: unknown, value: T) {
    if (key !== this.key) return
    this.generation++
    this.result = { key, value }
    this.error = null
    this.pending = false
  }

  /** Call from an effect and return its cleanup. Keys separate different accounts, chains or messages. */
  watch(request: Promise<T>, key: unknown = null, onshown?: (value: T) => void): () => void {
    const generation = ++this.generation
    this.key = key
    this.pending = true
    this.error = null
    void request.then(
      (value) => {
        if (generation !== this.generation) return
        const focused = typeof document === 'undefined' ? null : document.activeElement
        this.result = { key, value }
        this.pending = false
        // Moving a keyed row can blur its focused descendant in browsers.
        // Restore only that surviving node, never steal a new focus or scroll.
        if (onshown || (typeof HTMLElement !== 'undefined' && focused instanceof HTMLElement)) {
          void tick().then(() => {
            if (generation !== this.generation) return
            if (typeof HTMLElement !== 'undefined' && focused instanceof HTMLElement
              && focused.isConnected && document.activeElement === document.body) {
              focused.focus({ preventScroll: true })
            }
            onshown?.(value)
          })
        }
      },
      (cause: unknown) => {
        if (generation !== this.generation) return
        this.error = { key, cause }
        this.pending = false
      },
    )
    return () => { if (generation === this.generation) this.generation++ }
  }
}

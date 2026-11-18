// All rows mount and read in parallel. Only new rows wait for their place in
// reading order. A later page or a slow reply never hides a row already shown.
import { getContext, hasContext, onDestroy, setContext, tick } from 'svelte'
import { SvelteSet } from 'svelte/reactivity'
import { loadingDelay } from './loading-delay.svelte'

const LIST = Symbol('post list'), GROUP = Symbol('row order'), DISPLAYS = Symbol('display group')
type Row = { group: object; ready: () => boolean; show: () => void }

export class PostList {
  first = $state.raw<HTMLElement | null>(null)
  pageRowsPending = $state(false)
  private rows = new Map<HTMLElement, Row>()
  private queued = false

  register(node: HTMLElement, ready: () => boolean, show: () => void, group: object = this) {
    this.rows.set(node, { ready, show, group })
    this.changed()
    return { destroy: () => { if (this.rows.delete(node)) this.changed() } }
  }

  changed() {
    if (this.queued) return
    this.queued = true
    // A body arriving can mount a picture or quote. Let its read register
    // before deciding that this row is ready.
    void tick().then(() => {
      this.queued = false
      const rows = [...this.rows].sort(([a], [b]) => a.compareDocumentPosition(b) & 2 ? 1 : -1)
      let first: HTMLElement | null = null
      const waiting = new Set<object>()
      for (const [node, row] of rows) {
        if (waiting.has(row.group)) continue
        if (!row.ready()) {
          first ??= node
          waiting.add(row.group)
          continue
        }
        this.rows.delete(node)
        row.show()
      }
      this.first = first
      this.pageRowsPending = waiting.has(this)
    })
  }
}

type ListContext = { list: PostList; label: string; waited: () => boolean }

/** Nested branches share the page's indicator. A standalone reply list owns its own. */
export function postList(label = 'loading replies…', waited?: () => boolean): ListContext {
  const parent = getContext<ListContext | undefined>(LIST)
  if (parent) return parent
  const list = new PostList()
  return setContext(LIST, { list, label, waited: waited ?? loadingDelay(() => list.first ? true : null) })
}

/** An explicitly opened branch can be read while an unrelated list is still loading. */
export const startRowGroup = () => setContext(GROUP, {})
export const rowGroup = () => getContext<object | undefined>(GROUP)
export const inPostList = () => hasContext(LIST)

/** Nested groups also report to the enclosing conversation during its initial reveal. */
export function firstDisplayGroup() {
  const reads = new SvelteSet<() => boolean>()
  const ready = () => {
    for (const read of reads) if (!read()) return false
    return true
  }
  firstDisplay(ready)
  setContext(DISPLAYS, reads)
  return ready
}

/** Observe the owning component's existing reads. Failures and folded posts can settle too. */
export function firstDisplay(ready: () => boolean) {
  const group = getContext<SvelteSet<() => boolean> | undefined>(DISPLAYS)
  if (group) { group.add(ready); onDestroy(() => group.delete(ready)) }
}

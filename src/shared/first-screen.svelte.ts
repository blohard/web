// A fresh stream mounts normally, but reveals only after its first screen
// settles. Cards keep their reads; this observer owns only the initial reveal.
import { SvelteSet } from 'svelte/reactivity'
import { getContext, onDestroy, setContext, tick, untrack } from 'svelte'

/** Maximum wait for initial card reads after a stream or reply page arrives. */
export const FIRST_DISPLAY_WAIT_MS = 2000

const SCREEN = Symbol('first screen'), ROW = Symbol('first screen row'), DISPLAYS = Symbol('display group')
type Row = { screen: FirstScreen; reads: Set<() => boolean> }

/** Rows are in reading order. Only a settled prefix can cover the first screen. */
export function screenReady(rows: { settled: boolean; bottom: number }[], height: number): boolean {
  for (const row of rows) {
    if (!row.settled) return false
    if (row.bottom >= height * 1.5) return true
  }
  return true
}

export class FirstScreen {
  waiting = $state(true)
  private rows = new Map<HTMLElement, () => boolean>()
  private mounted = false
  private queued = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private detach: (() => void) | undefined

  /** Paging rows keep their wrappers collapsed until the new screen is ready. */
  constructor(private collapsed = false) {}

  /** The budget begins when the feed page arrives, not when its request starts. */
  start() {
    if (this.waiting && this.timer === undefined) this.timer = setTimeout(() => this.finish(), FIRST_DISPLAY_WAIT_MS)
  }

  finish() {
    this.waiting = false
    clearTimeout(this.timer)
    this.detach?.()
    this.detach = undefined
    this.rows.clear()
  }

  mount() {
    this.mounted = true
    if (!this.waiting) return
    const changed = () => this.changed()
    window.addEventListener('resize', changed)
    window.addEventListener('scroll', changed, { passive: true })
    this.detach = () => {
      window.removeEventListener('resize', changed)
      window.removeEventListener('scroll', changed)
    }
    this.changed()
  }

  row(node: HTMLElement, ready: () => boolean) {
    if (!this.waiting) return
    this.rows.set(node, ready)
    this.changed()
    return { destroy: () => { this.rows.delete(node); this.changed() } }
  }

  changed() {
    if (!this.waiting || this.queued) return
    this.queued = true
    // A parent arriving can replace the fallback and mount more cards. Their
    // reads must be registered, and their layout updated, before deciding.
    void tick().then(() => {
      this.queued = false
      if (!this.waiting || !this.mounted) return
      const rows = [...this.rows].sort(([a], [b]) => a.compareDocumentPosition(b) & 2 ? 1 : -1)
      let bottom = rows[0]?.[0].getBoundingClientRect().top ?? 0
      const measured = rows.map(([node, ready]) => {
        const rect = node.getBoundingClientRect()
        // The cards retain their normal dimensions inside zero-height wrappers.
        // Their eventual positions are the sum of those heights, in DOM order.
        bottom = this.collapsed ? bottom + rect.height : rect.bottom
        return { settled: ready(), bottom }
      })
      if (screenReady(measured, window.innerHeight)) this.finish()
    })
  }
}

export function provideFirstScreen(screen: () => FirstScreen | null) { setContext(SCREEN, screen) }

/** A row supplies the readiness scope for its context and all of its cards. */
export function firstScreenRow() {
  const screen = untrack(() => getContext<(() => FirstScreen | null) | undefined>(SCREEN)?.())
  const row: Row | null = screen?.waiting ? { screen, reads: new Set() } : null
  setContext(ROW, row)
  return (node: HTMLElement) => row?.screen.row(node, () => [...row.reads].every(ready => ready()))
}

/** A reply list reveals its cards together after their first display reads settle. */
export function firstDisplayGroup() {
  const reads = new SvelteSet<() => boolean>()
  const ready = () => [...reads].every(read => read())
  firstDisplay(ready)
  setContext(DISPLAYS, reads)
  return ready
}

/** Observe existing display state; never start or retain a content request. */
export function firstDisplay(ready: () => boolean) {
  const group = getContext<SvelteSet<() => boolean> | undefined>(DISPLAYS)
  if (group) { group.add(ready); onDestroy(() => group.delete(ready)) }
  const row = getContext<Row | null | undefined>(ROW)
  if (!row) return
  row.reads.add(ready)
  onDestroy(() => { row.reads.delete(ready); row.screen.changed() })
  $effect(() => {
    if (!row.screen.waiting) return
    ready()
    untrack(() => row.screen.changed())
  })
}

/** The action follows a new stream identity, but never hides a revealed one. */
export function revealStream(_node: HTMLElement, initial: FirstScreen | null) {
  let screen = initial
  screen?.mount()
  return {
    update(next: FirstScreen | null) {
      if (next === screen) return
      screen?.finish()
      screen = next
      screen?.mount()
    },
    destroy() { screen?.finish() },
  }
}

let anchorFrame = 0

/**
 * Forget the browser's bottom anchor when a reply control changes the page.
 * Restore normal anchoring after that paint, so later content above the reader
 * can still keep their place. Repeated presses share the pending reset.
 */
export function resetScrollAnchor(): void {
  const root = document.documentElement
  cancelAnimationFrame(anchorFrame)
  root.style.overflowAnchor = 'none'
  anchorFrame = requestAnimationFrame(() => {
    anchorFrame = requestAnimationFrame(() => {
      root.style.removeProperty('overflow-anchor')
      anchorFrame = 0
    })
  })
}

/**
 * The bottom and height of what the reader can see, in page viewport terms. An
 * on-screen keyboard shrinks the visual viewport, often without resizing the
 * window, so window.innerHeight alone would place a box under the keyboard.
 */
function visibleBottom(): number {
  const view = window.visualViewport
  return view ? view.offsetTop + view.height : window.innerHeight
}
function visibleHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight
}

/** Follow a position while content settles, until user input or ten seconds after the first move. */
export function followPosition(node: HTMLElement, position: () => number, onstop = () => {}) {
  let active = true
  let frame = 0
  let timer: number | undefined
  const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  const stop = () => {
    if (!active) return
    active = false
    cancelAnimationFrame(frame)
    if (timer !== undefined) window.clearTimeout(timer)
    observer.disconnect()
    for (const event of inputs) window.removeEventListener(event, stop, true)
    window.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('resize', schedule)
    onstop()
  }
  const move = () => {
    if (!active || !node.isConnected) return
    // Hidden tabs do not run frames: start the budget when the first move runs.
    timer ??= window.setTimeout(stop, 10_000)
    window.scrollTo({ top: Math.max(0, position()), left: 0, behavior: 'instant' })
  }
  function schedule() {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(move)
  }
  // Late content anywhere above or beside the node changes the size of one of
  // its ancestors; watching the chain does not depend on how the page's
  // height happens to be laid out.
  const observer = new ResizeObserver(schedule)
  for (let el: HTMLElement | null = node; el; el = el.parentElement) observer.observe(el)
  for (const event of inputs) window.addEventListener(event, stop, { capture: true, passive: true })
  window.addEventListener('resize', schedule)
  // The keyboard a focused reply box brings up opens during the follow; place the box above it.
  window.visualViewport?.addEventListener('resize', schedule)
  schedule()
  return stop
}

/**
 * Content is about to be added above the card being read: measure where that
 * card is now, and get back a call that puts it there again once the change
 * has rendered. Measured from real positions, so a browser that anchored the
 * scroll by itself leaves nothing to correct, and the reader's own scrolling
 * is never fought.
 */
export function holdInView(node: HTMLElement, attribute: string): () => void {
  const header = document.querySelector('header.colhead')?.getBoundingClientRect().height ?? 0
  const card = [...node.querySelectorAll<HTMLElement>(`[${attribute}]`)].find((r) => r.getBoundingClientRect().bottom > header)
  if (!card) return () => {}
  const top = card.getBoundingClientRect().top
  return () => {
    if (!card.isConnected) return
    const delta = card.getBoundingClientRect().top - top
    if (delta !== 0) window.scrollBy({ top: delta, left: 0, behavior: 'instant' })
  }
}

type Reveal = { key: unknown; focus?: string; anchor?: 'above'; nearest?: boolean; onshown?: () => void }

/**
 * An explicit action reveals its target once. Refreshes with the same key
 * leave it alone. With `anchor: 'above'`, the element before the node (the
 * card a reply box answers) stays in view above it when both fit under the
 * header; otherwise the node itself comes first. With `nearest`, a node already
 * in view is left where it is, and one out of view is brought just inside the
 * edge it is beyond. `onshown` is told when a reveal starts,
 * so an owner can tell a fresh press from a box mounted again.
 */
export function revealWhen(node: HTMLElement, initial: Reveal) {
  let key: unknown = null
  let stop = () => {}
  function update(next: Reveal) {
    if (next.key === key) return
    key = next.key
    stop()
    if (key === null || key === undefined) return
    let focused = false
    next.onshown?.()
    stop = followPosition(node, () => {
      const target = (next.focus ? node.querySelector<HTMLElement>(next.focus) : null) ?? node
      if (!focused) {
        target.focus({ preventScroll: true })
        focused = true
      }
      const header = document.querySelector('header.colhead')?.getBoundingClientRect().height ?? 0
      if (next.nearest) {
        const rect = node.getBoundingClientRect()
        if (rect.top >= header && rect.bottom <= visibleBottom()) return window.scrollY
        if (rect.top < header) return window.scrollY + rect.top - header - 12
        return window.scrollY + rect.bottom - visibleBottom() + 12
      }
      const above = next.anchor === 'above' ? node.previousElementSibling : null
      const fits = above !== null && above.getBoundingClientRect().height + node.getBoundingClientRect().height + header + 24 <= visibleHeight()
      return window.scrollY + (fits && above ? above : target).getBoundingClientRect().top - header - 12
    })
  }
  update(initial)
  return { update, destroy: () => stop() }
}

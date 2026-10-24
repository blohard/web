// Measure the natural body, not just the capped viewport: late pictures can
// grow inside a viewport whose size never changes. No fetching or expansion state.

// A quote can be clipped by both its own preview and the enclosing message.
// Each releases only its own claim, never exposing a control the other hides.
const hiddenBy = new WeakMap<HTMLElement, { owners: Set<object>; original: boolean }>()
function hide(element: HTMLElement, owner: object) {
  let entry = hiddenBy.get(element)
  if (!entry) {
    entry = { owners: new Set(), original: element.inert }
    hiddenBy.set(element, entry)
  }
  entry.owners.add(owner)
  element.inert = true
}
function release(element: HTMLElement, owner: object) {
  const entry = hiddenBy.get(element)
  if (!entry) return
  entry.owners.delete(owner)
  if (entry.owners.size === 0) {
    element.inert = entry.original
    hiddenBy.delete(element)
  }
}

/** The first child owns natural layout; the node clips it to a CSS height. */
export function bodyPreview(node: HTMLElement, onOverflow: (clipped: boolean) => void) {
  const content = node.firstElementChild as HTMLElement
  const owner = {}
  let hidden = new Set<HTMLElement>()
  let frame = 0
  let previous: boolean | undefined
  const measure = () => {
    frame = 0
    const viewport = node.getBoundingClientRect()
    const clipped = content.getBoundingClientRect().height > viewport.height + 1
    if (clipped !== previous) {
      previous = clipped
      onOverflow(clipped)
    }
    const next = new Set<HTMLElement>()
    if (clipped) {
      for (const element of content.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]')) {
        // A control with any visible part keeps its meaning: the top of a tall
        // picture still opens the picture, the first line of a wrapping link
        // still follows it. Inert also drops pointer events, so hiding a partly
        // visible control would hand its clicks to the card behind it. Only a
        // control entirely past the cut leaves the tab order.
        const rects = [...element.getClientRects()]
        if (rects.length > 0 && rects.every((r) => r.bottom <= viewport.top + 1 || r.top >= viewport.bottom - 1)) {
          next.add(element)
          hide(element, owner)
        }
      }
    }
    for (const element of hidden) if (!next.has(element)) release(element, owner)
    hidden = next
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure)
  }
  const resize = new ResizeObserver(schedule)
  resize.observe(node)
  resize.observe(content)
  // Hydration can add a control without changing the body's dimensions.
  // Our inert attributes are deliberately not observed, avoiding a feedback loop.
  const mutation = new MutationObserver(schedule)
  mutation.observe(content, { childList: true, subtree: true, characterData: true })
  // An image's dimensions must update the clipping control before its load
  // handler marks the card ready for the stream's initial reveal.
  const loaded = () => { cancelAnimationFrame(frame); measure() }
  content.addEventListener('load', loaded, { capture: true })
  schedule()
  return {
    destroy() {
      cancelAnimationFrame(frame)
      content.removeEventListener('load', loaded, { capture: true })
      resize.disconnect()
      mutation.disconnect()
      for (const element of hidden) release(element, owner)
    },
  }
}

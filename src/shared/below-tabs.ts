// The floating refresh pill must never cover navigation. Tab rows scroll with
// the page while the header stays, so the pill sits under the lowest tab row
// ([data-tab-row]) still on screen below the header, or just under the header
// once they have scrolled away. Runs only while the pill is shown.
export function belowTabs(node: HTMLElement) {
  const header = node.closest('header')
  const column = node.closest('main')
  if (!header || !column) return
  const place = () => {
    const edge = header.getBoundingClientRect().bottom
    let lowest = edge
    for (const tabs of column.querySelectorAll('[data-tab-row]')) {
      const r = tabs.getBoundingClientRect()
      if (r.bottom > lowest && r.top < innerHeight) lowest = r.bottom
    }
    node.style.setProperty('--below-tabs', `${Math.round(lowest - edge)}px`)
  }
  place()
  // Tab rows move when what sits above them changes: a profile's details
  // loading, a notice appearing. The column keeps a minimum height, so its
  // own size says nothing; its children's sizes and its content do.
  const resized = new ResizeObserver(place)
  const watchChildren = () => { resized.disconnect(); for (const child of column.children) resized.observe(child) }
  watchChildren()
  const changed = new MutationObserver(() => { watchChildren(); place() })
  changed.observe(column, { childList: true, subtree: true, characterData: true })
  addEventListener('scroll', place, { passive: true })
  addEventListener('resize', place)
  return {
    destroy() {
      resized.disconnect()
      changed.disconnect()
      removeEventListener('scroll', place)
      removeEventListener('resize', place)
    },
  }
}

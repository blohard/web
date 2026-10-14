import { followPosition } from './scroll'

export type Position = { y: number; row: string | null; offset: number }
/** `attribute` marks the rows a place is measured from; a page of fixed text can go without. */
type Bookmark = {
  saved?: Position
  attribute?: string
  restore?: boolean
  save: (position: Position) => void
}
/** Adapt a visit's saved position without owning or changing the visit's lifetime. */
export const positionBookmark = (state: { position?: Position }, attribute?: string): Bookmark => ({
  saved: state.position, attribute, save: (position) => { state.position = position },
})
const savers = new Set<() => void>()

/** Save before the router replaces the page or scrolls to its destination. */
export const leavePage = () => { for (const save of savers) save() }

/** Feeds and threads follow the same card through delayed bodies and replies. */
export function rememberPosition(node: HTMLElement, initial: Bookmark) {
  let bookmark = initial
  const saved = bookmark.saved
  let restoring = saved !== undefined && bookmark.restore !== false
  let left = false
  let stop = () => {}
  const rows = () => bookmark.attribute ? [...node.querySelectorAll<HTMLElement>(`[${bookmark.attribute}]`)] : []
  // The last scroll position seen while mounted: a view torn down without
  // notice (a tab switch remounts the feed) is already detached when its
  // action is destroyed, and cannot measure its rows any more.
  let lastY = window.scrollY
  const scrolled = () => { lastY = window.scrollY }
  window.addEventListener('scroll', scrolled, { passive: true })
  const save = () => {
    if (left) return
    if (restoring && saved) {
      // Leaving before layout settles must not replace a bookmark with a clamped offset.
      bookmark.save(saved)
    } else if (node.isConnected) {
      const row = rows().find((r) => r.getBoundingClientRect().bottom > 0)
      bookmark.save({ y: window.scrollY, row: row?.getAttribute(bookmark.attribute!) ?? null,
        offset: row?.getBoundingClientRect().top ?? 0 })
    } else {
      bookmark.save({ y: lastY, row: null, offset: 0 })
    }
    left = true
    window.removeEventListener('scroll', scrolled)
    stop()
  }
  savers.add(save)
  if (saved && restoring) {
    stop = followPosition(node, () => {
      const row = rows().find((r) => r.getAttribute(bookmark.attribute!) === saved.row)
      return row ? window.scrollY + row.getBoundingClientRect().top - saved.offset : saved.y
    }, () => { restoring = false })
  } else if (bookmark.restore !== false) {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }
  return {
    update(next: Bookmark) {
      bookmark = next
      if (bookmark.restore === false) stop()
    },
    destroy() {
      save()
      stop()
      savers.delete(save)
    },
  }
}

// Stream bookmarks live only in this tab: a browser reload starts at twenty.
import { rememberPosition, type Position } from './page-position'

type StreamPosition = Position & { limit: number }
export type StreamPositions = Map<string, StreamPosition>
/** A successful pressed refresh supplies its page as a token, consumed once. Local reloads supply none. */
type Stream = { key: string; limit: number; restore?: boolean; topRequest?: { shown: boolean } | null; positions: StreamPositions; arrived?: object }

export const streamPosition = (key: string, store: StreamPositions) => store.get(key)

/** `positions` is the visit's store (features/navigation/visit-position.ts), so a fresh navigation starts at the top. */
export function rememberStream(node: HTMLElement, initial: Stream) {
  const bookmark = (stream: Stream) => ({
    saved: streamPosition(stream.key, stream.positions), attribute: 'data-feed-row', restore: stream.restore,
    save: (position: Position) => stream.positions.set(stream.key, { ...position, limit: stream.limit }),
  })
  const action = rememberPosition(node, bookmark(initial))
  let arrived = initial.arrived
  // A Home press is consumed once, so a later tab remount still restores.
  function takeTop(stream: Stream) {
    if (!stream.topRequest || stream.topRequest.shown) return false
    stream.topRequest.shown = true
    return true
  }
  if (takeTop(initial) || arrived) {
    action.update({ ...bookmark(initial), restore: false })
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }
  return {
    update(next: Stream) {
      const refreshed = next.arrived !== undefined && next.arrived !== arrived
      const home = takeTop(next)
      arrived = next.arrived
      // A refresh press wins over a restore still following the old position.
      action.update(refreshed || home ? { ...bookmark(next), restore: false } : bookmark(next))
      if (refreshed || home) window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    },
    destroy: action.destroy,
  }
}

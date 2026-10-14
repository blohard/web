// Where the reader was on a long page belongs to its visit (features/navigation/visits.ts): a
// fresh navigation and sidebar returns open at the top; Back and Forward restore
// the place being read. Every page that restores its place uses these, so none keeps
// rules of its own. Short pages (settings, activation, a key market) open at
// the top every time, as the router leaves them.
import { rememberPosition, positionBookmark, type Position } from './page-position'
import { router } from './router.svelte'
import type { StreamPositions } from './stream-position'
import type { Visit } from './visits'

type Place = { position?: Position; streams: StreamPositions }

export const placeOf = (visit: Visit) => visit.state<Place>('place', () => ({ streams: new Map() }),
  // Sidebar returns start at the top; the page arrow copies the saved position too.
  (place, keepPosition) => ({ ...(keepPosition && place.position ? { position: { ...place.position } } : {}),
    streams: new Map([...place.streams].map(([key, saved]) =>
      [key, keepPosition ? { ...saved } : { limit: saved.limit, y: 0, row: null, offset: 0 }])) }))

/**
 * The visit shown now. Read it when the view mounts, not earlier: a profile
 * stays mounted across tabs, which share the visit and keep separate stream bookmarks.
 */
export const visitPlace = () => placeOf(router.visit)

/** Back or Forward: this visit already has a place to return to. */
export const returning = () => visitPlace().position !== undefined

/** A long list or document. `attribute` marks its rows, so content arriving above cannot move the place. */
export const rememberPage = (node: HTMLElement, attribute?: string) => rememberPosition(node, positionBookmark(visitPlace(), attribute))

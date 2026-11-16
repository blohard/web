// An opt-in record of the page's background checks, for finding out why a
// refresh button appeared late. It is off unless this browser switches it on:
//
//   localStorage.setItem('blohard.debug.polls', 'true')
//
// and the next check starts recording. The page keeps its latest entries in
// memory, and `copy(blohardPolls())` in the console copies them under a line
// naming the page's build (shared/build.ts), as long as the tab has not
// reloaded. A count that a check found but could not show also logs a console
// warning. While it is off, nothing is recorded and the page gets no reader.
//
// Entries name what happened and never what was read: a poller or stream by its
// kind and a small instance number, never a post's text, an account or a filter.
import { readJSON } from '../lib/storage'
import { buildLine } from './build'

const FLAG = 'blohard.debug.polls'
/** Enough for several minutes of every poller's checks around a return. Hidden ticks are not recorded. */
const KEEP = 120

type Detail = Record<string, string | number | boolean | null | undefined>
const entries: string[] = []
let installed = false
let instances = 0

/**
 * A small number that tells one poller or mounted stream from the next of its
 * kind. The log pairs each opening with its closing by it, so a poller that
 * closed and opened again shows as two numbers.
 */
export function instance(): number { return ++instances }

/** Read on every entry, so the switch works without a reload; checks are seconds apart. */
function on(): boolean {
  if (readJSON<unknown>(FLAG, false) !== true) return false
  if (!installed && typeof window !== 'undefined') {
    installed = true
    const page = window as unknown as { blohardPolls: () => string }
    // The copy starts with the build and the page's load time, which no entry carries.
    page.blohardPolls = () => [buildLine(), ...entries].join('\n')
  }
  return true
}

function line(event: string, detail: Detail): string {
  const now = new Date()
  const time = `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`
  const visibility = typeof document === 'undefined' ? 'unknown' : document.visibilityState
  const fields = Object.entries(detail).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`)
  return [time, visibility, event, ...fields].join(' ')
}

/** Record one step of a check, when this browser has the log switched on. */
export function notePoll(event: string, detail: Detail = {}): void {
  if (!on()) return
  entries.push(line(event, detail))
  if (entries.length > KEEP) entries.shift()
}

/** Record a step that left the refresh button behind what was found, and say so in the console. */
export function warnPoll(event: string, detail: Detail = {}): void {
  if (!on()) return
  notePoll(event, detail)
  console.warn(`[blohard polls] ${line(event, detail)}`)
}

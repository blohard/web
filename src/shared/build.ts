// Which build this page is running. The build writes the checkout's revision
// into each page's head (vite.config.ts), so a tab opened before a deploy still
// names the build it loaded, whatever the site serves now. `blohardBuild` in
// the console prints it, and the poll log's copy starts with it
// (shared/poll-log.ts).

/** The revision this page was built from; "unknown" for a page no build wrote, as in unit tests. */
export const BUILD: string = (typeof document === 'undefined' ? null
  : document.querySelector?.('meta[name="blohard-build"]')?.getAttribute('content')) || 'unknown'

/** When this page loaded. Log entries carry only a time of day, and an idle tab can be days old. */
const loaded = new Date()

/** One line naming the build and when the page loaded, in local time. */
export function buildLine(): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const day = `${loaded.getFullYear()}-${two(loaded.getMonth() + 1)}-${two(loaded.getDate())}`
  return `build ${BUILD}, page loaded ${day} ${loaded.toTimeString().slice(0, 8)}`
}

if (typeof window !== 'undefined') (window as unknown as { blohardBuild: string }).blohardBuild = BUILD

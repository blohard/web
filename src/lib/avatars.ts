// Avatar images are shared across rows and cached in IndexedDB for seven days,
// after which they are dropped: the cache holds a week of reading, not every
// author ever seen.
// Fetching an image reveals the visit to its host; caching reduces those requests.
// A name owner controls what the avatar URL returns, so the download is bounded
// while it streams, and SVG is refused: as an image its scripts are inert, but
// a blob URL of ours opened as a document would run them as this origin.
import { sharedRead } from '../shared/shared-read'
import { responseBytes, ResponseTooLarge } from '../shared/response-bytes.ts'
import { STORES, across, tx } from './db'

type Cached = { address: string; url: string; blob: Blob; fetchedAt: number }
const TTL = 7 * 24 * 60 * 60_000
const MAX_BYTES = 1 << 20
const TIMEOUT_MS = 15_000
/** A failure or refusal is asked about again after an hour; only a picture is kept longer. */
const NEGATIVE_TTL = 60 * 60_000

/** Refused: not a picture this client shows, or too large. */
const REFUSED = false

/** A picture type this client shows. The parameters a type may carry (a charset) are not part of the answer. */
const showable = (type: string) => {
  const bare = type.split(';')[0].trim().toLowerCase()
  return bare.startsWith('image/') && bare !== 'image/svg+xml'
}

/** null permits the original URL as a fallback; false refuses the image. */
type Picture = Blob | null | false
type Entry = { picture: Picture; at: number }
const fresh = (entry: Entry) => Date.now() - entry.at < (entry.picture instanceof Blob ? TTL : NEGATIVE_TTL)

export class Avatars {
  private ready = new Map<string, Entry>()
  private inflight = new Map<string, Promise<Picture>>()
  /** The one sweep of expired entries, made the first time the cache is read in this page. */
  private pruned: Promise<void> | undefined

  private prune(): Promise<void> {
    this.pruned ??= across([STORES.avatars], 'readwrite', (t) => {
      const cutoff = Date.now() - TTL
      const request = t.objectStore(STORES.avatars).openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        if ((cursor.value as Cached).fetchedAt < cutoff) cursor.delete()
        cursor.continue()
      }
    }).catch(() => {})
    return this.pruned
  }

  /** Share blobs, never object URLs. Each mounted avatar owns its URL's lifetime. */
  read(address: string, url: string): Promise<Picture> {
    const k = JSON.stringify([address.toLowerCase(), url])
    const known = this.ready.get(k)
    if (known && fresh(known)) {
      return Promise.resolve(known.picture)
    }
    this.ready.delete(k)
    return sharedRead(this.inflight, k, async () => {
      const entry = await this.load(address.toLowerCase(), url)
      this.ready.set(k, entry)
      return entry.picture
    })
  }

  private async load(address: string, url: string): Promise<Entry> {
    try {
      await this.prune()
      const hit = await tx<Cached | undefined>(STORES.avatars, 'readonly', (s) => s.get(address) as IDBRequest<Cached | undefined>).catch(() => undefined)
      if (hit && hit.url === url && Date.now() - hit.fetchedAt < TTL && showable(hit.blob.type) && hit.blob.size <= MAX_BYTES) {
        return { picture: hit.blob, at: hit.fetchedAt }
      }
      const blob = await download(url)
      if (blob === REFUSED) {
        return { picture: REFUSED, at: Date.now() }
      }
      const at = Date.now()
      await tx(STORES.avatars, 'readwrite', (s) => {
        s.put({ address, url, blob, fetchedAt: at } satisfies Cached)
      }).catch(() => {})
      return { picture: blob, at }
    } catch {
      return { picture: null, at: Date.now() }
    }
  }
}

/**
 * Check the declared length, then cancel if received chunks exceed MAX_BYTES.
 * Oversized responses are never assembled into a blob, even without a length.
 * Throws on network failure; returns `false` for a refusal.
 */
async function download(url: string): Promise<Blob | false> {
  const res = await fetch(url, { mode: 'cors', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  if (!showable(type)) {
    await res.body?.cancel().catch(() => {})
    return REFUSED
  }
  const bytes = await responseBytes(res, MAX_BYTES).catch((error) => {
    if (error instanceof ResponseTooLarge) return null
    throw error
  })
  if (!bytes) return REFUSED
  return new Blob([bytes], { type: type.split(';')[0].trim().toLowerCase() })
}

export const avatars = new Avatars()

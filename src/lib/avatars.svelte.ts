// Avatar images are shared across rows and cached in IndexedDB for seven days,
// after which they are dropped: the cache holds a week of reading, not every
// author ever seen.
// Fetching an image reveals the visit to its host; caching reduces those requests.
// A name owner controls what the avatar URL returns, so the download is bounded
// while it streams, and SVG is refused: as an image its scripts are inert, but
// a blob URL of ours opened as a document would run them as this origin.
import { sharedRead } from '../shared/shared-read'
import { SvelteMap } from 'svelte/reactivity'
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

export class Avatars {
  /**
   * Object URLs by address and source URL. `null`: the fetch failed (the tag may still try the URL itself);
   * `false`: refused for what it is, so the identicon shows instead.
   */
  ready = new SvelteMap<string, string | null | false>()
  private inflight = new Map<string, Promise<void>>()
  /** When each failed or refused answer arrived. */
  private failedAt = new Map<string, number>()
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

  /** An object URL for the cached image, `null` if fetching failed, `false` if refused, `undefined` while working. */
  get(address: string, url: string): string | null | false | undefined {
    const k = JSON.stringify([address.toLowerCase(), url])
    const known = this.ready.get(k)
    if (this.ready.has(k) && (known || Date.now() - (this.failedAt.get(k) ?? 0) < NEGATIVE_TTL)) return known
    // An expired failure keeps showing until the new answer replaces it.
    void sharedRead(this.inflight, k, () => this.load(k, address.toLowerCase(), url))
    return known
  }

  private failed(k: string, value: null | false) {
    this.failedAt.set(k, Date.now())
    this.ready.set(k, value)
  }

  private async load(k: string, address: string, url: string) {
    try {
      await this.prune()
      const hit = await tx<Cached | undefined>(STORES.avatars, 'readonly', (s) => s.get(address) as IDBRequest<Cached | undefined>).catch(() => undefined)
      if (hit && hit.url === url && Date.now() - hit.fetchedAt < TTL && showable(hit.blob.type) && hit.blob.size <= MAX_BYTES) {
        this.ready.set(k, URL.createObjectURL(hit.blob))
        return
      }
      const blob = await download(url)
      if (blob === REFUSED) {
        this.failed(k, REFUSED)
        return
      }
      await tx(STORES.avatars, 'readwrite', (s) => {
        s.put({ address, url, blob, fetchedAt: Date.now() } satisfies Cached)
      }).catch(() => {})
      this.ready.set(k, URL.createObjectURL(blob))
    } catch {
      this.failed(k, null)
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

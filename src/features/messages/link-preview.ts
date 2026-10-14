import { host } from '../../lib/host.svelte'
import { localPreviewPath, siteMetadata } from './site-preview'
import { parseLocation } from '../navigation/router.svelte'
import type { Quote } from '../../lib/reference-syntax'
import { messageText, previewLimit } from './message-text'
import { responseJson, retryAfter } from '../../shared/response-json'
import { sharedRead } from '../../shared/shared-read'
import { SerialQueue } from '../../shared/serial-queue'

export type PreviewLink = { url: string; source: string; localPath?: string }
export type PreviewPost = { chain: number; id: bigint }
export type LinkMetadata = { title: string; description: string; image: string | null }

/** Explicit quotes take priority; automatic cards share the picture budget. */
function previewSegments(text: string, maxAttachments: number) {
  const segments = messageText(text, { quotes: true, maxAttachments })
  return segments.some(s => s.kind === 'quote')
    || segments.filter(s => s.kind === 'record' && s.image).length >= previewLimit(maxAttachments) ? [] : segments
}

/** One link card, after the existing picture and quote budget. Never displace either. */
export function previewLink(text: string, maxAttachments = 4, origin = globalThis.location?.origin): PreviewLink | null {
  const segments = previewSegments(text, maxAttachments)
  for (const segment of segments) {
    if (segment.kind !== 'link') continue
    const url = new URL(segment.href)
    if (url.href.length > 2048) continue
    if (url.origin === origin || url.hostname === 'blohard.social') {
      if (url.port && url.origin !== origin) continue
      const localPath = localPreviewPath(url)
      if (localPath) return { url: url.href, source: segment.text, localPath }
      continue
    }
    if (!url.port) return { url: url.href, source: segment.text }
  }
  return null
}

export type PostLink = Omit<Quote, 'commit'> & { commit?: Quote['commit'] }

/** Same-site post links use the router's validation, including commitment pins. */
export function previewPost(text: string, maxAttachments = 4, origin = globalThis.location?.origin): PostLink | null {
  for (const segment of previewSegments(text, maxAttachments)) {
    if (segment.kind !== 'link') continue
    const url = new URL(segment.href)
    if (url.href.length > 2048 || (url.origin !== origin && (url.hostname !== 'blohard.social' || url.port))) continue
    const route = parseLocation(url.pathname, url.search, url.hash)
    if (route.kind === 'thread') return { chainId: route.chainId, id: route.id, ...(route.commit ? { commit: route.commit } : {}) }
  }
  return null
}

/** Same-site pages need no outbound preview service; both kinds use the host's attachment cap. */
export function hostPreviewLink(text: string): PreviewLink | null {
  const status = host.status
  const link = previewLink(text, status?.store?.attachments?.max_per_message ?? 4)
  return link?.localPath || status?.gateway?.link_previews ? link : null
}

export function checkedPreview(value: unknown): LinkMetadata | null {
  if (!value || typeof value !== 'object' || !('preview' in value)) throw new Error('invalid link preview')
  if (value.preview === null) return null
  const p = value.preview as Partial<LinkMetadata> | null
  if (!p || typeof p.title !== 'string' || p.title.length > 256
    || typeof p.description !== 'string' || p.description.length > 512) throw new Error('invalid link preview')
  let image: string | null = null
  if (p.image !== null) {
    if (typeof p.image !== 'string' || p.image.length > 2048) throw new Error('invalid preview image')
    const url = new URL(p.image)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('invalid preview image')
    image = url.href
  }
  return { title: p.title, description: p.description, image }
}

/** A queued read found its endpoint paused and gave its lane back. */
const PAUSED = Symbol('paused')
const ACTIVE_READS = 64
const WAITING_READS = 64

/** Local capacity is temporary, not an answer about a link. */
export class PreviewQueueFull extends Error {
  override name = 'PreviewQueueFull'
  constructor() { super('preview queue is full') }
}

/**
 * The mounted card keeps its answer. Expiry affects later reads only. A page's
 * metadata is shared by URL, whichever endpoint fetched it; a refusal or
 * failure belongs to the endpoint that got it, as does a request in flight,
 * so a refused draft preview never hides a published post's preview.
 */
export class LinkPreviews {
  private cache = new Map<string, { until: number; value: LinkMetadata | null }>()
  // Shared promises include both active and waiting reads; neither group can grow past its cap.
  private flights = new Map<string, Promise<LinkMetadata | null>>()
  private active = 0
  private waiting: (() => void)[] = []
  private lanes = [new SerialQueue(), new SerialQueue()]
  private nextLane = 0
  /**
   * When each endpoint may be asked again after the host refused this visitor
   * outright (429). Published and draft previews have separate allowances; a
   * 503 is about one link or post, so it pauses only that link. Every read
   * waiting on a paused endpoint, the refused one included, asks again after.
   */
  private until = { post: 0, draft: 0 }
  /** How a read waits out a pause; tests replace it. */
  pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

  read(link: PreviewLink, post?: PreviewPost): Promise<LinkMetadata | null> {
    const url = new URL(link.url)
    url.hash = ''
    // A page's metadata is one answer for everyone, but a refusal is about
    // one post's right to it (or the draft's), so refusals and the requests
    // in flight are kept per post.
    const key = url.href, scoped = `${post ? `post ${post.chain}/${post.id}` : 'draft'} ${key}`
    const cached = this.fresh(key) ?? this.fresh(scoped)
    if (cached) return Promise.resolve(cached.value)
    const existing = this.flights.get(scoped)
    if (existing) return existing
    if (this.flights.size >= ACTIVE_READS + WAITING_READS) return Promise.reject(new PreviewQueueFull())
    return sharedRead(this.flights, scoped, () => new Promise((resolve, reject) => {
      const start = () => {
        this.active++
        void this.run(link, key, scoped, post).then(resolve, reject).finally(() => {
          this.active--
          this.waiting.shift()?.()
        })
      }
      if (this.active < ACTIVE_READS) start()
      else this.waiting.push(start)
    }))
  }

  private async run(link: PreviewLink, key: string, scoped: string, post?: PreviewPost): Promise<LinkMetadata | null> {
    const endpoint = post ? 'post' : 'draft'
    // Paused reads leave the request lanes free for the other endpoint.
    let asked = 0
    for (;;) {
      for (let wait = this.until[endpoint] - Date.now(); wait > 0; wait = this.until[endpoint] - Date.now()) await this.pause(wait)
      const answer = await this.lanes[this.nextLane++ % 2]!.run<LinkMetadata | null | typeof PAUSED>(() => {
        // The other endpoint may have fetched this page while this read waited.
        const shared = this.fresh(key)
        if (shared) return Promise.resolve(shared.value)
        return this.until[endpoint] > Date.now() ? Promise.resolve(PAUSED) : this.ask(link, key, scoped, endpoint, ++asked >= 3, post)
      })
      if (answer !== PAUSED) return answer
    }
  }

  private async ask(link: PreviewLink, key: string, scoped: string, endpoint: 'post' | 'draft', last: boolean, post?: PreviewPost): Promise<LinkMetadata | null | typeof PAUSED> {
    let value: LinkMetadata | null = null, ttl = 60_000, answered = false
    try {
      const path = post ? `/api/link-preview?chain=${post.chain}&id=${post.id}&` : '/api/link-preview/draft?'
      const response = await fetch(link.localPath ?? `${path}link=${encodeURIComponent(link.source)}`, {
        ...(link.localPath ? { redirect: 'error' as const } : { headers: { 'x-blohard-preview': '1' } }),
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status === 429) {
        // This visitor's allowance is spent, not this link's: wait out the
        // pause and ask again, like the reads queued behind this one. At
        // least a second, so a zero Retry-After cannot make it ask in a loop,
        // and three asks in all, so a closed card's read ends too.
        this.until[endpoint] = Date.now() + Math.min(60_000, Math.max(1_000, retryAfter(response) ?? 2_000))
        if (!last) return PAUSED
      }
      // A refusal is a negative answer: kept an hour at most.
      if (!response.ok) ttl = Math.min(3_600_000, Math.max(ttl, retryAfter(response) ?? 0))
      if (response.ok) {
        value = link.localPath ? await siteMetadata(response) : checkedPreview(await responseJson(response, 8192))
        answered = true
        const age = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get('cache-control') ?? '')
        ttl = Math.min(86400, Number(age?.[1] ?? 0)) * 1000
      }
    } catch { /* An unavailable preview never hides the post or its link. */ }
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(answered ? key : scoped, { value, until: Date.now() + ttl })
    return value
  }

  private fresh(key: string) {
    const entry = this.cache.get(key)
    return entry && entry.until > Date.now() ? entry : undefined
  }
}
export const linkPreviews = new LinkPreviews()

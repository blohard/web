// Same-site page metadata comes from the page itself, through the browser.
// Only public pages are read; the host never fetches its own URL.
import { parse, parseLocation } from '../navigation/router.svelte'
import type { LinkMetadata } from './link-preview'

export function localPreviewPath(url: URL): string | null {
  const path = url.pathname
  if (path.startsWith('/p/')) return null
  if (path === '/design.html' || path === '/demo-blog.html') return path
  if (path === '/' || path === '/index.html') {
    const route = parseLocation(path, url.search, url.hash)
    return route.kind !== 'unknown' && route.kind !== 'thread' ? path : null
  }
  const route = parse(path + url.search)
  return route.kind === 'user' || route.kind === 'keyring' || route.kind === 'about'
    || (route.kind === 'keys' && route.about) ? path : null
}

/** Read only the small, generated head, even when the page contains a long document. */
export async function pageHead(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let head = '', remaining = 32 << 10
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value.subarray(0, remaining)
      remaining -= chunk.length
      const from = Math.max(0, head.length - 6)
      head += decoder.decode(chunk, { stream: true })
      const end = head.slice(from).toLowerCase().indexOf('</head>')
      if (end >= 0) return head.slice(0, from + end)
    }
    return head + decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** A detached template is inert: scripts, frames and pictures never run or load. */
export async function siteMetadata(response: Response, origin = location.origin): Promise<LinkMetadata | null> {
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/html') {
    await response.body?.cancel().catch(() => {})
    return null
  }
  const template = document.createElement('template')
  template.innerHTML = await pageHead(response)
  const meta = (key: string) => template.content.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute('content') ?? ''
  const text = (value: string, limit: number) => value.replace(/\s+/g, ' ').trim().slice(0, limit)
  const title = text(meta('og:title') || template.content.querySelector('title')?.textContent || '', 256)
  const description = text(meta('og:description') || meta('description'), 512)
  let image: string | null = null
  const source = meta('og:image')
  if (source && source.length <= 2048) {
    try {
      const url = new URL(source, origin)
      // Generated pages may name the canonical site while this client uses another public name.
      if (!url.username && !url.password && (url.origin === origin || url.origin === 'https://blohard.social')) {
        const local = new URL(origin)
        local.pathname = url.pathname
        local.search = url.search
        image = local.href
      }
    } catch { /* A page without a usable local picture still has its text. */ }
  }
  return title || description ? { title, description, image } : null
}

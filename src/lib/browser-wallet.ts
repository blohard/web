import type { Eip1193Provider } from './types'

export type BrowserWallet = {
  id: `injected:${string}`
  name: string
  rdns: string
  provider: Eip1193Provider
}

/** Announcements are untrusted. Keep only bounded text and a provider, never icons or HTML. */
export function browserWallet(detail: unknown): BrowserWallet | undefined {
  try {
    const { info, provider } = detail as { info: Record<string, unknown>; provider: Eip1193Provider }
    const { uuid, name, rdns } = info
    if (typeof uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid) ||
        typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name) ||
        typeof rdns !== 'string' || rdns.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(rdns) ||
        !provider || typeof provider.request !== 'function' || typeof provider.on !== 'function') return
    return { id: `injected:${uuid.toLowerCase()}`, name: name.trim(), rdns, provider }
  } catch {
    // Malformed events or throwing accessors must not break discovery.
    return
  }
}

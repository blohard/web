// Full reference tokens (the protocol spec §7). Rendering and the host extractor
// use the same delimiters: a malformed suffix must never become a valid prefix.
import type { Address, Hex } from 'viem'

export type Quote = { chainId: number; id: bigint; commit: Hex }
type PostReference = Omit<Quote, 'commit'> & { commit?: Hex }

export function parsePostReference(text: string): PostReference | null {
  const m = /^post:\/\/([1-9]\d*)\/([1-9]\d*)(?:\?commit=(0x[0-9a-f]{64}))?$/.exec(text)
  if (!m || m[1].length > 16 || m[2].length > 20) return null
  const chainId = Number(m[1]), id = BigInt(m[2])
  if (!Number.isSafeInteger(chainId) || id > 0xffffffffffffffffn) return null
  return { chainId, id, ...(m[3] ? { commit: m[3] as Hex } : {}) }
}

export function parseAccountReference(text: string): Address | null {
  return /^account:\/\/(0x[0-9a-fA-F]{40})$/.exec(text)?.[1].toLowerCase() as Address ?? null
}

/** The combined reading cap, before validation and deduplication. */
export const MAX_REFERENCES = 8

/** References in text order, counting repetitions. The composer asks for one extra to detect overflow. */
export function textReferences(text: string, limit = MAX_REFERENCES): string[] {
  const pattern = /(?:post|account):\/\/[^\s<>"'`()\[\]{}\\]*/gu
  const out: string[] = []
  for (const match of text.matchAll(pattern)) {
    if (out.length === limit) break
    out.push(match[0])
  }
  return out
}

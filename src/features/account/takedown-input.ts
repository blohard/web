// What the takedown page reads from text, without fetching anything: the
// post link or content hash the admin pasted, and the records a post's text
// names as attachments.
import type { Hex } from 'viem'

/** A pasted post link, or a content hash (bare or inside a content link). */
type TakedownTarget = { kind: 'post'; chainId: number; id: bigint } | { kind: 'hash'; hash: Hex }

export function parseTakedownInput(text: string): TakedownTarget | null {
  const post = /\/p\/([1-9][0-9]*)\/([1-9][0-9]*)/.exec(text)
  if (post) return { kind: 'post', chainId: Number(post[1]), id: BigInt(post[2]) }
  const hash = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/.exec(text)?.[0]
  return hash ? { kind: 'hash', hash: hash.toLowerCase() as Hex } : null
}

/** Every distinct record the text names, in order of first mention, in lower case. */
export function attachmentHashes(text: string): Hex[] {
  return [...new Set([...text.matchAll(/record:(0x[0-9a-fA-F]{64})(?![0-9a-fA-F])/g)].map(m => m[1].toLowerCase() as Hex))]
}

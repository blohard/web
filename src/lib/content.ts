// Bodies, fetched at most once every five minutes. A record's bytes never
// change, but the host may take them down: a body that arrived and verified is
// kept as interpreted for as long as the host lets caches keep it. A miss, a
// takedown or a failure is not kept, so the next ask, on a refresh, tries the
// host again. Nothing already shown changes by itself.
import type { Hex } from 'viem'
import { interpret, type Body } from './body'
import { fetchContent, type Anchor } from './store'

/** How long the host lets caches keep content before asking again. */
const FRESH_MS = 5 * 60_000

const bodies = new Map<string, { at: number; body: Promise<Body> }>()

/** The body a hash names, interpreted, fetched at most once while it is good and fresh. */
export function loadBody(hash: Hex, anchor: Anchor): Promise<Body> {
  const key = hash.toLowerCase()
  const kept = bodies.get(key)
  if (kept && Date.now() - kept.at < FRESH_MS) return kept.body
  const body = fetchContent(hash, anchor).then(
    (content) => {
      if (!content.ok) bodies.delete(key)
      return interpret(content)
    },
    (e: unknown) => {
      bodies.delete(key)
      throw e
    },
  )
  bodies.set(key, { at: Date.now(), body })
  return body
}

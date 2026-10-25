// Bodies, reused for up to five minutes while retained. A record's bytes never
// change, but the host may take them down: a body that arrived and verified is
// kept as interpreted for as long as the host lets caches keep it. A miss, a
// takedown or a failure is not kept, so the next ask, on a refresh, tries the
// host again. Nothing already shown changes by itself.
import type { Hex } from 'viem'
import { ReadCache } from '../shared/read-cache'
import { interpret, type Body } from './body'
import { fetchContent, type Anchor } from './store'

/** How long the host lets caches keep content before asking again. */
const FRESH_MS = 5 * 60_000

// Verified bytes remain cacheable even when their envelope or media type is unknown.
const bodies = new ReadCache<string, Body>(FRESH_MS, 512,
  body => body.kind === 'text' || body.kind === 'no-envelope' || body.kind === 'unknown-type')

/** Share outstanding reads; reuse a completed body while it is fresh and retained. */
export function loadBody(hash: Hex, anchor: Anchor): Promise<Body> {
  return bodies.read(hash.toLowerCase(), async () => interpret(await fetchContent(hash, anchor)))
}

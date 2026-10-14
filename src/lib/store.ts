// The content host's HTTP API (https://github.com/blohard/host/blob/main/STORE_API.md). Same origin
// as the app, so paths
// are relative. Every body fetched here is hashed locally before it is trusted.
import { keccak256, type Hex } from 'viem'
import type { Status } from './types'
import { errorMessage, responseJson, retryAfter } from '../shared/response-json'
import { responseBytes, ResponseTooLarge } from '../shared/response-bytes.ts'
import { host } from './host.svelte'

class StoreError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The wait the host asked for with `Retry-After`, in milliseconds, or null when it named none. */
    public retryAfter: number | null = null,
  ) {
    super(message)
  }
}

async function errorOf(res: Response): Promise<StoreError> {
  const answer = await responseJson(res).catch(() => null)
  // Bound untrusted backoff values; this host normally asks for two seconds.
  const asked = retryAfter(res)
  return new StoreError(res.status, errorMessage(res, answer), asked === null ? null : Math.min(30_000, Math.max(2000, asked)))
}

export async function getStatus(): Promise<Status> {
  const res = await fetch('/api/status', { signal: AbortSignal.timeout(20_000) })
  const body = await responseJson(res).catch((error) => {
    if (res.ok) throw error
    return null
  })
  // A stopped index makes the health probe fail, but the normal status body
  // still lets the app open healthy chains. Do not accept a proxy's 503 page.
  if (res.status === 503) {
    if (body && typeof body === 'object' && 'verifier' in body && typeof body.verifier === 'string'
      && 'chains' in body && Array.isArray(body.chains)
      && 'store' in body && 'gateway' in body
      && body.chains.some((chain: { index?: { state?: string } } | null) => chain?.index?.state === 'stopped')) {
      return body as Status
    }
  }
  if (!res.ok) throw new StoreError(res.status, errorMessage(res, body))
  return body as Status
}

/** keccak-256 of exact bytes, as the chain and the host compute it. */
export function hashOf(bytes: Uint8Array): Hex {
  return keccak256(bytes)
}

export const utf8 = {
  encode: (s: string) => new TextEncoder().encode(s),
  decode: (b: Uint8Array) => new TextDecoder('utf-8').decode(b),
}

/**
 * What proves the bytes are anchored: the message id once the receipt names
 * it, or the transaction hash returned after submission
 * (https://github.com/blohard/host/blob/main/STORE_API.md).
 */
export type Proof = { messageId: bigint } | { txHash: Hex }

type PublishResult = {
  hash: Hex
  /** True if the record was new in the store. */
  stored: boolean
  /** True (HTTP 202) while bytes are held unserved pending the host's confirmation depth. */
  held: boolean
  bytes: number
  kind: 'body' | 'attachment'
  /** The id the host knows so far; null while the transaction is pending. */
  message_id?: number | null
}

/**
 * Upload bytes with their proof of anchoring. Throws StoreError on refusal.
 * `expected` is the hash the post names for these bytes, when the caller has
 * it: the host's reported hash must equal it, which also catches bytes changed
 * since they were named. Without it the bytes are hashed here.
 */
export async function publish(bytes: Uint8Array, chainId: number, proof: Proof, expected = hashOf(bytes)): Promise<PublishResult> {
  const qs = new URLSearchParams({ chain_id: String(chainId) })
  if ('messageId' in proof) qs.set('message_id', proof.messageId.toString())
  else qs.set('tx_hash', proof.txHash)
  // `.slice()` gives a Uint8Array over its own plain ArrayBuffer, which is what fetch accepts.
  const res = await fetch(`/api/publish?${qs}`, { method: 'POST', body: bytes.slice().buffer, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw await errorOf(res)
  const body = (await responseJson(res)) as PublishResult
  if (body.hash.toLowerCase() !== expected.toLowerCase()) {
    throw new StoreError(0, `host reported ${body.hash} for a record expected ${expected}`)
  }
  return { ...body, held: body.held ?? res.status === 202 }
}

/**
 * Publish with the retries https://github.com/blohard/host/blob/main/STORE_API.md asks for: a `404`
 * for a transaction the
 * host's RPC has not seen yet, or a `403` "has no message" right after
 * inclusion, can mean a lagging RPC. Rate refusals respect a bounded Retry-After.
 * All retries reuse the same bytes and proof; other failures are thrown at once.
 */
export async function publishWithRetry(bytes: Uint8Array, chainId: number, proof: Proof, expected = hashOf(bytes)): Promise<PublishResult> {
  const delays = [1000, 2000, 3000]
  for (let attempt = 0; ; attempt++) {
    try {
      return await publish(bytes, chainId, proof, expected)
    } catch (e) {
      const lagging =
        e instanceof StoreError &&
        ((e.status === 404 && 'txHash' in proof) || (e.status === 403 && e.message.includes('has no message')))
      const limited = e instanceof StoreError && e.status === 429
      // A host shedding load (upload slots, upstream budget, a starting
      // index) answers 503; the same bytes succeed once it recovers.
      const busy = e instanceof StoreError && e.status === 503
      if ((!lagging && !limited && !busy) || attempt >= delays.length) throw e
      // The host's own wait comes first. Without one, a 429 waits two
      // seconds and everything else backs off on the schedule.
      const asked = e instanceof StoreError ? e.retryAfter : null
      await new Promise((r) => setTimeout(r, asked ?? (limited ? 2000 : delays[attempt])))
    }
  }
}

export type Content =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'missing' | 'mismatch' | 'error' | 'taken_down'; detail: string }

/** The message a record belongs to: named on a fetch so a host that lacks the bytes may ask its peers for them. */
export type Anchor = { chainId: number; messageId: bigint }

/** The the protocol spec §7 attachment baseline, for a host whose store limits are not known. */
const BASELINE_RECORD_BYTES = 2 * 1024 * 1024

/** No record this host stores can be larger than its body or attachment cap. */
function recordLimit(): number {
  const store = host.status?.store
  return store ? Math.max(store.max_content_size, store.attachments?.max_bytes ?? 0) : BASELINE_RECORD_BYTES
}

/**
 * Fetch content by hash and verify it. Never returns unverified bytes. With
 * `anchor`, a host that lacks the record can pull it from a peer
 * (https://github.com/blohard/host/blob/main/STORE_API.md).
 * The body is read up to the largest record the host stores, never beyond.
 */
/** `ms` from now, or sooner when `signal` aborts: a reader that left stops its download. */
function within(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  const either = new AbortController()
  const stop = () => either.abort()
  for (const s of [signal, timeout]) {
    if (s.aborted) stop()
    else s.addEventListener('abort', stop, { once: true })
  }
  return either.signal
}

export async function fetchContent(hash: Hex, anchor?: Anchor, signal?: AbortSignal): Promise<Content> {
  const query = anchor ? `?chain_id=${anchor.chainId}&message_id=${anchor.messageId}` : ''
  try {
    const res = await fetch(`/api/content/${hash}${query}`, { signal: within(60_000, signal) })
    if (res.status === 404) return { ok: false, reason: 'missing', detail: 'this host does not have the bytes' }
    if (!res.ok) {
      const answer = await responseJson(res).catch(() => null)
      // Taken down by this host, known by its code alone: not asked for again,
      // nor looked for elsewhere.
      if ((answer as { code?: unknown } | null)?.code === 'taken_down') return { ok: false, reason: 'taken_down', detail: 'removed by this host' }
      return { ok: false, reason: 'error', detail: errorMessage(res, answer) }
    }
    let bytes: Uint8Array
    try {
      bytes = (await responseBytes(res, recordLimit())) ?? new Uint8Array()
    } catch (e) {
      if (e instanceof ResponseTooLarge) return { ok: false, reason: 'error', detail: 'the host sent more bytes than any record it stores' }
      throw e
    }
    const actual = hashOf(bytes)
    if (actual.toLowerCase() !== hash.toLowerCase()) {
      return { ok: false, reason: 'mismatch', detail: `host returned bytes hashing to ${actual}` }
    }
    return { ok: true, bytes }
  } catch {
    // A response can fail after its headers arrive, while reading the body.
    return { ok: false, reason: 'error', detail: 'could not download the content from the host' }
  }
}

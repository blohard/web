// Immutable message records and ancestor context from the host index.
// Records from two histories are never combined: when the host reports a new
// generation (a rebuilt index), this chain's cached records are dropped, and
// an answer from the replaced one is refused (the gate ledger decides both).
import { sharedRead } from '../shared/shared-read'
import type { Hex } from 'viem'
import { ApiError, integer, message, record, snapshots, type At, type RecordImage } from './api'
import { gates } from './gates.svelte'
import type { ChainInfo, MessageRef, MessageRecord } from './types'
import type { Quote } from './reference-syntax'

const MAX_RECORDS = 10_000
const records = new Map<string, MessageRecord>()
const reads = new Map<string, Promise<MessageRecord>>()
const walks = new Map<string, Promise<MessageRecord[]>>()
const generations = new Map<string, Hex>()
const chainKey = (chain: ChainInfo) => `${chain.id}:${chain.contract.toLowerCase()}`
const keyOf = (chain: ChainInfo, id: bigint) => `${chainKey(chain)}:${id}`

/** Records of a history the gate ledger has left are never served again. */
function sync(chain: ChainInfo) {
  const key = chainKey(chain), current = gates.generation(chain)
  if (current === null || !generations.has(key) || generations.get(key) === current) return
  for (const known of [...records.keys()]) if (known.startsWith(`${key}:`)) records.delete(known)
  generations.set(key, current)
}

function immutableRecord(r: RecordImage): MessageRecord {
  const { id, author, parentId, parentAuthor, contentHash, blockNumber, logIndex, timestamp, txHash, commitment } = r
  return { id, author, parentId, parentAuthor, contentHash, blockNumber, logIndex, timestamp, txHash, commitment }
}

/** The record does not carry the commitment a quote pinned: an answer, not an outage. */
export class QuoteMismatch extends Error {
  constructor() { super('quote commitment does not match this message') }
}

/** An answer from before the gate ledger's first baseline: asking again gets a current one. */
export class SnapshotBehind extends Error {
  constructor() { super('the host snapshot is behind this view; retry') }
}

/** Feed, reply and message answers share one immutable record cache. */
export function rememberMessages(chain: ChainInfo, at: At, rows: RecordImage[]): RecordImage[] {
  if (!storeMessages(chain, at, rows)) throw new SnapshotBehind()
  return rows
}

/** A point read may retry a snapshot overtaken by the first gate baseline. */
function storeMessages(chain: ChainInfo, at: At, rows: RecordImage[]): boolean {
  const key = chainKey(chain)
  if (!/^0x[0-9a-f]{64}$/.test(at.generation)) throw new ApiError(409, 'reset_required')
  integer(at.sequence)
  const block = at.checkpoint ? integer(at.checkpoint.block) : null
  if (rows.some((r) => block === null || r.blockNumber > block)) throw new Error('host message is outside the accepted index')
  const rebuilt = generations.has(key) && generations.get(key) !== at.generation
  // Validate everything before any record from an answer becomes visible.
  // Commitments compare within one history; a new one replaces the records.
  if (!rebuilt) {
    for (const r of rows) {
      const existing = records.get(keyOf(chain, r.id))
      if (existing && existing.commitment !== r.commitment) throw new ApiError(409, 'reset_required')
    }
  }
  if (!gates.observe(chain, at, rows)) return false
  sync(chain)
  generations.set(key, at.generation)
  for (const r of rows) {
    const key = keyOf(chain, r.id)
    records.delete(key)
    records.set(key, immutableRecord(r))
  }
  while (records.size > MAX_RECORDS) records.delete(records.keys().next().value!)
  return true
}

/** Fresh state and up to 32 ancestors in one answer, nearest first. */
export async function readMessage(
  chain: ChainInfo, id: bigint, limit = 0, pin?: Hex,
  /** The same request already sent, whose answer is checked and applied here as the first attempt. */
  sent?: ReturnType<typeof message>,
): Promise<{ at: At; record: RecordImage; ancestors: RecordImage[] }> {
  if (!Number.isInteger(limit) || limit < 0 || limit > 32) throw new Error('ancestor limit must be 0 to 32')
  // All record answers come from one index owner. Only a response already in flight
  // before the gate baseline can be behind it; a fresh read cannot be.
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await (attempt === 0 && sent ? sent : message(chain, id, limit, pin))
    if (!Array.isArray(answer.ancestors) || answer.ancestors.length > limit) throw new Error('invalid ancestor answer')
    const root = record(answer.message)
    if (root.id !== id || (pin !== undefined && root.commitment !== pin)) throw new QuoteMismatch()
    const ancestors = answer.ancestors.map(record)
    let expected = root.parentId
    for (const parent of ancestors) {
      if (parent.id !== expected) throw new Error('host ancestors are out of order')
      expected = parent.parentId
    }
    if (ancestors.length < limit && expected !== 0n) throw new Error('host ancestors stopped before the root')
    if (!storeMessages(chain, answer.at, [root, ...ancestors])) continue
    return { at: answer.at, record: root, ancestors }
  }
  throw new Error('the host snapshot is behind this view')
}

/** Touch only on use. Views retain their own records independently of this cache. */
function cachedRecord(key: string): MessageRecord | undefined {
  const known = records.get(key)
  if (known) { records.delete(key); records.set(key, known) }
  return known
}

/**
 * One record through the shared snapshot, so the cards that ask in one turn
 * (a page of notifications, a profile's missing parents) share a request.
 */
async function readRecord(chain: ChainInfo, id: bigint): Promise<RecordImage> {
  // As in readMessage, only an answer started before the gate baseline can be behind it.
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await snapshots(chain, [id])
    const found = answer.items[0]
    if (answer.items.length !== 1 || !found) throw new ApiError(404, 'message_not_found')
    const r = record(found)
    if (r.id !== id) throw new Error('host returned the wrong message')
    if (storeMessages(chain, answer.at, [r])) return r
  }
  throw new Error('the host snapshot is behind this view')
}

/** Immutable fields are reused while cached. Failed or evicted reads can be asked for again. */
export function getMessage(chain: ChainInfo, id: bigint, pin?: Hex): Promise<MessageRecord> {
  sync(chain)
  const key = keyOf(chain, id)
  const known = cachedRecord(key)
  const pending = known ? Promise.resolve(known)
    : sharedRead(reads, key, () => readRecord(chain, id).then(immutableRecord))
  return pending.then((r) => {
    if (pin !== undefined && r.commitment !== pin) throw new QuoteMismatch()
    return r
  })
}

/**
 * A first load checks any supplied pin: advancing the shared ledger would move
 * other posts on screen. A refresh advances it, and failing clears the preview,
 * including a cached record from a stopped index. On a first load only a wrong
 * pin or an unknown post is null; a host that could not be asked throws, for
 * the card to offer another try.
 */
export async function resolveQuote(chain: ChainInfo, id: bigint, pin: Hex | undefined, refresh = false): Promise<MessageRecord | null> {
  try {
    if (refresh) await gates.advanceToHead(chain)
    return await getMessage(chain, id, pin)
  } catch (e) {
    if (refresh || e instanceof QuoteMismatch || (e instanceof ApiError && e.status === 404)) return null
    throw e
  }
}

/** Capture what the reader saw, only from a record accepted by the index. */
export async function quoteOf(chain: ChainInfo, shown: MessageRef): Promise<Quote> {
  const r = await getMessage(chain, shown.id)
  if (r.author.toLowerCase() !== shown.author.toLowerCase() || r.parentId !== shown.parentId || r.contentHash !== shown.contentHash) {
    throw new Error('this post no longer matches the one shown; reload before quoting')
  }
  return { chainId: chain.id, id: r.id, commit: r.commitment }
}

/**
 * Cached parents arrive immediately. A missing suffix is one host read keyed
 * by its first parent and limit, so siblings share it. A failed suffix does
 * not discard earlier context and never falls back to a contract walk.
 */
export async function* ancestorsOf(chain: ChainInfo, from: MessageRef, max: number): AsyncGenerator<MessageRecord> {
  if (!Number.isInteger(max) || max < 0 || max > 32) throw new Error('ancestor limit must be 0 to 32')
  let child = from
  let remaining = max
  while (remaining > 0 && child.parentId !== 0n) {
    sync(chain)
    const cached = cachedRecord(keyOf(chain, child.parentId))
    if (cached) {
      yield cached
      child = cached
      remaining--
      continue
    }
    const key = `${keyOf(chain, child.parentId)}:${remaining}`
    const pending = sharedRead(walks, key, () =>
      readMessage(chain, child.parentId, remaining - 1).then((r) => [r.record, ...r.ancestors].map(immutableRecord)))
    for (const r of await pending) {
      yield r
      child = r
      remaining--
    }
  }
}

// The host's application API. Ethereum calldata belongs to wallet submission;
// page readers exchange records and cursors here.
import { wireAddress, wireHash, uint32, uint64 } from '../shared/wire-values.ts'
import { ResponseTooLarge } from '../shared/response-bytes.ts'
import { responseJson, retryAfter as retryAfterOf } from '../shared/response-json.ts'
import { encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex } from 'viem'
import type { ChainInfo, MessageRef, MessageRecord } from './types'

export type At = { generation: Hex; sequence: string; checkpoint: { block: string; hash: Hex } | null }
export type Cursor = { generation: Hex; filter: Hex; ceiling: string; before: string }
export type ReplyCursor = { generation: Hex; parent: string; ceiling: string; after: string }
export type WireMessage = {
  id: string; author: Address; parent: string; parent_author: Address; timestamp: number
  content_hash: Hex; transaction: Hex; position: { block: string; log: number }; gate: Address
}
export type WireRecord = WireMessage & { author_gate: Address; effective_gate: Address; commitment: Hex; replies: string }
/** One host snapshot of a message, including mutable state at its answer's `at`. */
export type RecordImage = MessageRecord & {
  gate: Address; authorGate: Address; effectiveGate: Address; replies: number
}
type MessageAnswer = { at: At; message: WireRecord; ancestors: WireRecord[] }
export type Page<C = Cursor, R = WireRecord> = { at: At; items: R[]; next: C | null }
export type WireReference = WireRecord & { reference:
  | { kind: 'mention'; account: Address }
  | { kind: 'quote'; target: { chain: string; id: string; commit: Hex } }
}
type Account = { address: Address; gate: Address; member: boolean | null }
export type List = { registry: Address; owner: Address; list: Hex }
type Membership = { list: List; member: Address }
type Snapshot = { at: At; items: (WireRecord | null)[]; accounts: Account[]; memberships: boolean[] }
type Clause = { curated?: boolean; parent_curated?: boolean; authors?: Address[]; parent_authors?: Address[]; members_of?: List; parent_members_of?: List; kind?: 'all' | 'posts' | 'replies' }
export type FeedFilter = { any: Clause[]; exclude_list?: List }

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly revert?: Hex
  /** The wait the host asked for with `Retry-After`, in milliseconds, or null when it named none. */
  readonly retryAfter: number | null
  constructor(status: number, code: string, revert?: Hex, retryAfter: number | null = null) {
    super(code === 'reset_required' ? 'the results changed, reload this page' : code.replaceAll('_', ' '))
    this.name = 'ApiError'
    this.status = status; this.code = code; this.revert = revert; this.retryAfter = retryAfter
  }
}

/** No implicit retry: the page or publication owns the retry and its cursor. */
export function request<T>(chain: Pick<ChainInfo, 'id'>, path: string, body?: unknown): Promise<T> {
  return requestPath(`/api/chains/${chain.id}/${path}`, body)
}
export async function requestPath<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new ApiError(0, 'host_unreachable') })
  // Read before the body: a busy proxy's answer may not be JSON, and its wait still counts.
  const retryAfter = retryAfterOf(response)
  // Answers contain at most fifty bounded records. A broken host must not
  // turn a small page read into an unbounded allocation.
  const result = await responseJson(response).catch((error) => {
    if (!response.ok) throw new ApiError(response.status, 'unreadable_host_answer', undefined, retryAfter)
    if (error instanceof ResponseTooLarge) throw new Error('the host answer is too large')
    if (error instanceof SyntaxError) throw new ApiError(response.status, 'unreadable_host_answer')
    throw new ApiError(0, 'host_answer_interrupted')
  })
  if (!response.ok) {
    const error = result as { error?: unknown; revert?: unknown }
    const code = typeof error?.error === 'string' && /^[a-z_]{1,80}$/.test(error.error) ? error.error : 'host_request_failed'
    const revert = typeof error?.revert === 'string' && /^0x(?:[a-fA-F0-9]{2}){0,2048}$/.test(error.revert) ? error.revert as Hex : undefined
    throw new ApiError(response.status, code, revert, retryAfter)
  }
  return result as T
}

export function integer(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid host integer')
  if (!uint64(value)) throw new Error('host integer exceeds uint64')
  return BigInt(value)
}
const address = (value: string): Address => {
  if (!wireAddress(value)) throw new Error('invalid host address')
  return value.toLowerCase() as Address
}
const hash = (value: string): Hex => {
  if (!wireHash(value)) throw new Error('invalid host hash')
  return value.toLowerCase() as Hex
}

/** Immutable identity, independently computed rather than trusting a host's pin. */
export function commitment(m: Omit<MessageRef, 'id'> & { timestamp: number }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint64' }, { type: 'uint32' }, { type: 'bytes32' }],
    [m.author, m.parentId, m.timestamp, m.contentHash],
  ))
}

export function record(m: WireRecord): RecordImage {
  const id = integer(m.id), parentId = integer(m.parent)
  const author = address(m.author), parentAuthor = address(m.parent_author)
  if (id === 0n || parentId >= id || author === zeroAddress || (parentId === 0n) !== (parentAuthor === zeroAddress)) throw new Error('invalid host message')
  if (!uint32(m.timestamp) || !Number.isSafeInteger(m.position.log) || m.position.log < 0) throw new Error('invalid host position')
  const replies = integer(m.replies)
  if (replies > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('reply count exceeds the display limit')
  const result = {
    id, parentId, author, parentAuthor, timestamp: m.timestamp, contentHash: hash(m.content_hash),
    txHash: hash(m.transaction), blockNumber: integer(m.position.block), logIndex: m.position.log,
    commitment: hash(m.commitment), gate: address(m.gate), authorGate: address(m.author_gate),
    effectiveGate: address(m.effective_gate), replies: Number(replies),
  }
  if (commitment(result) !== result.commitment || result.effectiveGate !== (result.gate === zeroAddress ? result.authorGate : result.gate)) throw new Error('inconsistent host message')
  return result
}

export const message = (chain: ChainInfo, id: bigint, ancestors = 0, pin?: Hex) =>
  request<MessageAnswer>(chain, `message/${id}?ancestors=${ancestors}${pin ? `&commit=${pin}` : ''}`)
type SnapshotAsk = {
  ids: bigint[]; accounts: Address[]; memberships: Membership[]
  resolve: (answer: Snapshot) => void; reject: (error: unknown) => void
}
const queued = new Map<string, SnapshotAsk[]>()

/** Independent card/profile reads made in one turn share a bounded snapshot. */
export function snapshots(chain: ChainInfo, ids: bigint[] = [], accounts: Address[] = [], memberships: Membership[] = []): Promise<Snapshot> {
  if (ids.length + accounts.length + memberships.length > 50) return Promise.reject(new Error('at most fifty snapshot entries'))
  const key = `${chain.id}:${chain.contract}`
  let asks = queued.get(key)
  if (!asks) {
    asks = []
    queued.set(key, asks)
    const pending = asks
    queueMicrotask(() => {
      queued.delete(key)
      let batch: SnapshotAsk[] = [], size = 0
      const flush = () => { if (batch.length) void sendSnapshot(chain, batch); batch = []; size = 0 }
      for (const ask of pending) {
        const count = ask.ids.length + ask.accounts.length + ask.memberships.length
        if (size + count > 50) flush()
        batch.push(ask); size += count
      }
      flush()
    })
  }
  return new Promise((resolve, reject) => asks.push({ ids, accounts, memberships, resolve, reject }))
}
async function sendSnapshot(chain: ChainInfo, asks: SnapshotAsk[]) {
  const ids = asks.flatMap((a) => a.ids.map(String)), accounts = asks.flatMap((a) => a.accounts), memberships = asks.flatMap((a) => a.memberships)
  try {
    const result = await request<Snapshot>(chain, 'state', { ids, accounts, memberships })
    if (result.items.length !== ids.length || result.accounts.length !== accounts.length || result.memberships.length !== memberships.length) throw new Error('incomplete host snapshot')
    let i = 0, a = 0, m = 0
    for (const ask of asks) {
      ask.resolve({ at: result.at, items: result.items.slice(i, i + ask.ids.length), accounts: result.accounts.slice(a, a + ask.accounts.length), memberships: result.memberships.slice(m, m + ask.memberships.length) })
      i += ask.ids.length; a += ask.accounts.length; m += ask.memberships.length
    }
  } catch (error) { for (const ask of asks) ask.reject(error) }
}

export const feed = (chain: ChainInfo, filter: FeedFilter, cursor: Cursor | null = null, limit = 50) =>
  request<Page>(chain, 'feed', { filter, cursor, limit })
export const replies = (chain: ChainInfo, parent: bigint, cursor: ReplyCursor | null = null, limit = 50) =>
  request<Page<ReplyCursor> & { parent: WireRecord }>(chain, 'replies', { parent: String(parent), cursor, limit })
export const references = (chain: ChainInfo, account: Address, cursor: Cursor | null = null, limit = 50, exclude_list?: List) =>
  request<Page<Cursor, WireReference>>(chain, 'references', { account, cursor, limit, exclude_list })
export type WireNotification = WireRecord & { reference: WireReference['reference'] | null }
export const notifications = (chain: ChainInfo, account: Address, cursor: Cursor | null = null, limit = 50, exclude_list?: List) =>
  request<Page<Cursor, WireNotification>>(chain, 'notifications', { account, cursor, limit, exclude_list })

type Position = { block: string; log: number }
export type ChainEvent =
  | { kind: 'posted'; message: WireMessage }
  | { kind: 'reply_gate'; id: string; old: Address; new: Address; position: Position }
  | { kind: 'author_gate'; author: Address; old: Address; new: Address; position: Position }
  | { kind: 'membership'; list: { registry: Address; owner: Address; list: Hex }; member: Address; present: boolean; position: Position }
type Change = { sequence: string; event: { kind: 'chain'; event: ChainEvent } | { kind: 'references'; id: string } }
export type ChangeScope = { feed?: FeedFilter; ids?: string[]; parents?: string[]; account?: Address; exclude_list?: List; gates?: boolean }
export type Changes = { at: At; until: At; gates: boolean; changes: Change[]; records: WireRecord[]; references: WireReference[]; through: string; more: boolean }
/** The messages posted in an answer's changes, in change order. */
export const postedIn = (answer: Pick<Changes, 'changes'>): WireMessage[] =>
  answer.changes.flatMap((c) => c.event.kind === 'chain' && c.event.event.kind === 'posted' ? [c.event.event.message] : [])
export async function changes(chain: ChainInfo, at: At, scope: ChangeScope = {}, until?: At): Promise<Changes> {
  const answer = await request<Changes>(chain, 'changes', { generation: at.generation, after: at.sequence, scope, until })
  checkChanges(at, answer)
  const expected = until ?? answer.at
  if (answer.until.generation !== expected.generation || answer.until.sequence !== expected.sequence
    || answer.until.checkpoint?.block !== expected.checkpoint?.block || answer.until.checkpoint?.hash !== expected.checkpoint?.hash
    || answer.gates !== (scope.gates ?? true)) throw new Error('host changed the refresh boundary')
  return answer
}

/**
 * The host no longer serves a view's position (a rebuilt index, or history it
 * no longer keeps), or catching up would take more pages than one refresh may
 * spend. The view starts over rather than failing.
 */
export const positionLost = (error: unknown): boolean => error instanceof ApiError
  && (error.code === 'reset_required' || error.code === 'refresh_budget_exhausted_try_again')

/** Traverse one captured range. Consumers apply a page before saving its next
 * cursor; throwing or leaving the loop never fetches another page. */
export async function* changePages(chain: ChainInfo, from: At, scope: ChangeScope = {}) {
  let until: At | undefined
  for (let n = 0; n < 200; n++) {
    const answer = await changes(chain, from, scope, until)
    until ??= answer.until
    const next = afterChanges(from, answer)
    yield { from, answer, next }
    if (!answer.more) return
    from = next
  }
  throw new ApiError(503, 'refresh_budget_exhausted_try_again')
}

/** Only a completed range certifies its checkpoint. Partial pages advance the sequence alone. */
export const afterChanges = (from: At, answer: Changes): At => ({ ...(answer.more ? from : answer.until), sequence: answer.through })

export function checkChanges(at: At, answer: Changes) {
  if (at.generation !== answer.at.generation || at.generation !== answer.until.generation) throw new ApiError(409, 'reset_required')
  let sequence = integer(at.sequence)
  const through = integer(answer.through), until = integer(answer.until.sequence)
  if (answer.changes.length > 50 || answer.records.length > 100 || answer.references.length > 100) throw new Error('host change page exceeds its limit')
  if (through < sequence || through > until || until > integer(answer.at.sequence) || (answer.more && through === sequence)) throw new Error('invalid host change range')
  for (const change of answer.changes) {
    const next = integer(change.sequence)
    if (next <= sequence || next > through) throw new Error('host changes are not ordered')
    sequence = next
  }
  if (answer.more !== (through < until)) throw new Error('incomplete host changes')
}

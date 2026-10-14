// Wallets submit transactions. The host decodes their receipts; the accepted
// index is a separate boundary, reached before a completed post opens its page.
import type { Address, Hex } from 'viem'
import * as api from './api'
import { pendingInterval } from './pending-interval'
import { sameAddress } from './format'
import { readMessage } from './messages'
import type { ChainInfo } from './types'

export type Receipt = {
  hash: Hex; status: 'success' | 'reverted'; block: string; block_hash: Hex; events: api.ChainEvent[]
}
type Transaction = Receipt | { hash: Hex; status: 'pending' }
export type TransactionProgress = (note: string) => void
export type Landed = { txHash: Hex; block: bigint; index: number | null }
export class Reverted extends Error {
  constructor(public txHash: Hex) { super(`transaction ${txHash} reverted`) }
}
const delay = (ms = 2_000) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Unreachable, overloaded or restarting hosts; anything else ends a wait at once. */
const retryable = (error: unknown): error is api.ApiError => error instanceof api.ApiError && [0, 429, 502, 503, 504].includes(error.status)

export async function transaction(chain: ChainInfo, hash: Hex): Promise<Transaction> {
  const answer = await api.request<Transaction>(chain, `transaction/${hash}`)
  if (answer.hash !== hash || !['pending', 'success', 'reverted'].includes(answer.status)) throw new Error('invalid transaction answer')
  if (answer.status !== 'pending') {
    api.integer(answer.block)
    if (!/^0x[0-9a-f]{64}$/.test(answer.block_hash) || !Array.isArray(answer.events) || answer.events.length > 4096) throw new Error('invalid receipt')
    for (const event of answer.events) {
      const position = event.kind === 'posted' ? event.message.position : event.position
      if (position.block !== answer.block || !Number.isSafeInteger(position.log) || position.log < 0) throw new Error('inconsistent receipt position')
    }
  }
  return answer
}

/** Bounded waiting. Overload backs off here; the publication owns later recovery. */
export async function awaitSuccess(chain: ChainInfo, hash: Hex, onProgress?: TransactionProgress): Promise<Receipt> {
  onProgress?.('transaction pending…')
  const { answer, busy } = await patiently(Date.now() + 120_000, async () => {
    const receipt = await transaction(chain, hash)
    if (receipt.status === 'reverted') throw new Reverted(hash)
    return receipt.status === 'success' ? receipt : null
  }, pendingInterval)
  if (answer) return answer
  if (busy) throw busy
  throw new Error('the transaction has not landed yet')
}

/**
 * Ask until `attempt` answers, `pause` apart (two seconds unless given), backing
 * off through host errors that clear on their own; other errors end it at once.
 * Past the deadline the answer is null, with the host error that stood in the
 * way of the last ask, if one did.
 */
async function patiently<T>(until: number, attempt: () => Promise<T | null>,
  pause: (unanswered: number) => number = () => 2_000): Promise<{ answer: T | null; busy?: api.ApiError }> {
  let interval = 2_000
  let unanswered = 0
  for (;;) {
    let busy: api.ApiError | undefined
    try {
      const answer = await attempt()
      if (answer !== null) return { answer }
      interval = pause(++unanswered)
    } catch (error) {
      if (!retryable(error)) throw error
      busy = error
      interval = Math.min(interval * 2, 30_000)
    }
    const remaining = until - Date.now()
    if (remaining <= 0) return { answer: null, busy }
    // Spread overloaded clients out.
    const wait = busy ? interval * (0.8 + Math.random() * 0.2) : interval
    // An unanswered ask gets a last look at the deadline; an overloaded host is not asked again.
    if (busy && wait >= remaining) {
      await delay(remaining)
      return { answer: null, busy }
    }
    await delay(Math.min(remaining, wait))
  }
}

/** The transaction has landed, so a restarting or overloaded host is waited out, not reported as a failure. */
export async function awaitIndexed(chain: ChainInfo, block: bigint, until = Date.now() + 120_000): Promise<void> {
  const { answer: indexed } = await patiently(until, async () => {
    const { at } = await api.snapshots(chain)
    return at.checkpoint && api.integer(at.checkpoint.block) >= block ? true : null
  })
  if (!indexed) throw new Error('the transaction landed. the host is still indexing its block')
}

type ExpectedPost = { author: Address; contentHash: Hex; parentId: bigint }
/** Bind a returned hash to exactly the post requested, not any event in its receipt. */
function postedEvent(receipt: Receipt, expected: ExpectedPost): api.WireMessage {
  if (receipt.status === 'reverted') throw new Reverted(receipt.hash)
  const event = receipt.events.find((e) => e.kind === 'posted'
    && sameAddress(e.message.author, expected.author) && e.message.content_hash === expected.contentHash
    && api.integer(e.message.parent) === expected.parentId)
  if (event?.kind !== 'posted' || api.integer(event.message.id) === 0n || event.message.transaction !== receipt.hash) throw new Error('the receipt does not confirm this post')
  return event.message
}

export async function awaitPosted(chain: ChainInfo, hash: Hex, expected: ExpectedPost, onProgress?: TransactionProgress): Promise<bigint> {
  const receipt = await awaitSuccess(chain, hash, onProgress)
  onProgress?.('confirmed · loading post…')
  return indexedPost(chain, receipt, expected)
}

export async function indexedPost(chain: ChainInfo, receipt: Receipt, expected: ExpectedPost): Promise<bigint> {
  const event = postedEvent(receipt, expected)
  // One window covers indexing and the read after it; neither touches the transaction again.
  const until = Date.now() + 120_000
  await awaitIndexed(chain, api.integer(receipt.block), until)
  const pin = api.commitment({ author: event.author, parentId: api.integer(event.parent), timestamp: event.timestamp, contentHash: event.content_hash })
  const { answer: read } = await patiently(until, () => readMessage(chain, api.integer(event.id), 0, pin))
  if (!read) throw new Error('the transaction landed. the host could not load the post yet')
  return read.record.id
}

export function gateResult(receipt: Receipt, subject: bigint | Address, gate: Address): Landed {
  if (receipt.status === 'reverted') throw new Reverted(receipt.hash)
  const event = receipt.events.find((e) => typeof subject === 'bigint'
    ? e.kind === 'reply_gate' && api.integer(e.id) === subject && sameAddress(e.new, gate)
    : e.kind === 'author_gate' && sameAddress(e.author, subject) && sameAddress(e.new, gate))
  if (!event || (event.kind !== 'reply_gate' && event.kind !== 'author_gate')) throw new Error('the receipt does not confirm this gate change')
  return { txHash: receipt.hash, block: api.integer(receipt.block), index: event.position.log }
}

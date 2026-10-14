// Board writes, with host-backed admission and gate reads.
import { zeroAddress, type Address, type Hex } from 'viem'
import { boardAbi } from './abi/board'
import { integer, request, snapshots } from './api'
import { signerFor } from './signer'
import { sameAddress } from './format'
import { awaitPosted, awaitSuccess, gateResult, type Landed, type TransactionProgress } from './transactions'
import type { ChainInfo, Eip1193Provider, Posted } from './types'

/** Timeline order, with the event index breaking ties inside a block. */
export const newestFirst = (x: Posted, y: Posted): number =>
  x.blockNumber === y.blockNumber ? y.logIndex - x.logIndex : y.blockNumber > x.blockNumber ? 1 : -1
export const oldestFirst = (x: Posted, y: Posted): number => -newestFirst(x, y)

/** The host calls Board.checkReply with a bounded gas allowance. */
export async function checkReply(chain: ChainInfo, parentId: bigint, replier: Address): Promise<Address> {
  const result = await request<{ gate: Address }>(chain, 'admission', { parent: String(parentId), replier })
  if (!/^0x[0-9a-f]{40}$/.test(result.gate)) throw new Error('invalid admission answer')
  return result.gate
}

/** address(1): retracted (per message) or deactivated (per author). */
export const TOMBSTONE: Address = '0x0000000000000000000000000000000000000001'
/** address(2): removed by the author of the message it answered. */
export const REMOVED: Address = '0x0000000000000000000000000000000000000002'

export type Ending = 'deleted' | 'removed' | null
export function endingOf(gate: Address | null | undefined): Ending {
  if (gate && sameAddress(gate, TOMBSTONE)) return 'deleted'
  if (gate && sameAddress(gate, REMOVED)) return 'removed'
  return null
}
/** Only an actual direct reply gives its parent's author a right of response. */
export function hasResponseRight(target: Pick<Posted, 'parentId' | 'parentAuthor'>, author: Address | null): boolean {
  return author !== null && target.parentId !== 0n && sameAddress(target.parentAuthor, author)
}

/** Deactivation closes replies only when the message inherits its author's gate. */
export function isDeactivated(own: Address | undefined, author: Address | undefined): boolean {
  return own === zeroAddress && author !== undefined && sameAddress(author, TOMBSTONE)
}
/** The one wording for each ending, wherever it is shown; the two must never be confused (CLIENT.md). */
export const ENDING_LABEL: Record<'deleted' | 'removed', string> = {
  deleted: 'deleted by its author',
  removed: 'removed by the author of the post it replied to',
}

/**
 * Send `post(...)` from the connected wallet and wait for it to land.
 * Returns the new message id from the `Posted` event. Content is NOT uploaded
 * here: the caller can begin publishing at `onSent` (transaction first, then
 * upload — DESIGN.md §3).
 */
export async function post(
  provider: Eip1193Provider,
  account: Address,
  chain: ChainInfo,
  args: { contentHash: Hex; parentId: bigint; replyGate?: Address },
  /** Called when the wallet returns a transaction hash, before waiting for its receipt. */
  onSent?: (txHash: Hex) => void,
  /** Awaited immediately before the wallet receives the send request. */
  beforeSend?: () => Promise<void>,
  onProgress?: TransactionProgress,
): Promise<{ id: bigint; txHash: Hex }> {
  const wallet = await signerFor(provider, account, chain, beforeSend)
  const call = {
    address: chain.contract,
    abi: boardAbi,
    functionName: 'post',
    args: [args.contentHash, args.parentId, args.replyGate ?? zeroAddress, '0x'],
  } as const
  const estimate = await request<{ gas: string }>(chain, 'post-estimate', {
    author: account, content_hash: args.contentHash, parent: String(args.parentId), reply_gate: args.replyGate ?? zeroAddress,
  })
  const gas = integer(estimate.gas)
  if (gas === 0n || gas > 500_000n) throw new Error('the host returned an excessive gas estimate')
  const txHash = await wallet.writeContract({ ...call, gas })
  onSent?.(txHash)
  const id = await awaitPosted(chain, txHash, { author: account, contentHash: args.contentHash, parentId: args.parentId }, onProgress)
  return { id, txHash }
}

/** Tombstone one of your messages: permanent (DESIGN.md §5.6). */
export function tombstone(
  provider: Eip1193Provider,
  account: Address,
  chain: ChainInfo,
  id: bigint,
  onProgress?: TransactionProgress,
  onSent?: (hash: Hex) => void,
): Promise<Landed> {
  return setReplyGate(provider, account, chain, id, TOMBSTONE, onProgress, onSent)
}

/** Remove a reply to one of your messages: permanent, and recorded as yours (DESIGN.md §5.6). */
export function removeReply(
  provider: Eip1193Provider,
  account: Address,
  chain: ChainInfo,
  id: bigint,
  onProgress?: TransactionProgress,
  onSent?: (hash: Hex) => void,
): Promise<Landed> {
  return setReplyGate(provider, account, chain, id, REMOVED, onProgress, onSent)
}

/** Change a message rule and verify the confirmed gate event. `onSent` hears the hash before the receipt wait. */
export async function setReplyGate(
  provider: Eip1193Provider,
  account: Address,
  chain: ChainInfo,
  id: bigint,
  gate: Address,
  onProgress?: TransactionProgress,
  onSent?: (hash: Hex) => void,
): Promise<Landed> {
  onProgress?.('check your wallet…')
  const wallet = await signerFor(provider, account, chain)
  const txHash = await wallet.writeContract({
    address: chain.contract,
    abi: boardAbi,
    functionName: 'setReplyGate',
    args: [id, gate],
  })
  onSent?.(txHash)
  return gateResult(await awaitSuccess(chain, txHash, onProgress), id, gate)
}

/** The author's account-wide default gate (zero when unset). */
export async function authorGate(chain: ChainInfo, author: Address): Promise<Address> {
  const result = await snapshots(chain, [], [author])
  const item = result.accounts[0]
  if (!item || !sameAddress(item.address, author) || !/^0x[0-9a-f]{40}$/.test(item.gate)) throw new Error('invalid author gate answer')
  return item.gate
}

/** Point the connected account's author gate at `gate` (zero clears it). Resolves once mined; `onSent` hears the hash first. */
export async function setAuthorGate(
  provider: Eip1193Provider,
  account: Address,
  chain: ChainInfo,
  gate: Address,
  onProgress?: TransactionProgress,
  onSent?: (hash: Hex) => void,
): Promise<Landed> {
  onProgress?.('check your wallet…')
  const wallet = await signerFor(provider, account, chain)
  const txHash = await wallet.writeContract({ address: chain.contract, abi: boardAbi, functionName: 'setAuthorGate', args: [gate] })
  onSent?.(txHash)
  return gateResult(await awaitSuccess(chain, txHash, onProgress), account, gate)
}

// The host's relayer (relay/), reachable on the same origin at /api/relay.
// It sponsors eligible posts and replies.
// For a post, the author signs
// the post instead of sending a transaction, and gets a transaction hash
// back to treat exactly like their own (CLIENT.md).
import type { Address, Hex } from 'viem'
import { sponsorName } from './sponsor-name'
import { errorMessage, responseJson, retryAfter } from '../../shared/response-json'

/** What the faucet would give `address` now, and whether it would. */
type FaucetStatus = { amount_eth: number; balance_eth: string; eligible: boolean; reason: string | null }

/**
 * An answer from the relayer or faucet that is not success, decoded once
 * (`failure`) into one of the three kinds below. `status` is 0 when no HTTP
 * answer was read.
 */
export abstract class RelayError extends Error {
  abstract readonly outcome: 'refused' | 'unknown'
  constructor(
    message: string,
    public status = 0,
    /** Milliseconds from `Retry-After`: the relayer marks a refusal that passes this way. */
    public retryAfter: number | null = null,
  ) {
    super(message)
  }
}
/** A definite refusal of this request. Callers may offer a paid fallback. */
export class RelayDeclined extends RelayError { readonly outcome = 'refused' }
/** Nothing was sent, and the same request may succeed in a moment: the relayer is busy or pacing this network. Not a decline, so the sponsored option stays. */
export class RelayBusy extends RelayError { readonly outcome = 'refused' }
/** No verified outcome yet: the request may have gone through. Keep recovery material, including after a receipt failure. */
export class RelayUnknown extends RelayError { readonly outcome = 'unknown' }

/** A signed `Post`, numbers as decimal strings so JSON carries them intact. */
export type SignedPost = {
  author: Address
  contentHash: Hex
  parentId: string
  replyGate: Address
  nonce: string
  deadline: string
  sig: Hex
  gateData: Hex
}

/**
 * Only the service's explicit refusal permits fallback. An answer without
 * that field, including a proxy error, leaves the outcome unknown regardless
 * of status. A refusal that passes is busy: the relayer is unavailable for now
 * (503), or this network is going too fast (429 with `Retry-After`). A 429
 * without it, such as a spent daily quota, is a decline.
 */
async function failure(res: Response): Promise<RelayError> {
  const answer = await responseJson(res).catch(() => null)
  const refused = answer !== null && typeof answer === 'object' && 'outcome' in answer && answer.outcome === 'refused'
  const message = errorMessage(res, answer), wait = retryAfter(res)
  if (!refused) return new RelayUnknown(message, res.status, wait)
  const busy = res.status === 503 || (res.status === 429 && wait !== null)
  return busy ? new RelayBusy(message, res.status, wait) : new RelayDeclined(message, res.status, wait)
}

/** A signed post returns a hash, or an explicit outcome needing recovery. */
export async function relayPost(chainId: number, signed: SignedPost): Promise<{ tx_hash: Hex }> {
  let res: Response
  try {
    const name = sponsorName(chainId, signed.author)
    const query = name ? `?${new URLSearchParams({ name })}` : ''
    res = await fetch(`/api/relay/${chainId}/post${query}`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    })
  } catch {
    throw new RelayUnknown('could not reach the relayer')
  }
  if (!res.ok) throw await failure(res)
  try {
    const answer = await responseJson(res) as { tx_hash?: unknown }
    if (typeof answer?.tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(answer.tx_hash)) throw new Error('missing transaction hash')
    return { tx_hash: answer.tx_hash as Hex }
  } catch {
    throw new RelayUnknown('the relayer answered, but unreadably')
  }
}

/** Ask the faucet about an address: the drip, the address's balance, and whether it would be served now. */
export async function faucetStatus(chainId: number, address: Address): Promise<FaucetStatus> {
  const res = await fetch(`/api/relay/${chainId}/faucet/${address}`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw await failure(res)
  return (await responseJson(res)) as FaucetStatus
}

/** What to tell the reader when the faucet's answer never came, or could not be read: the send may have happened. */
export const FAUCET_OUTCOME_UNKNOWN = 'the ether may still arrive. check your balance before asking again'

/**
 * Ask the faucet for a drip to `address`; the transaction hash comes back.
 * A lost, timed-out or unreadable answer is an unknown outcome, never a
 * refusal: the request may have gone through before the answer was lost.
 */
export async function requestFaucet(chainId: number, address: Address): Promise<{ tx_hash: Hex; amount_eth: number }> {
  let res: Response
  try {
    res = await fetch(`/api/relay/${chainId}/faucet`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    })
  } catch {
    throw new RelayUnknown(`could not reach the faucet. ${FAUCET_OUTCOME_UNKNOWN}`)
  }
  if (!res.ok) {
    const error = await failure(res)
    if (error instanceof RelayUnknown) error.message += `. ${FAUCET_OUTCOME_UNKNOWN}`
    throw error
  }
  try {
    const answer = await responseJson(res) as { tx_hash?: unknown; amount_eth?: unknown }
    if (typeof answer?.tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(answer.tx_hash) || typeof answer.amount_eth !== 'number' || !Number.isFinite(answer.amount_eth) || answer.amount_eth <= 0) throw new Error('invalid faucet answer')
    return { tx_hash: answer.tx_hash as Hex, amount_eth: answer.amount_eth }
  } catch {
    throw new RelayUnknown(`the faucet answered, but the answer could not be read. ${FAUCET_OUTCOME_UNKNOWN}`)
  }
}

export type SponsorEligibility = {
  eligible: boolean
  reason: 'curated' | 'ens' | 'basename' | null
  posting_available?: boolean
  posting_paused_reason?: string | null
}

/** Advisory eligibility and availability; submission repeats the checks. */
export async function sponsorEligibility(chainId: number, address: Address, name?: string): Promise<SponsorEligibility> {
  const query = name ? `?${new URLSearchParams({ name })}` : ''
  const res = await fetch(`/api/relay/${chainId}/eligibility/${address}${query}`, { signal: AbortSignal.timeout(20_000) })
  const answer = await responseJson(res)
  if (!res.ok) throw new Error(errorMessage(res, answer))
  const a = answer as { address?: unknown; eligible?: unknown; reason?: unknown; posting_available?: unknown; posting_paused_reason?: unknown }
  if (typeof a.address !== 'string' || a.address.toLowerCase() !== address.toLowerCase()
    || typeof a.eligible !== 'boolean'
    || (a.eligible ? !['curated', 'ens', 'basename'].includes(String(a.reason)) : a.reason !== null)) {
    throw new Error('invalid sponsorship eligibility response')
  }
  if (a.posting_available !== undefined && (typeof a.posting_available !== 'boolean'
    || (a.posting_paused_reason !== null && typeof a.posting_paused_reason !== 'string')
    || (a.posting_available && (!a.eligible || a.posting_paused_reason !== null)))) {
    throw new Error('invalid sponsorship availability response')
  }
  return { eligible: a.eligible, reason: a.reason as SponsorEligibility['reason'],
    posting_available: a.posting_available as boolean | undefined,
    posting_paused_reason: a.posting_paused_reason as string | null | undefined }

}

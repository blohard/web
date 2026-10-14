// Recovery keeps uncertain sends until they are found on-chain or explicitly
// discarded. A resend refusal or an expired signature cannot settle an earlier send.
import { sameDeployment } from '../../lib/chains'
import { explain } from '../../lib/errors'
import { indexedPost, Reverted, transaction } from '../../lib/transactions'
import * as api from '../../lib/api'
import { rememberMessages } from '../../lib/messages'
import type { Proof } from '../../lib/store'
import { sameAddress } from '../../lib/format'
import { deletePending, updatePending, type PendingPost } from './pending'
import { uploadPost } from './posting'
import { RelayBusy, RelayDeclined, relayPost } from './relay'
import type { ChainInfo } from '../../lib/types'

/** A saved post may only be resumed on the chain and Board it was made for. */
export function checkChain(chain: ChainInfo, post: PendingPost): void {
  if (!sameDeployment(chain, post.chainId, post.contract ?? chain.contract)) throw new Error('this record belongs to another chain or Board')
}

// Give a newly submitted wallet transaction its normal receipt wait before
// checking for a speed-up under another hash. This clock limits extra work;
// the search range always comes from the saved accepted block, never time.
const WALLET_LOOKUP_AFTER = 120_000

/** Also used before discard: never discard bytes for a post we can find. */
export async function resolvePendingId(chain: ChainInfo, post: PendingPost): Promise<bigint | null> {
  checkChain(chain, post)
  if (post.messageId !== null) return post.messageId
  if (post.txHash) {
    const receipt = await transaction(chain, post.txHash)
    if (receipt.status !== 'pending') {
      const id = await indexedPost(chain, receipt, { author: post.author, contentHash: post.bodyHash, parentId: post.parentId })
      await updatePending(post, { messageId: id, lookup: undefined }).catch(() => {})
      return id
    }
    // Wallets can replace a transaction without reporting the new hash to the
    // app. Signed submissions instead recover their hash from the journal.
    if (post.signed || Date.now() - post.createdAt < WALLET_LOOKUP_AFTER) return null
  }
  const fromBlock = post.fromBlock ?? BigInt(chain.start_block)
  const lookup = () => api.request<api.Page>(chain, 'lookup', {
    author: post.author, content_hash: post.bodyHash, parent: String(post.parentId),
    from_block: String(fromBlock), cursor: post.lookup?.cursor ?? null, limit: 1,
  })
  let page: api.Page
  try {
    page = await lookup()
  } catch (e) {
    // A rebuilt index refuses a position in its old history: scan the saved range again.
    if (!post.lookup || !api.positionLost(e)) throw e
    await updatePending(post, { lookup: undefined }).catch(() => {})
    page = await lookup()
  }
  const rows = page.items.map(api.record)
  if (rows.length > 1 || rows.some((r) => !sameAddress(r.author, post.author) || r.contentHash !== post.bodyHash || r.parentId !== post.parentId || r.blockNumber < fromBlock)) throw new Error('invalid publication lookup')
  rememberMessages(chain, page.at, rows)
  const cursor = post.lookup?.cursor
  if (page.next && (page.next.generation !== page.at.generation || (cursor && (page.next.filter !== cursor.filter
    || page.next.ceiling !== cursor.ceiling || api.integer(page.next.before) >= api.integer(cursor.before))))) throw new Error('invalid publication cursor')
  const hit = rows[0]
  if (hit) {
    await updatePending(post, { messageId: hit.id, txHash: hit.txHash, lookup: undefined }).catch(() => {})
    return hit.id
  }
  // The host indexes accepted history only. Finish the captured range before
  // advancing, so posts arriving between lookup pages cannot be skipped.
  const throughBlock = post.lookup?.throughBlock ?? (page.at.checkpoint ? api.integer(page.at.checkpoint.block) : fromBlock - 1n)
  if (page.next) await updatePending(post, { lookup: { cursor: page.next, throughBlock } }).catch(() => {})
  else await updatePending(post, { lookup: undefined, fromBlock: throughBlock + 1n > fromBlock ? throughBlock + 1n : fromBlock }).catch(() => {})
  return null
}

export type Recovery = { note: string; done?: boolean }
const checkAgain = (note: string): Recovery => ({ note: `${note}. checking again automatically` })

export async function recoverPost(chain: ChainInfo, post: PendingPost, manual = false): Promise<Recovery> {
  checkChain(chain, post)
  let id: bigint | null = null, lookupError: unknown
  try { id = await resolvePendingId(chain, post) } catch (e) {
    if (e instanceof Reverted) throw e
    // A chain outage need not prevent the relayer from recovering a hash.
    lookupError = e
  }
  let proof: Proof | null = id !== null ? { messageId: id } : post.txHash ? { txHash: post.txHash } : null
  let relayNote: string | undefined
  if (id === null && post.signed) {
    if (manual && post.relayPaused) await updatePending(post, { relayPaused: false }).catch(() => {})
    if (post.relayPaused) relayNote = 'automatic resubmission is paused. the first attempt may still land. retry to ask the relayer again'
    else try {
      // A missing receipt cannot distinguish pending from dropped. Recheck on
      // this publication's backoff, even with a hash or expired signature:
      // the journal answers existing attempts before validating a fresh send.
      const { tx_hash: txHash } = await relayPost(chain.id, post.signed)
      await updatePending(post, { txHash }).catch(() => {})
      proof = { txHash }
    } catch (e) {
      if (e instanceof RelayDeclined || e instanceof RelayBusy) {
        const relayPaused = e instanceof RelayDeclined
        await updatePending(post, { relayPaused }).catch(() => {})
        relayNote = `the relayer refused (${e.message}). ${relayPaused ? 'automatic resubmission is paused. chain checks continue' : 'it is unavailable for now'}. an earlier attempt may still land`
      } else relayNote = 'the relayer could not confirm the outcome. the post may still land'
    }
  }
  if (!proof) {
    if (relayNote) return checkAgain(relayNote)
    if (lookupError) return checkAgain(`could not look for the post (${explain(lookupError)})`)
    if (post.lookup?.cursor) return checkAgain('still looking through the saved range for this post')
    const ageMin = Math.floor((Date.now() - post.createdAt) / 60_000)
    if (ageMin >= 60 && !post.walletSubmitted) {
      await deletePending(post.key)
      return { note: 'done', done: true }
    }
    if (ageMin < 10) return checkAgain(`waiting for a transaction to land, saved ${ageMin} min ago`)
    return checkAgain(`no transaction found for this post after ${ageMin} min. if you never sent it, discard it`)
  }
  await uploadPost(post, proof)
  const result = uploadResult(post)
  if (id === null && relayNote) return checkAgain(relayNote)
  return id === null && result.done ? checkAgain('the bytes are stored. waiting for the transaction receipt') : result
}

/** Classify a completed upload pass and release only the bytes confirmed stored. */
export function uploadResult(post: PendingPost): Recovery {
  post.records = post.records.filter((r) => r.status !== 'stored')
  const failed = post.records.find((r) => r.status === 'failed')
  if (failed) return checkAgain(`${failed.kind === 'body' ? 'the body' : failed.name} failed to upload. ${failed.error}`)
  const held = post.records.filter((r) => r.status === 'held').length
  if (held) return checkAgain(`the host holds ${held} record${held > 1 ? 's' : ''} until the chain confirms the post`)
  return { note: 'done', done: true }
}

import { allowHostPosting } from '../../lib/host-policy'
// Getting a post out: the transaction first, then the bytes to the host
// (CLIENT.md). Save recovery material before sending; if the browser
// refuses, warn and continue.
import { BaseError, UserRejectedRequestError, zeroAddress, type Address, type Hex } from 'viem'
import { currentPostReplyGate } from '../account/post-reply-rule'
import { checkReply, post } from '../../lib/board'
import { signPost } from './sign-post'
import { explain } from '../../lib/errors'
import { awaitPosted, Reverted } from '../../lib/transactions'
import { integer, snapshots } from '../../lib/api'
import { fetchContent, hashOf, publishWithRetry, utf8, type Proof } from '../../lib/store'
import { chainLabel } from '../../lib/chains'
import { encode, TEXT } from '../../lib/envelope'
import { deletePending, recordUploaded, savePending, updatePending, type PendingPost, type PostRecord } from './pending'
import { RelayUnknown, relayPost } from './relay'
import type { ChainInfo } from '../../lib/types'
import type { wallet } from '../../lib/wallet.svelte'

/** What goes on-chain and to the host for `text`: the envelope header plus the exact text. */
export function bodyBytes(text: string): Uint8Array {
  return encode(TEXT, utf8.encode(text))
}

export function bodyRecord(text: string): PostRecord {
  const bytes = bodyBytes(text)
  return { kind: 'body', name: 'body', mediaType: TEXT, bytes, hash: hashOf(bytes), status: 'pending' }
}

export type PostArgs = {
  chain: ChainInfo
  wallet: typeof wallet
  parentId: bigint
  /** This post’s own rule; omitted means follow the author’s account default. */
  replyGate?: Address
  pending: PendingPost
  /** Sign for the host's relayer instead of sending from the wallet. */
  sponsored: boolean
  /** Progress, in words, for the status line. */
  onNote: (note: string) => void
  /** Something worth keeping on screen past the next progress note: recovery material that could not be saved. */
  onWarn: (warning: string) => void
}

// The failed attempt has no remaining recovery work. Unknown sends are never forgotten here.
export function canForgetFailedPost(post: PendingPost, error: unknown): boolean {
  if (error instanceof Reverted) return true
  if (post.txHash !== null || error instanceof RelayUnknown) return false
  if (!post.walletSubmitted) return true
  // Only the wallet's explicit rejection proves this attempted send did not go out.
  return error instanceof BaseError && error.walk((e) => e instanceof UserRejectedRequestError) instanceof UserRejectedRequestError
}

/** Send and upload, starting the first pass as soon as a transaction is known. */
export async function publishPost(args: PostArgs): Promise<bigint> {
  const p = args.pending
  let early: Promise<void> = Promise.resolve()
  try {
    const id = await sendPost(args, (txHash) => { early = uploadPost(p, { txHash }) })
    args.onNote('confirmed · uploading post…')
    await early
    await uploadPost(p, { messageId: id }, args.onNote)
    return id
  } catch (e) {
    await early
    if (canForgetFailedPost(p, e)) {
      await deletePending(p.key).catch(() => {})
    }
    throw e
  }
}

async function sendPost(
  { chain, wallet, parentId, replyGate = zeroAddress, pending: p, sponsored, onNote, onWarn }: PostArgs,
  onSent: (txHash: Hex) => void,
): Promise<bigint> {
  const { provider, account } = wallet
  if (!provider || !account) throw new Error('connect a wallet first')
  const contentHash = p.bodyHash
  onNote(parentId !== 0n ? 'checking whether you can reply…' : 'preparing your post…')
  // Three independent reads, asked together: the Board's admission
  // decision, the block the post's search starts from, and the
  // reply rule. Failures are reported in that order, whichever answers first.
  const [admitted, head, rule] = await Promise.allSettled([
    parentId !== 0n ? checkReply(chain, parentId, account) : Promise.resolve(zeroAddress as Address),
    snapshots(chain),
    currentPostReplyGate(chain, account, replyGate),
  ])
  for (const read of [admitted, head, rule]) if (read.status === 'rejected') throw read.reason
  const { at } = (head as PromiseFulfilledResult<Awaited<ReturnType<typeof snapshots>>>).value
  const checkedGate = (rule as PromiseFulfilledResult<Address>).value
  if (checkedGate !== replyGate) onWarn('the selected reply rule is no longer available. this post uses your account default')
  // Save everything before the wallet is asked: once the transaction is
  // sent the bytes must outlive this tab (CLIENT.md).
  p.contract = chain.contract
  p.parentId = parentId
  p.fromBlock = at.checkpoint ? integer(at.checkpoint.block) : BigInt(chain.start_block)
  await savePending(p).catch((e) => {
    console.warn('could not save pending uploads locally', e)
    onWarn('this browser refused to keep a copy of the post. if the upload fails, you will have to post again')
  })

  // The network check comes last before signing; the signer checks the account on each request.
  // A sponsored post is a signature the relayer sends: the wallet's own RPC does not matter for it.
  if (wallet.chainId !== chain.id) onNote(`switch to ${chainLabel(chain)}…`)
  else if (!sponsored) onNote('checking wallet connection…')
  await wallet.ensureChain(chain, sponsored ? 'optional' : 'required')
  await allowHostPosting(account)

  const sent = (txHash: Hex) => {
    void updatePending(p, { txHash }).catch(() => {})
    onSent(txHash)
  }
  const args = { contentHash, parentId, replyGate: checkedGate }
  let r: { id: bigint; txHash: Hex }
  if (sponsored) {
    // Sign, hand to the relayer, then treat its transaction as our own.
    onNote('sign in your wallet…')
    const signed = await signPost(provider, account, chain, args)
    // Kept with the saved bytes: recovery resends this same signature
    // instead of asking for a new one.
    await updatePending(p, { signed }).catch((e) => {
      console.warn('could not save the signed request locally', e)
      onWarn("this browser refused to keep the signed request. if the relayer's answer is lost, this post cannot be resent and you would have to post again")
    })
    onNote('sending to the relayer…')
    // A refusal is an answer, RelayDeclined or RelayBusy. An outcome the
    // relayer does not know, or an answer this client could not read, is
    // RelayUnknown: the post may have gone out (features/publishing/relay.ts).
    const relayed = await relayPost(chain.id, signed)
    sent(relayed.tx_hash)
    r = { id: await awaitPosted(chain, relayed.tx_hash, { author: account, contentHash, parentId }, onNote), txHash: relayed.tx_hash }
  } else {
    onNote('confirm in your wallet…')
    r = await post(provider, account, chain, args, sent, async () => {
      if (p.walletSubmitted) return
      await updatePending(p, { walletSubmitted: true }).catch((e) => {
        console.warn('could not save the wallet submission locally', e)
        onWarn('this browser refused to save the wallet submission. keep this tab open until the post is stored')
      })
    }, onNote)
  }
  await updatePending(p, { messageId: r.id }).catch(() => {})
  return r.id
}

/**
 * One pass over every record the host has not stored yet, the body first,
 * with the retries https://github.com/blohard/host/blob/main/STORE_API.md asks for. Each record's
 * `status` and `error`
 * take the outcome, and the pending store follows: a stored record is
 * forgotten, a held one kept and marked held. A body that fails ends the
 * pass; its attachments wait for the next one. Never throws.
 */
export async function uploadPost(
  post: PendingPost,
  proof: Proof,
  onNote?: (note: string) => void,
): Promise<void> {
  for (const r of post.records) {
    if (r.status === 'stored') continue
    const wasHeld = r.status === 'held'
    r.status = 'uploading'
    onNote?.(r.kind === 'body' ? `${'messageId' in proof ? 'confirmed · ' : ''}uploading post…` : 'uploading image…')
    try {
      // A held record may have been promoted while we waited for the
      // receipt. Verify the stored bytes before discarding our recovery copy,
      // at the address the page then reads them from, so the browser cache
      // answers that read instead of a second download.
      // If the host lacks the bytes, this anchored read may wait for peers
      // before we upload our local copy. No peers means no extra wait.
      const stored = wasHeld && 'messageId' in proof
        && (await fetchContent(r.hash, { chainId: post.chainId, messageId: proof.messageId })).ok
      const res = stored ? { held: false } : await publishWithRetry(r.bytes, post.chainId, proof, r.hash)
      r.status = res.held ? 'held' : 'stored'
      r.error = undefined
      await recordUploaded(post.key, r.hash, res.held).catch(() => {})
    } catch (e) {
      r.status = 'failed'
      r.error = explain(e)
      if (r.kind === 'body') return
    }
  }
}

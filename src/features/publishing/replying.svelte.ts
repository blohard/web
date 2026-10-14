// The reply box open on a page: one at a time, directly under the card whose
// reply was pressed, kept for the page in tab memory so that coming back to
// it, by Back, Forward or a fresh link, finds the box where it was.
//
// The draft belongs to the post it answers, not to the page: every page's box
// for that post shows the same draft, so a reply begun in a stream carries to
// the post's thread and back. Sending it or closing a box clears it, which
// closes every box open on that post.
import { DraftBox } from './draft-box.svelte'
import { router } from '../navigation/router.svelte'
import type { ChainInfo, MessageRef } from '../../lib/types'
import { endingOf } from '../../lib/board'
import { gates } from '../../lib/gates.svelte'

/** Drafts by the post they answer, the most recently used last; the oldest go once there are many. */
const drafts = new Map<string, ReplyDraft>()
const KEEP = 100
const keyOf = (chainId: number, id: bigint) => `${chainId}/${id}`

function draftFor(chainId: number, id: bigint): ReplyDraft {
  const key = keyOf(chainId, id)
  let d = drafts.get(key)
  if (!d) {
    d = new ReplyDraft(chainId, id)
    if (drafts.size >= KEEP) evictOne()
  } else drafts.delete(key)
  drafts.set(key, d)
  return d
}

/** The least recently used draft that is not being sent: a send in flight keeps its draft, and so its lock. */
function evictOne() {
  for (const [key, d] of drafts) {
    if (!d.sending) {
      drafts.delete(key)
      return
    }
  }
}

/** A reply is being written to this post, on some page: it has text or an attachment. */
export function hasDraft(chainId: number, id: bigint): boolean {
  const d = drafts.get(keyOf(chainId, id))
  return !!d && (d.draft.text.trim() !== '' || d.draft.attachments.length > 0)
}

/** One post's reply draft, shared by every box open on it. */
class ReplyDraft extends DraftBox {
  constructor(readonly chainId: number, readonly id: bigint) { super() }

  /** A send or a close: the draft goes, and so does every box showing it. */
  override clear(): void {
    super.clear()
    const key = keyOf(this.chainId, this.id)
    const current = drafts.get(key) === this
    if (current) drafts.delete(key)
    // A box on this post shows this draft only while it is the post's current one.
    if (current) for (const box of boxes.values()) if (box.is(this.chainId, this.id)) box.detach()
  }
}

export class Box {
  chainId = $state<number | null>(null)
  id = $state<bigint | null>(null)
  /** Counts presses, so a repeat press focuses the editor again. */
  press = $state(0)
  /** The press whose reveal has run: a box mounted again for the same press stays where the page is. */
  shown = 0
  /** What the last press asked for; without a wallet the line under the card says so. */
  intent = $state<'reply' | 'quote'>('reply')
  /** A quote the page finished after a wallet connected, which failed: said under the post, with a retry. */
  quoteFailure = $state.raw<{ shown: MessageRef; text: string } | null>(null)
  is(chainId: number, id: bigint): boolean {
    return this.chainId === chainId && this.id === id
  }

  /** The editor or connect prompt is shown here unless the post has ended. */
  visible(chain: ChainInfo, id: bigint): boolean {
    return this.is(chain.id, id) && !endingOf(gates.message(chain, id))
  }

  /** The draft of the post this box is open under, shared with other pages' boxes for it; null while closed. */
  get reply(): ReplyDraft | null {
    return this.chainId === null || this.id === null ? null : draftFor(this.chainId, this.id)
  }

  /**
   * Open the box under a card, or press again on the one already open. Moving
   * the box to another card keeps the draft it left, for when it comes back.
   */
  open(chainId: number, id: bigint, intent: 'reply' | 'quote' = 'reply'): void {
    if (!this.is(chainId, id)) {
      this.chainId = chainId
      this.id = id
    }
    this.intent = intent
    this.quoteFailure = null
    this.press++
  }

  /** Close means discard: the draft goes, and every box open on its post closes. */
  close(): void {
    const reply = this.reply
    if (reply) reply.clear()
    else this.detach()
  }

  /** Close this box only, leaving drafts alone: its draft was sent or discarded. */
  detach(): void {
    this.chainId = null
    this.id = null
    this.quoteFailure = null
  }
}

/** Boxes by page, the most recently used last; the oldest go once there are many. */
const boxes = new Map<string, Box>()

class Replying {
  /** The box of a page: the one on screen unless a page is named, for a mount that must keep its own past a navigation. */
  box(page: string = router.page): Box {
    let b = boxes.get(page)
    if (!b) {
      b = new Box()
      if (boxes.size >= KEEP) boxes.delete(boxes.keys().next().value!)
    } else boxes.delete(page)
    boxes.set(page, b)
    return b
  }

  /** ↳ reply, or quote without a wallet, pressed on the page on screen. */
  open(chainId: number, id: bigint, intent: 'reply' | 'quote' = 'reply'): void {
    this.box().open(chainId, id, intent)
  }
}

export const replying = new Replying()

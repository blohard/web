// One live operation per publication, shared by the composer and pending list.
// Components own presentation and navigation, never the send or its submitted draft.
// Lifetimes and transitions: web/STATE.md.
import { RelayBusy, RelayDeclined, RelayUnknown } from './relay'
import { acceptPublication } from '../streams/feed'
import { explain } from '../../lib/errors'
import { Reverted } from '../../lib/transactions'
import type { DraftBox } from './draft-box.svelte'
import { decode } from '../../lib/envelope'
import { utf8 } from '../../lib/store'
import { shortHex } from '../../lib/format'
import { deletePending, listPending, type PendingPost } from './pending'
import { canForgetFailedPost, publishPost, type PostArgs } from './posting'
import { checkChain, recoverPost, resolvePendingId, uploadResult, type Recovery } from './recovery'
import type { ChainInfo } from '../../lib/types'

type Result = Recovery & { cleared: boolean }
type Outcome = { kind: 'progress' | 'ok' | 'err'; note: string; id: bigint | null; txHash: PendingPost['txHash'] }
type Send = Omit<PostArgs, 'pending' | 'onNote' | 'onWarn'>
type Accepted = (chain: ChainInfo, id: bigint, parentId: bigint) => Promise<void>
type Schedule = (work: () => void, delay: number) => () => void
const later: Schedule = (work, delay) => {
  const timer = setTimeout(work, delay)
  return () => clearTimeout(timer)
}
const FIRST_RETRY = 15_000
const MAX_RETRY = 180_000

export class Publication {
  post = $state<PendingPost>()!
  busy = $state(false)
  done = $state(false)
  outcome = $state<Outcome | null>(null)
  warning = $state<string | null>(null)
  /** The transaction reverted after its draft let go of the words: kept, not retried, until discarded. */
  reverted = $state(false)
  private flight: Promise<Result> | null = null
  private owner: { box: DraftBox; version: number; onposted?: (id: bigint) => void } | null = null
  private sent = false
  private announced = false
  private chain: ChainInfo | null = null
  private cancelRetry: (() => void) | null = null
  private delay = FIRST_RETRY

  constructor(post: PendingPost, private retire: () => void, private schedule: Schedule, private accepted: Accepted) { this.post = post }

  owns(box: DraftBox): boolean { return this.owner?.box === box && box.holds(this.owner.version) }
  get needsUpload(): boolean { return !this.done && this.post.messageId !== null && this.post.records.some((r) => r.status === 'failed') }

  /** The words of the post, for a copy that is the only one left. */
  get text(): string {
    const body = this.post.records.find((r) => r.kind === 'body')
    const decoded = body ? decode(body.bytes) : null
    return decoded?.ok ? utf8.decode(decoded.envelope.body) : ''
  }

  private say(kind: Outcome['kind'], note: string): void {
    this.outcome = { kind, note, id: this.post.messageId, txHash: this.post.txHash }
  }

  private release(clear: boolean, announce = false): boolean {
    const owner = this.owner
    this.owner = null
    if (!owner) return false
    if (clear) {
      const cleared = owner.box.finish(owner.version)
      // Deliver synchronously: clearing an inline box unmounts its composer.
      if (cleared && announce && this.post.messageId !== null) {
        try { owner.onposted?.(this.post.messageId) } catch (e) { console.warn('could not reveal the posted message', e) }
      }
      return cleared
    }
    owner.box.fail(owner.version)
    return false
  }

  /** A request made while working joins that work, even from another mount. */
  private run(work: () => Promise<Recovery>, initial?: Send): Promise<Result> {
    if (this.flight) return this.flight
    if (this.done) return Promise.resolve({ note: 'done', done: true, cleared: false })
    this.cancelRetry?.()
    this.cancelRetry = null
    this.busy = true
    const flight = Promise.resolve().then(work).then((result) => {
      // The body is enough to display the post; attachment recovery can continue.
      if (!this.announced && this.chain && this.post.messageId !== null
        && !this.post.records.some(r => r.kind === 'body' && r.status !== 'stored' && r.status !== 'held')) {
        this.announced = true
        void this.accepted(this.chain, this.post.messageId, this.post.parentId)
          .catch(e => console.warn('could not update saved streams', e))
      }
      const accepted = this.post.messageId !== null && this.post.records.every((r) => r.status === 'stored' || r.status === 'held')
      const cleared = accepted ? this.release(true, true) : false
      // An incomplete upload remains attached to this draft, but retry must be usable.
      if (!accepted && this.owner) this.owner.box.fail(this.owner.version)
      this.say(accepted ? 'ok' : 'err', result.done && accepted ? `stored as ${shortHex(this.post.bodyHash)}` : result.note)
      if (result.done) this.finish()
      return { ...result, cleared }
    }).catch(async (e: unknown) => {
      const reverted = e instanceof Reverted
      // Nothing was posted. The words go back to a composer still holding
      // them; otherwise this saved copy is the only one, and stays.
      const heldDraft = !!this.owner && this.owner.box.holds(this.owner.version)
      this.release(this.post.txHash !== null && !reverted)
      this.say('err', initial ? this.sendError(e, initial.parentId) : explain(e))
      if (reverted && heldDraft) {
        await deletePending(this.post.key).catch(() => {})
        this.finish()
      } else if (reverted) {
        this.reverted = true
        this.say('err', `${explain(e)}. nothing was posted. the words are kept here until you discard them`)
      } else if (initial && canForgetFailedPost(this.post, e)) this.finish()
      throw e
    }).finally(() => {
      this.busy = false
      this.flight = null
      this.scheduleNext()
    })
    this.flight = flight
    return flight
  }

  private finish(): void {
    this.cancelRetry?.()
    this.cancelRetry = null
    this.release(false)
    this.done = true
    this.post.records = []
    this.retire()
  }

  publish(args: Send, box: DraftBox, onposted?: (id: bigint) => void): Promise<Result> {
    if (this.flight) return this.flight
    // This operation never signs twice. A later press on it means recovery.
    if (this.sent) return this.retry(args.chain)
    this.sent = true
    this.owner = { box, version: box.begin(), onposted }
    return this.run(async () => {
      checkChain(args.chain, this.post)
      this.chain = args.chain
      await publishPost({ ...args, pending: this.post, onNote: (note) => this.say('progress', note), onWarn: (warning) => { this.warning = warning } })
      return uploadResult(this.post)
    }, args)
  }

  retry(chain: ChainInfo): Promise<Result> {
    return this.recover(chain, true)
  }

  /** Loading or refreshing a view must not bypass an existing flight or backoff. */
  start(chain: ChainInfo): void {
    if (this.chain || this.flight || this.done) return
    void this.recover(chain, false).catch(() => {})
  }

  private recover(chain: ChainInfo, manual: boolean): Promise<Result> {
    return this.run(() => {
      checkChain(chain, this.post)
      this.chain = chain
      if (manual) this.delay = FIRST_RETRY
      return recoverPost(chain, this.post, manual)
    })
  }

  private scheduleNext(): void {
    if (this.done || !this.chain || this.reverted) return
    const chain = this.chain
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = null
      void this.recover(chain, false).catch(() => {})
    }, this.delay)
    this.delay = Math.min(this.delay * 2, MAX_RETRY)
  }

  /** Keep the flight while checking and confirming discard; another control cannot race it. */
  async discard(chain: ChainInfo, confirm: () => boolean): Promise<boolean> {
    if (this.busy || this.done) return false
    let discarded = false
    await this.run(async () => {
      checkChain(chain, this.post)
      // A reverted transaction posted nothing to find.
      const id = await resolvePendingId(chain, this.post).catch((e: unknown) => {
        if (e instanceof Reverted) return null
        throw e
      })
      if (id !== null) return recoverPost(chain, this.post)
      if (!confirm()) return { note: 'kept on this device' }
      await deletePending(this.post.key)
      discarded = true
      return { note: 'discarded', done: true }
    })
    return discarded
  }

  private sendError(e: unknown, parentId: bigint): string {
    const label = parentId === 0n ? 'post' : 'reply'
    if (e instanceof RelayBusy) return `the relayer is unavailable right now (${e.message}). press ${label} again in a moment, or switch to paying your own gas`
    if (e instanceof RelayDeclined) return `the relayer declined (${e.message}). press ${label} again to post with your own gas`
    if (e instanceof RelayUnknown) return `the relayer did not answer (${e.message}). it may still have sent your post. the app will ask it again with the same signature, which cannot post twice`
    if (this.post.txHash !== null && !(e instanceof Reverted)) return `your post was sent, but this tab lost track of it (${explain(e)}). it will appear once it lands, and the app finishes the upload`
    if (this.post.walletSubmitted && !canForgetFailedPost(this.post, e)) return 'the wallet did not confirm the outcome. your post may still land. the app has kept its bytes and will look for it without sending another transaction'
    return explain(e)
  }
}

/** Tab-local owners; IndexedDB holds the recovery copy, not another live operation. */
export class Publications {
  private operations = new Map<string, Publication>()
  // Suppress a stale IndexedDB snapshot or a copy whose deletion could not be saved.
  private finished = new Set<string>()
  private listeners = new Set<(post: PendingPost) => void>()

  constructor(private schedule: Schedule = later, private accepted: Accepted = acceptPublication) {}

  /** Completion events let a mounted list update without owning recovery work. */
  watch(listener: (post: PendingPost) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get(post: PendingPost): Publication {
    if (this.finished.has(post.key)) throw new Error('this publication is already finished')
    let operation = this.operations.get(post.key)
    if (!operation) {
      operation = new Publication(post, () => {
        this.operations.delete(post.key)
        this.finished.add(post.key)
        for (const listener of this.listeners) {
          try { listener(post) } catch (e) { console.warn('could not report publication completion', e) }
        }
      }, this.schedule, this.accepted)
      this.operations.set(post.key, operation)
    } else if (!operation.busy) {
      // Another tab may have learned a hash or ID. Never replace live progress with an older copy.
      operation.post.messageId ??= post.messageId
      operation.post.txHash ??= post.txHash
      operation.post.walletSubmitted ||= post.walletSubmitted
      operation.post.signed ??= post.signed
      operation.post.contract ??= post.contract
      if (post.fromBlock !== undefined && (operation.post.fromBlock === undefined || post.fromBlock > operation.post.fromBlock)) {
        // A lookup cursor is bound to its starting block; adopt both from the same saved range.
        operation.post.fromBlock = post.fromBlock
        operation.post.lookup = post.lookup
      }
    }
    return operation
  }

  forBox(box: DraftBox): Publication | undefined {
    return [...this.operations.values()].find((op) => op.owns(box))
  }

  async list(chainId: number): Promise<Publication[]> {
    try {
      for (const post of await listPending()) {
        if (post.chainId === chainId && !this.finished.has(post.key)) this.get(post)
      }
    } catch (e) {
      // A failed save must not strand bytes still held by a live operation.
      if (![...this.operations.values()].some((op) => op.post.chainId === chainId)) throw e
    }
    return [...this.operations.values()].filter((op) => op.post.chainId === chainId)
  }
}

export const publications = new Publications()

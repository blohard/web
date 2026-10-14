import { type Address, type Hex, type TransactionReceipt } from 'viem'
import { KeyActivationReverted, KeyTransactionReverted, type KeyAccount, type keyMarket } from './account-keys'
import { explainKeyError as explain } from '../../lib/errors'
import { keyTransaction } from './key-transaction.svelte'
import { Resource } from '../../shared/resource.svelte'

type Market = ReturnType<typeof keyMarket>

/** One mounted account/market view. Transaction ownership outlives this view. */
export class KeyPage {
  readonly account = new Resource<KeyAccount>()
  readonly tracking: ReturnType<typeof keyTransaction>
  phase = $state('')
  error = $state('')
  revision = $state(0)
  readRevision = $state(0)
  private alive = true
  private stopConfirmation: () => void
  private stopRevert: () => void
  private confirmed = new Set<(hash: Hex) => void>()

  constructor(readonly market: Market | null, readonly creator: Address,
    readonly holder: Address, storageKey: string, readonly action: 'activation' | 'trade') {
    this.tracking = keyTransaction(storageKey)
    this.stopConfirmation = this.tracking.onConfirmed((account, hash) => {
      this.apply(account)
      this.error = ''
      this.phase = this.action === 'activation' ? 'account keys activated' : 'transaction confirmed'
      if (this.alive) for (const listener of this.confirmed) listener(hash)
    })
    this.stopRevert = this.tracking.onReverted(error => this.failed(error))
  }
  dispose() { this.alive = false; this.stopConfirmation(); this.stopRevert(); this.confirmed.clear() }
  /**
   * Told whenever this page's transaction confirms: right after its send, or
   * later through "check transaction" or another page. Returns the way to stop.
   */
  onConfirmed(listener: (hash: Hex) => void): () => void {
    this.confirmed.add(listener)
    return () => { this.confirmed.delete(listener) }
  }
  guard() {
    if (!this.alive) throw new Error('the account or page changed. review the transaction again')
    this.tracking.sync()
    if (this.tracking.hash) throw new Error('check the pending transaction before sending another')
  }
  retryRead() {
    if (this.alive && !this.account.pending && !this.tracking.busy && !this.tracking.hash) this.readRevision++
  }
  /** Return as effect cleanup. A refresh neither clears tracking nor resets a running action. */
  watch() {
    const market = this.market
    if (!market) return
    this.tracking.sync()
    const request = market.verify({ cached: true }).then(() => market.account(this.creator, undefined, this.holder)).then(account => this.newest(account))
    const stop = this.account.watch(request)
    let watching = true
    void request.then(() => {
      if (watching && this.alive && this.tracking.hash && !this.tracking.busy) void this.check()
    }, () => {})
    return () => { watching = false; stop() }
  }
  private newest(account: KeyAccount): KeyAccount {
    const current = this.account.value()
    return current && current.blockNumber > account.blockNumber ? current : account
  }
  private apply(account: KeyAccount) {
    if (!this.alive) return
    this.account.settle(null, this.newest(account))
    this.revision++
  }
  private async settle(hash: Hex, block: bigint, confirmation?: string | void) {
    if (this.alive) this.phase = 'transaction confirmed. updating balances…'
    const account = await this.market!.settledAccount(this.creator, block, this.holder, this.action)
    this.tracking.confirm(hash, account)
    if (this.alive && confirmation) this.phase = confirmation
  }
  private failed(error: unknown, hash?: Hex | null) {
    if (hash && (error instanceof KeyActivationReverted || error instanceof KeyTransactionReverted)) {
      this.tracking.revert(hash, error)
      return
    }
    if (this.alive) { this.error = explain(error); this.phase = ''; this.revision++ }
  }
  async check() {
    const hash = this.tracking.hash
    if (!this.alive || !this.market || !hash) return
    const release = this.tracking.acquire()
    if (!release) return
    this.error = ''; this.phase = 'checking transaction…'
    try {
      const receipt = await this.market.findReceipt(hash, this.action)
      if (receipt) await this.settle(hash, receipt.blockNumber)
      else if (this.alive) this.phase = 'no receipt is available yet. check your wallet to see whether the transaction is pending, cancelled or replaced'
    } catch (error) { this.failed(error, hash) }
    finally { release() }
  }
  async send(submit: (guard: () => void) => Promise<Hex>, confirm?: (receipt: TransactionReceipt) => string | void) {
    if (!this.alive || !this.market || this.tracking.hash) return
    const release = this.tracking.acquire()
    if (!release) return
    this.error = ''; this.phase = 'check your wallet…'
    let hash: Hex | null = null
    try {
      this.guard()
      hash = await submit(() => this.guard())
      this.tracking.save(hash)
      if (this.alive) this.phase = 'transaction pending…'
      const receipt = await this.market.receipt(hash, this.action)
      const confirmation = confirm?.(receipt)
      await this.settle(hash, receipt.blockNumber, confirmation)
    } catch (error) { this.failed(error, hash) }
    finally { release() }
  }
  /** Clearing tracking cannot cancel a transaction. Require fresh balances first. */
  async clear() {
    const hash = this.tracking.hash
    if (!this.alive || !this.market || !hash) return
    const release = this.tracking.acquire()
    if (!release) return
    this.error = ''; this.phase = 'refreshing account keys…'
    try {
      const account = await this.market.account(this.creator, undefined, this.holder)
      if (!this.alive || this.tracking.hash !== hash) return
      this.tracking.clear()
      this.apply(account)
      this.phase = 'saved transaction cleared. review your balances before trying again'
    } catch (error) { this.failed(error) }
    finally { release() }
  }
}

/** Debounce quotes and hide results for an old input immediately. */
export function keyQuote<T>(input: () => (() => Promise<T>) | null) {
  const view = new Resource<T>()
  const query = $derived(input())
  $effect(() => {
    const read = query
    if (!read) return
    let timer: ReturnType<typeof setTimeout>
    const request = new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => { void read().then(resolve, reject) }, 200)
    })
    const stop = view.watch(request, read)
    return () => { clearTimeout(timer); stop() }
  })
  return {
    get value() { return query ? view.value(query) : null },
    get failure() { return query ? view.failure(query) : null },
    get error() { const failure = query ? view.failure(query) : null; return failure ? explain(failure.cause) : '' },
  }
}

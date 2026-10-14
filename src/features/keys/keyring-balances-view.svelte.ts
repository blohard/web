import type { Address } from 'viem'
import { pollVisible } from '../../shared/visible-poll'
import { keyringPageChanged, type KeyringPage, type KeyringSide } from './keyring-balances'
import { Resource } from '../../shared/resource.svelte'

/** The tab and page being read, which Back and Forward return to. */
export type KeyringPlace = { side: KeyringSide; after: Address | null; previous: (Address | null)[] }

/** Paging is explicit. Quiet polls only cue a refresh and never replace displayed balances. */
export class KeyringBalancesView {
  readonly page = new Resource<KeyringPage>()
  readonly side: KeyringSide
  after = $state<Address | null>(null)
  previous = $state<(Address | null)[]>([])
  /** The latest quiet poll of a page, compared live with what is on screen. */
  private polled = $state<{ key: string; watch: number; page: KeyringPage } | null>(null)
  // Plain, not state: each watch (a refresh included) ignores polls from earlier ones.
  private watches = 0

  constructor(private read: (side: KeyringSide, after: Address | null) => Promise<KeyringPage>, start?: KeyringPlace) {
    this.side = start?.side ?? 'holding'
    if (start) { this.after = start.after; this.previous = [...start.previous] }
  }

  get place(): KeyringPlace { return { side: this.side, after: this.after, previous: [...this.previous] } }

  get key() { return `${this.side}/${this.after ?? ''}` }
  get shown() { return this.page.value(this.key) }
  /** Derived, never reset: a successful refresh makes the shown page match the poll. */
  get changed() {
    const shown = this.shown, polled = this.polled
    return !!shown && polled?.key === this.key && polled.watch === this.watches && keyringPageChanged(shown, polled.page)
  }

  watch() {
    const side = this.side, after = this.after, key = this.key, watch = ++this.watches
    const stopRead = this.page.watch(this.read(side, after), key)
    const stopPoll = pollVisible(() => this.read(side, after), latest => { this.polled = { key, watch, page: latest } }, () => { /* Keep the last view and cue. A later poll or refresh retries. */ }, 30_000, false)
    return () => { stopRead(); stopPoll() }
  }

  next() {
    if (this.page.pending || !this.shown?.next) return
    this.previous = [...this.previous, this.after]
    this.after = this.shown.next
  }
  back() {
    if (this.page.pending || !this.previous.length) return
    this.after = this.previous.at(-1) ?? null
    this.previous = this.previous.slice(0, -1)
  }
  first() { this.after = null; this.previous = [] }
}

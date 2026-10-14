// The post being written in the home composer: its text, and the quotes
// waiting to go with it. Pressing "quote" on any post adds one here and goes
// home; the composer shows them as attachments and appends their references
// to the body when the post is sent (the protocol spec §7, post://). Both are kept
// here, not in the composer, so leaving the page and coming back finds them.
import { DraftBox } from './draft-box.svelte'
import { parsePostReference, type Quote } from '../../lib/reference-syntax'

const same = (a: Quote, b: Quote) => a.chainId === b.chainId && a.id === b.id

class HomeDraft extends DraftBox {
  quotes = $state<Quote[]>([])
  private presses = 0
  /** The composer's page, while one is mounted, and the press made while none was. */
  private listener: ((press: number) => void) | null = null
  private pending: number | null = null

  /** Add a quote once, and tell the composer's page it was pressed, again on a repeat: quoting is an event, not state to read back. */
  add(q: Quote) {
    if (!parsePostReference(quoteLine(q))?.commit) throw new Error('a quote needs its original commitment')
    const existing = this.quotes.find((x) => same(x, q))
    if (existing && existing.commit !== q.commit) throw new Error('the saved quote has a different commitment')
    if (!existing) {
      this.quotes = [...this.quotes, { ...q }]
      this.version++
    }
    const press = ++this.presses
    if (this.listener) this.listener(press)
    else this.pending = press
  }

  /**
   * The composer's page listens for presses while it is mounted; a press made
   * before it mounted is delivered once, right after it subscribes. Returns
   * the way to stop listening.
   */
  onPress(listener: (press: number) => void): () => void {
    this.listener = listener
    if (this.pending !== null) {
      const press = this.pending
      this.pending = null
      queueMicrotask(() => {
        if (this.listener === listener) listener(press)
      })
    }
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }

  remove(q: Quote) {
    if (!this.quotes.some((x) => same(x, q))) return
    this.quotes = this.quotes.filter((x) => !same(x, q))
    this.version++
  }

  override clear(): void {
    super.clear()
    this.quotes = []
  }
}

export const draft = new HomeDraft()

/** The reference as it is written into a body: on its own line, so it renders as a card. */
export const quoteLine = (q: Quote) => `post://${q.chainId}/${q.id}?commit=${q.commit}`

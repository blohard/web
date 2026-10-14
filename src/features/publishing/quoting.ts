// Quoting a post puts its reference in the home draft and takes the reader
// home to write. Without a wallet, the post's reply line says quote instead,
// and the page finishes the quote once a wallet connects. That survives the
// stream being rebuilt by the connection itself, which drops the card that
// was pressed, but not the reader leaving the page or pressing reply or quote
// again, and a connection finishes it at most once.
import { draft } from './draft.svelte'
import { explain } from '../../lib/errors'
import { quoteOf } from '../../lib/messages'
import { replying, type Box } from './replying.svelte'
import { href, router } from '../navigation/router.svelte'
import type { ChainInfo, MessageRef } from '../../lib/types'
import { wallet } from '../../lib/wallet.svelte'

/** Add a reference to `shown` to the home draft, then go home, unless the reader left the page while it loaded. */
export async function quote(chain: ChainInfo, shown: MessageRef): Promise<void> {
  const page = router.page, leaves = router.leaves
  draft.add(await quoteOf(chain, shown))
  if (router.page === page && router.leaves === leaves) router.go(href.home())
}

type Waiting = { chain: ChainInfo; shown: MessageRef; page: string; leaves: number; press: number }
let waiting: Waiting | null = null

/** Quote once a wallet connects; the post's reply line says so meanwhile. */
export function quoteLater(chain: ChainInfo, shown: MessageRef): void {
  const box = replying.box()
  box.open(chain.id, shown.id, 'quote')
  waiting = { chain, shown, page: router.page, leaves: router.leaves, press: box.press }
}

/**
 * A wallet connected: finish the waiting quote if the reader is still on the
 * page they pressed it on and has pressed nothing there since. Either way it
 * is used up.
 */
export function finishWaiting(): Promise<void> {
  const w = waiting
  waiting = null
  if (!w || router.page !== w.page || router.leaves !== w.leaves) return Promise.resolve()
  const box = replying.box(w.page)
  if (box.press !== w.press || !box.is(w.chain.id, w.shown.id) || box.intent !== 'quote') return Promise.resolve()
  return quoteForPage(w.chain, w.shown, box)
}

/** Try again after the failure the post's line shows. */
export function quoteAgain(chain: ChainInfo, box: Box): Promise<void> {
  const failed = box.quoteFailure
  return failed ? quoteForPage(chain, failed.shown, box) : Promise.resolve()
}

/**
 * A quote the page makes rather than a card, which may be gone: the post's
 * line closes, and a failure opens it again saying why, with a retry. A
 * failure that arrives after anything newer, a box opened on the page or the
 * reader leaving it, is dropped rather than put over it.
 */
function quoteForPage(chain: ChainInfo, shown: MessageRef, box: Box): Promise<void> {
  // The line closes without discarding a reply already begun under the post: that draft is shared.
  box.detach()
  const press = box.press, page = router.page, leaves = router.leaves
  return quote(chain, shown).catch((e) => {
    if (box.press !== press || box.id !== null || router.page !== page || router.leaves !== leaves) {
      console.warn('a quote failed after the reader moved on', e)
      return
    }
    box.open(chain.id, shown.id, 'quote')
    box.quoteFailure = { shown, text: explain(e) }
  })
}

wallet.onConnected(() => void finishWaiting())

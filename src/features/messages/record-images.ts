// Fill the text renderer's `record:` placeholders with verified images.
// Pictures wait for a click unless the reader wrote or follows their author.
// Other records stay as inert labels; this client does not download them
// (the protocol spec §6).
import type { Hex } from 'viem'
import { fetchContent, type Anchor } from '../../lib/store'
import { decode, isInlineImage } from '../../lib/envelope'
import { follows } from '../../lib/follows.svelte'
import { fmtBytes, shortHex } from '../../lib/format'
import { pictureSlots } from './picture-slots'
import { wallet } from '../../lib/wallet.svelte'

/** Aborted once a rendered body leaves the page, stopping its pictures. */
const leaving = new WeakMap<HTMLElement, AbortController>()

/**
 * Resolve every `[data-record]` placeholder under `root`. Safe to call
 * repeatedly; as an attachment (`{@attach hydrateRecords}`) it re-runs when a
 * store it reads changes: the follow list, the connected account. The cleanup
 * it returns runs for a re-run too; only a body gone from the page stops its
 * pictures' downloads. `begin` tracks a load until decoding, failure or cancellation.
 */
export function hydrateRecords(root: HTMLElement, begin?: () => () => void): () => void {
  let left = leaving.get(root)
  if (!left) {
    left = new AbortController()
    leaving.set(root, left)
  }
  const signal = left.signal
  const anchor = anchorOf(root)
  const open = opensPictures(root.dataset.author)
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-record]'))) {
    if (el.dataset.hydrating) continue
    el.dataset.hydrating = '1'
    hydrate(el, anchor, open, signal, begin)
  }
  return () => queueMicrotask(() => {
    if (root.isConnected) return
    leaving.get(root)?.abort()
    leaving.delete(root)
  })
}

/**
 * The message a rendered body belongs to, from `data-chain` and `data-message`
 * on the container, named on each fetch so a host that lacks a picture may
 * pull it from a peer (https://github.com/blohard/host/blob/main/STORE_API.md).
 */
function anchorOf(root: HTMLElement): Anchor | undefined {
  const { chain, message } = root.dataset
  return chain && message ? { chainId: Number(chain), messageId: BigInt(message) } : undefined
}

/** Pictures open on their own in the reader's own posts and in posts by authors the reader follows. */
export function opensPictures(author: string | undefined): boolean {
  if (!author) return false
  return follows.has(author) || wallet.is(author)
}

function hydrate(el: HTMLElement, anchor: Anchor | undefined, open: boolean, signal: AbortSignal, begin?: () => () => void): void {
  const hash = el.dataset.record as Hex
  if (el.classList.contains('rec-image')) imageToggle(el, hash, anchor, open, signal, begin)
  else attachmentStub(el, hash)
}

/**
 * The inert line for a record this client does not open: named, hash on
 * hover, nothing fetched. Other clients may offer such records as downloads
 * (the protocol spec §6); this one shows pictures only.
 */
function notOpened(label: string, hash: Hex): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'placeholder'
  span.title = hash
  span.textContent = `${label}, an attachment this client does not open (${shortHex(hash)})`
  return span
}

/** A non-image reference: named as an attachment, never fetched. */
function attachmentStub(el: HTMLElement, hash: Hex) {
  const label = el.dataset.alt || 'attachment'
  el.replaceChildren(notOpened(label, hash))
}

/**
 * An image reference: a one-line stub with a show control. The first click
 * fetches and verifies the record and shows the picture with a hide control;
 * later clicks toggle without refetching. With `open`, the first click is
 * taken for the reader. Only an explicit show press lifts containing body
 * previews; auto-loaded pictures leave streams compact. A record that turns
 * out not to be an image is left unopened, like any other non-image record.
 */
function imageToggle(el: HTMLElement, hash: Hex, anchor: Anchor | undefined, open: boolean, signal: AbortSignal, begin?: () => () => void) {
  const alt = el.dataset.alt || 'image'
  const box = document.createElement('div')
  box.className = 'rec-image-box'
  const bar = document.createElement('div')
  bar.className = 'rec-image-bar small'
  const label = document.createElement('span')
  label.className = 'name'
  label.textContent = alt
  const button = document.createElement('button')
  button.className = 'small'
  button.type = 'button'
  button.textContent = 'show picture'
  bar.append(label, ' ', button)
  const frame = document.createElement('div')
  frame.className = 'rec-image-stage'
  frame.hidden = true
  box.append(bar, frame)
  // Svelte owns the empty placeholder; this module owns only its children.
  el.replaceChildren(box)

  let img: HTMLImageElement | null = null
  let loading = false
  /** Stops waiting for a slot: the reader pressed the picture while it waited. */
  let jump: (() => void) | null = null
  /** The reader asked for this load, at its start or while it waited: it lifts containing previews. */
  let pressed = false
  const toggle = async (byReader = false) => {
    if (img) {
      const hidden = frame.hidden
      frame.hidden = !hidden
      box.dataset.openedPicture = String(hidden && byReader)
      button.textContent = hidden ? 'hide picture' : 'show picture'
      return
    }
    if (loading) {
      if (byReader) {
        pressed = true
        box.dataset.openedPicture = 'true'
        jump?.()
      }
      return
    }
    const finish = begin?.()
    try {
      loading = true
      pressed = byReader
      frame.hidden = false
      frame.textContent = 'loading picture…'
      box.dataset.openedPicture = String(pressed)
      button.textContent = 'loading…'
      // A picture that opens on its own waits for a shared slot; one the reader
      // pressed does not, nor one pressed while it waited.
      let release: (() => void) | null = null
      if (!byReader) {
        const waited = new AbortController()
        jump = () => waited.abort()
        const stop = () => waited.abort()
        signal.addEventListener('abort', stop, { once: true })
        release = await pictureSlots.take(waited.signal)
        signal.removeEventListener('abort', stop)
        jump = null
        // A slot granted in the turn the body left goes back at once.
        if (signal.aborted) {
          release?.()
          return
        }
      }
      const content = await fetchContent(hash, anchor, signal).finally(() => release?.())
      loading = false
      if (!content.ok) {
        frame.textContent =
          content.reason === 'missing'
            ? `image not available on this host (${shortHex(hash)})`
            : content.reason === 'taken_down'
              ? 'image removed by this host'
              : content.reason === 'mismatch'
                ? 'image failed verification, so it is not shown'
                : `image could not be fetched (${content.detail})`
        if (content.reason === 'mismatch' || content.reason === 'taken_down') button.remove()
        else button.textContent = 'retry picture'
        return
      }
      const d = decode(content.bytes)
      if (!d.ok || !isInlineImage(d.envelope.mediaType)) {
        frame.replaceChildren(notOpened(alt, hash))
        button.remove()
        return
      }
      const shown = document.createElement('img')
      // The blob URL is only needed until the browser has decoded the picture.
      let settled!: () => void
      const decoded = new Promise<void>(resolve => { settled = resolve })
      shown.onload = () => {
        URL.revokeObjectURL(shown.src)
        settled()
      }
      shown.onerror = () => {
        URL.revokeObjectURL(shown.src)
        frame.textContent = 'this picture could not be decoded'
        img = null
        button.textContent = 'retry picture'
        settled()
      }
      const bytes = d.envelope.body.slice()
      const mediaType = d.envelope.mediaType
      shown.src = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
      shown.alt = alt
      // The inline picture is scaled to fit the column; a click opens it as large as the screen allows.
      shown.className = 'zoomable'
      shown.title = 'open full size'
      shown.tabIndex = 0
      shown.onclick = () => openLightbox(bytes, mediaType, alt, shown)
      shown.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openLightbox(bytes, mediaType, alt, shown)
        }
      }
      frame.replaceChildren(shown)
      box.dataset.openedPicture = String(pressed)
      img = shown
      label.title = `${alt} (${fmtBytes(d.envelope.body.length)})`
      button.textContent = 'hide picture'
      signal.addEventListener('abort', settled, { once: true })
      try {
        if (!signal.aborted) await decoded
      } finally {
        signal.removeEventListener('abort', settled)
      }
    } finally {
      finish?.()
    }
  }
  button.onclick = () => void toggle(true)
  if (open) void toggle()
}

/**
 * A picture over the whole screen: fitted to the viewport first, and at its
 * natural size, scrollable, after one more click, for reading small text. A
 * click beside the picture or Escape closes it and returns focus to the
 * picture in the post.
 */
function openLightbox(bytes: Uint8Array<ArrayBuffer>, mediaType: string, alt: string, from: HTMLElement) {
  const overlay = document.createElement('div')
  overlay.className = 'lightbox'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-label', alt || 'image')
  const big = document.createElement('img')
  big.src = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
  big.alt = alt
  big.title = 'click for actual size'
  overlay.append(big)
  const close = () => {
    document.removeEventListener('keydown', onKey)
    URL.revokeObjectURL(big.src)
    overlay.remove()
    from.focus()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  big.onclick = (e) => {
    e.stopPropagation()
    const natural = overlay.classList.toggle('natural')
    big.title = natural ? 'click to fit the screen' : 'click for actual size'
  }
  overlay.onclick = close
  document.addEventListener('keydown', onKey)
  document.body.append(overlay)
  big.focus()
}

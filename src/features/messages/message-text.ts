// Plain body text with bounded app references, web links and Slack-style
// emphasis. Nothing here produces HTML; MessageBody renders every value through Svelte.
import { find } from 'linkifyjs'
import type { Address, Hex } from 'viem'
import { parseAccountReference, parsePostReference, MAX_REFERENCES, type Quote } from '../../lib/reference-syntax'

const SCAN_LIMIT = 64 * 1024
const ATOM_LIMIT = 128
const STYLE_LIMIT = 64
const LINK_LIMIT = 64
const PREVIEW_LIMIT = 4
export const previewLimit = (cap: number) => Number.isSafeInteger(cap) && cap >= 0 ? Math.min(cap, PREVIEW_LIMIT) : PREVIEW_LIMIT
const REFERENCE = /(?:post|account):\/\/[^\s<>"'`()\[\]{}\\]*|record:0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g

type Emphasis = 'bold' | 'italic'
type Style = Emphasis | 'bold-italic'
type Value =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'mention'; address: Address }
  | { kind: 'post'; chainId: number; id: bigint; commit?: Hex }
  | ({ kind: 'quote' } & Quote)
  | { kind: 'record'; hash: Hex; label: string; image: boolean }
export type TextSegment = Value & { style?: Style }
type Atom = { start: number; end: number; value: Value }
const word = (s = '') => /[\p{L}\p{N}]/u.test(s)

/** Only our explicit app references interpret a [label](target) wrapper. */
function wrapped(text: string, start: number, end: number): { start: number; end: number; label: string; image: boolean } {
  if (text.slice(start - 2, start) === '](' && text[end] === ')') {
    const before = text.slice(Math.max(0, start - 260), start - 2)
    const open = before.lastIndexOf('[')
    const label = before.slice(open + 1)
    if (open !== -1 && !/[\[\]\r\n]/.test(label)) {
      const left = start - 2 - before.length + open
      const image = text[left - 1] === '!'
      return { start: left - Number(image), end: end + 1, label, image }
    }
  }
  return { start, end, label: 'attachment', image: false }
}

/** Full lines containing a pinned post reference may become quote cards. */
function alone(text: string, start: number, end: number): boolean {
  const left = text.lastIndexOf('\n', start - 1) + 1
  const right = text.indexOf('\n', end)
  return text.slice(left, start).trim() === '' && text.slice(end, right < 0 ? text.length : right).trim() === ''
}

/** A fixed scan/element budget bounds interpretation; all remaining source stays literal. */
export function messageText(text: string, { quotes, maxAttachments = 4 }: { quotes: boolean; maxAttachments?: number }): TextSegment[] {
  let end = Math.min(text.length, SCAN_LIMIT)
  // Never turn a URL or reference cut by the scan boundary into a different link.
  if (end < text.length) while (end > 0 && !/\s/.test(text[end])) end--
  let source = text.slice(0, end)
  const atoms: Atom[] = []
  let references = 0
  let previews = previewLimit(maxAttachments)
  for (const match of source.matchAll(REFERENCE)) {
    if (atoms.length === ATOM_LIMIT) { end = match.index; source = text.slice(0, end); break }
    let span = wrapped(source, match.index, match.index + match[0].length)
    // A reference inside a label must not make a later wrapper overlap it.
    if (span.start < (atoms.at(-1)?.end ?? 0)) span = { start: match.index, end: match.index + match[0].length, label: 'attachment', image: false }
    let value: Value = { kind: 'text', text: source.slice(span.start, span.end) }
    if (match[0].startsWith('record:')) {
      const image = span.image && previews > 0
      if (image) previews--
      value = { kind: 'record', hash: match[0].slice(7).toLowerCase() as Hex, label: span.label, image }
    } else if (++references <= MAX_REFERENCES) {
      const account = parseAccountReference(match[0])
      const post = parsePostReference(match[0])
      if (account) value = { kind: 'mention', address: account }
      else if (post) {
        if (post.commit && quotes && previews > 0 && alone(source, span.start, span.end)) {
          previews--
          value = { kind: 'quote', ...post, commit: post.commit }
        } else value = { kind: 'post', ...post }
      }
    }
    atoms.push({ start: span.start, end: span.end, value })
  }
  let links = 0
  // The recognizer returns positions only. We validate destinations ourselves.
  try {
    for (const link of find(source, 'url', { defaultProtocol: 'https' })) {
      if (links === LINK_LIMIT || atoms.length === ATOM_LIMIT) break
      if (atoms.some(a => link.start < a.end && link.end > a.start)) continue
      try {
        const url = new URL(link.href)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
        atoms.push({ start: link.start, end: link.end, value: { kind: 'link', text: link.value, href: url.href } })
        links++
      } catch { /* A malformed destination is ordinary text. */ }
    }
  } catch { /* A recognizer failure leaves web addresses as ordinary text. */ }
  atoms.sort((a, b) => a.start - b.start)
  return unframed(styled(text, end, atoms))
}

/**
 * A quote card or attachment is a block of its own, so the line breaks that set
 * it apart in the source are layout, not content: they would show as blank lines
 * above and below the block. Drop them; text between two blocks may vanish entirely.
 */
function unframed(segments: TextSegment[]): TextSegment[] {
  const block = (s: TextSegment | undefined) => s !== undefined && (s.kind === 'quote' || s.kind === 'record')
  const out: TextSegment[] = []
  segments.forEach((s, i) => {
    if (s.kind !== 'text') { out.push(s); return }
    let t = s.text
    if (block(segments[i - 1])) t = t.replace(/^(?:\r?\n)+/, '')
    if (block(segments[i + 1])) t = t.replace(/(?:\r?\n)+$/, '')
    if (t) out.push({ ...s, text: t })
  })
  return out
}

/** A single, unescaped marker; doubled markers remain literal. */
function markerAt(text: string, at: number): '*' | '_' | null {
  const c = text[at], before = text[at - 1]
  return (c === '*' || c === '_') && before !== '\\' && before !== c && text[at + 1] !== c ? c : null
}

/** Single-line pairs, with at most one open pair of each style. Link destinations stay opaque. */
function styled(text: string, end: number, atoms: Atom[]): TextSegment[] {
  const ranges: { start: number; end: number; style: Emphasis }[] = []
  const open: { at: number; marker: '*' | '_' }[] = []
  let atom = 0
  for (let i = 0; i < end && ranges.length < STYLE_LIMIT; i++) {
    if (atoms[atom]?.start === i) {
      const a = atoms[atom++]
      if (a.value.kind === 'link') {
        // Link recognition includes trailing * and _ in URL paths. Peel off only
        // closers for the actual open styles, in nesting order, before skipping it.
        for (let count = open.length; count > 0; count--) {
          const suffix = open.slice(-count).reverse().map(o => o.marker).join('')
          const start = a.end - count
          if (!a.value.text.endsWith(suffix) || start <= a.start) continue
          if (![...suffix].every((c, j) => markerAt(text, start + j) === c && text[start + j - 1].trim() && !word(text[start + j + 1]))) continue
          a.end = start
          a.value = { ...a.value, text: a.value.text.slice(0, -count), href: a.value.href.slice(0, -count) }
          break
        }
      }
      i = a.end - 1
      continue
    }
    if (text[i] === '\n' || text[i] === '\r') { open.length = 0; continue }
    const c = markerAt(text, i)
    if (!c) continue
    const before = text[i - 1] ?? '', after = text[i + 1] ?? ''
    const last = open.at(-1)
    if (last?.marker === c) {
      if (before.trim() && !word(after)) {
        ranges.push({ start: last.at, end: i, style: c === '*' ? 'bold' : 'italic' })
        open.pop()
      }
    } else if (!open.some(o => o.marker === c) && !word(before) && after.trim()) open.push({ at: i, marker: c })
  }
  const out: TextSegment[] = []
  atom = 0
  function emit(start: number, finish: number, style?: Style) {
    let at = start
    while (atom < atoms.length && atoms[atom].start < finish) {
      const a = atoms[atom++]
      if (a.start > at) out.push({ kind: 'text', text: text.slice(at, a.start), style })
      out.push({ ...a.value, style })
      at = a.end
    }
    if (at < finish) out.push({ kind: 'text', text: text.slice(at, finish), style })
  }
  const markers = ranges.flatMap(r => [
    { at: r.start, style: r.style, opening: true }, { at: r.end, style: r.style, opening: false },
  ]).sort((a, b) => a.at - b.at)
  const active = new Set<Emphasis>()
  let at = 0
  for (const marker of markers) {
    const style: Style | undefined = active.size === 2 ? 'bold-italic' : active.values().next().value
    emit(at, marker.at, style)
    if (marker.opening) active.add(marker.style)
    else active.delete(marker.style)
    at = marker.at + 1
  }
  emit(at, text.length)
  return out
}

// Plain body text with bounded app references, web links and flat Slack-style
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

type Style = 'bold' | 'italic'
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
        // A closing emphasis marker after a URL path belongs to its opener.
        // Markers in an unwrapped URL remain part of that URL.
        const marker = source[link.start - 1]
        const before = source[link.start - 2]
        const trim = (marker === '*' || marker === '_') && before !== marker && before !== '\\' && !word(before) && !word(source[link.end]) && link.value.endsWith(marker)
        const finish = link.end - Number(trim)
        const value = source.slice(link.start, finish)
        const url = new URL(trim ? link.href.slice(0, -1) : link.href)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
        atoms.push({ start: link.start, end: finish, value: { kind: 'link', text: value, href: url.href } })
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

/** Single * and _ pairs on one line, without nesting or interpretation inside link destinations. */
function styled(text: string, end: number, atoms: Atom[]): TextSegment[] {
  const ranges: { start: number; end: number; style: Style }[] = []
  let open: { at: number; marker: string } | null = null
  let atom = 0
  for (let i = 0; i < end && ranges.length < STYLE_LIMIT; i++) {
    if (atoms[atom]?.start === i) { i = atoms[atom++].end - 1; continue }
    const c = text[i], before = text[i - 1] ?? '', after = text[i + 1] ?? ''
    if (c === '\n' || c === '\r') { open = null; continue }
    if ((c !== '*' && c !== '_') || before === '\\' || before === c || after === c) continue
    if (open) {
      if (c === open.marker && before.trim() && !word(after)) {
        ranges.push({ start: open.at, end: i, style: c === '*' ? 'bold' : 'italic' })
        open = null
      }
    } else if (!word(before) && after.trim()) open = { at: i, marker: c }
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
  let at = 0
  for (const range of ranges) {
    emit(at, range.start)
    emit(range.start + 1, range.end, range.style)
    at = range.end + 1
  }
  emit(at, text.length)
  return out
}

// What a fetched body means for display, shared by message cards and quotes.
import { type Content, utf8 } from './store'
import { decode, TEXT } from './envelope'

export type Body =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'taken-down' }
  | { kind: 'mismatch' }
  | { kind: 'unknown-type'; mediaType: string }
  | { kind: 'no-envelope'; reason: string }
  | { kind: 'error'; detail: string }

/** The one-line stand-in for a body that is not shown, and whether it is an error rather than an absence. */
export function notice(body: Exclude<Body, { kind: 'text' }>, detail = ''): { text: string; err: boolean } {
  switch (body.kind) {
    case 'missing':
      return { text: `content not available on this host${detail}`, err: false }
    case 'taken-down':
      return { text: 'removed by this host', err: false }
    case 'mismatch':
      return { text: "the host returned bytes that do not match this post's hash, so they are not shown", err: true }
    case 'unknown-type':
      return { text: `unrecognized content type ${body.mediaType}, not shown`, err: false }
    case 'no-envelope':
      return { text: `unrecognized content (${body.reason}), not shown`, err: false }
    case 'error':
      return { text: `could not fetch content. ${body.detail}`, err: true }
  }
}

export function interpret(content: Content): Body {
  if (!content.ok) {
    if (content.reason === 'missing') return { kind: 'missing' }
    if (content.reason === 'taken_down') return { kind: 'taken-down' }
    if (content.reason === 'mismatch') return { kind: 'mismatch' }
    return { kind: 'error', detail: content.detail }
  }
  const d = decode(content.bytes)
  if (!d.ok) return { kind: 'no-envelope', reason: d.reason }
  if (d.envelope.mediaType !== TEXT) return { kind: 'unknown-type', mediaType: d.envelope.mediaType }
  return { kind: 'text', text: utf8.decode(d.envelope.body) }
}

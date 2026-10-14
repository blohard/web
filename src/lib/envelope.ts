// The content envelope (DESIGN.md §3): one header line, then the body.
//
//   version/1 text/plain
//   <body bytes>
//
// Everything a reader shows must come from bytes whose header it understood.
import { utf8 } from './store'

const VERSION = 1
export const TEXT = 'text/plain'
const MAX_HEADER_LEN = 128
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/

/**
 * The picture types this client shows. Not SVG: as an image its scripts are
 * inert, but a blob URL of ours opened as a document would run them as this
 * origin, so it is treated like any other attachment this client does not open.
 */
export function isInlineImage(mediaType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(mediaType)
}

/** A browser-reported file type, made into a valid record media type. */
export function normalizeMediaType(t: string): string {
  const lower = t.trim().toLowerCase().split(';')[0]
  return MEDIA_TYPE.test(lower) ? lower : 'application/octet-stream'
}

type Envelope = { mediaType: string; body: Uint8Array }
type Decoded = { ok: true; envelope: Envelope } | { ok: false; reason: string }

/** Wrap `body` as a record of `mediaType`. */
export function encode(mediaType: string, body: Uint8Array): Uint8Array {
  if (!MEDIA_TYPE.test(mediaType)) throw new Error(`bad media type ${mediaType}`)
  const header = utf8.encode(`version/${VERSION} ${mediaType}\n`)
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(body, header.length)
  return out
}

/** Split bytes into header and body; never throws. */
export function decode(bytes: Uint8Array): Decoded {
  const limit = Math.min(bytes.length, MAX_HEADER_LEN + 1)
  let nl = -1
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x0a) {
      nl = i
      break
    }
  }
  if (nl < 0) return { ok: false, reason: 'no envelope header' }
  let line: string
  try {
    line = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, nl))
  } catch {
    return { ok: false, reason: 'header is not UTF-8' }
  }
  if (line.endsWith('\r')) line = line.slice(0, -1)
  const parts = line.split(' ')
  if (parts.length !== 2) return { ok: false, reason: 'header is not `version/N <media-type>`' }
  const m = /^version\/(\d+)$/.exec(parts[0])
  if (!m) return { ok: false, reason: 'header is not `version/N <media-type>`' }
  const version = Number(m[1])
  if (version !== VERSION) return { ok: false, reason: `unsupported envelope version ${version}` }
  if (!MEDIA_TYPE.test(parts[1])) return { ok: false, reason: `bad media type ${JSON.stringify(parts[1])}` }
  return { ok: true, envelope: { mediaType: parts[1], body: bytes.subarray(nl + 1) } }
}

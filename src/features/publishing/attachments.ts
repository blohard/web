// Files become image records with generic labels (the protocol spec §7).
// PNG, JPEG and WebP are re-encoded to strip source metadata; GIF and AVIF
// keep their original bytes, including any metadata. SVG is refused.
import { hashOf } from '../../lib/store'
import { encode, isInlineImage, normalizeMediaType } from '../../lib/envelope'
import { fmtBytes } from '../../lib/format'
import { reencodeImage, reencodes } from '../../lib/images'
import type { Hex } from 'viem'
import type { PostRecord } from './pending'
import type { AttachmentPolicy } from '../../lib/types'
import type { DraftBox } from './draft-box.svelte'

/** A `record:` reference as written in a body. */
const RECORD_REF = /record:(0x[0-9a-fA-F]{64})/g

/** How many distinct records the text references, as the host counts them. */
export function referencedRecords(text: string): number {
  return new Set(Array.from(text.matchAll(RECORD_REF), (m) => m[1].toLowerCase())).size
}

/** The text with an image reference added on its own line. The body's hash commits to it. */
function withReference(text: string, record: PostRecord): string {
  const ref = `![${record.name}](record:${record.hash})`
  return text.length && !text.endsWith('\n') ? `${text}\n${ref}\n` : `${text}${ref}\n`
}

/** The text without any line that references `hash`. */
export function withoutReference(text: string, hash: Hex): string {
  return text
    .split('\n')
    .filter((line) => !line.includes(`record:${hash}`))
    .join('\n')
}

/** The generic label for the n-th attachment of a post: "image", "image 2", … */
function attachmentLabel(ordinal: number): string {
  return ordinal === 1 ? 'image' : `image ${ordinal}`
}

/** Conversion may finish after typing, navigation or another file conversion. */
export async function attachFiles(
  box: DraftBox, files: File[], policy: AttachmentPolicy,
  active: () => boolean, quotes: () => number,
): Promise<string | null> {
  const current = box.guardEdit()
  const allowed = () => active() && current()
  const full = () => box.draft.attachments.length + quotes() >= policy.max_per_message
  const limit = `at most ${policy.max_per_message} attachments per post, images and quotes together`
  let error: string | null = null
  for (const file of files) {
    if (!allowed()) return null
    if (full()) return limit
    let result: Awaited<ReturnType<typeof fileToRecord>>
    try { result = await fileToRecord(file, policy) }
    catch { result = { ok: false, reason: 'could not read that image' } }
    if (!allowed()) return null
    if (!result.ok) { error = result.reason; continue }
    const draft = box.draft
    if (draft.attachments.some((a) => a.hash === result.record.hash)) continue
    if (full()) return limit
    const record = { ...result.record, name: attachmentLabel(draft.attachments.length + 1) }
    box.edit({ ...draft, text: withReference(draft.text, record), attachments: [...draft.attachments, record] })
  }
  return error
}

/**
 * One file as a record this host will take, or the reason it will not. This
 * client attaches pictures only, for now: nothing else is shown to readers,
 * so nothing else should be posted from here.
 */
async function fileToRecord(
  file: File,
  policy: AttachmentPolicy,
): Promise<{ ok: true; record: PostRecord } | { ok: false; reason: string }> {
  const mediaType = normalizeMediaType(file.type)
  if (!isInlineImage(mediaType)) {
    return { ok: false, reason: `only images can be attached for now (that file is ${mediaType || 'of unknown type'})` }
  }
  if (policy.media_types && !policy.media_types.some((t) => t.toLowerCase() === mediaType)) {
    return { ok: false, reason: `this host stores ${policy.media_types.join(', ')} only, and that file is ${mediaType}` }
  }
  let body: Uint8Array
  if (reencodes(mediaType)) {
    const clean = await reencodeImage(file, mediaType, policy.max_bytes - 128)
    if (!clean) return { ok: false, reason: `could not re-encode that image to fit ${fmtBytes(policy.max_bytes)}, so it was not attached` }
    body = clean
  } else {
    body = new Uint8Array(await file.arrayBuffer())
  }
  const bytes = encode(mediaType, body)
  if (bytes.length > policy.max_bytes) {
    return { ok: false, reason: `that file is ${fmtBytes(bytes.length)}, and this host takes attachments up to ${fmtBytes(policy.max_bytes)}` }
  }
  return {
    ok: true,
    record: { kind: 'attachment', name: attachmentLabel(1), mediaType, bytes, hash: hashOf(bytes), status: 'pending' },
  }
}

// One saved post owns its transaction, signature and remaining uploads.
// Keep bytes until a host returns 200; a 202 only means they are held.
import type { Address, Hex } from 'viem'
import type { Cursor } from '../../lib/api'
import type { SignedPost } from './relay'
import { across, STORES } from '../../lib/db'

type Upload = 'pending' | 'uploading' | 'held' | 'stored' | 'failed'
export type PostRecord = {
  kind: 'body' | 'attachment'
  name: string
  mediaType: string
  bytes: Uint8Array
  hash: Hex
  status: Upload
  error?: string
}

export type PendingPost = {
  /** Local publication identity: identical bytes can belong to different posts. */
  key: string
  chainId: number
  /** Set before signing or sending; an unsent draft has no deployment yet. */
  contract?: Address
  bodyHash: Hex
  parentId: bigint
  author: Address
  createdAt: number
  messageId: bigint | null
  txHash: Hex | null
  /** Saved before a wallet send: no returned hash does not prove it was refused. */
  walletSubmitted?: boolean
  /** Saved before handing it to the relayer; retries use this exact signature. */
  signed: SignedPost | null
  /** Captured before signing/sending, then advanced only by successful recovery scans. */
  fromBlock?: bigint
  /** A bounded lookup continues under its original accepted checkpoint. */
  lookup?: { cursor: Cursor; throughBlock: bigint }
  /** A non-temporary refusal pauses resubmission, not chain or receipt recovery. */
  relayPaused?: boolean
  /** Body first when still needed; it may already be stored while attachments remain. */
  records: PostRecord[]
}

type Progress = Partial<Pick<PendingPost, 'messageId' | 'txHash' | 'walletSubmitted' | 'signed' | 'fromBlock' | 'lookup' | 'relayPaused'>>

// A saved post holds its progress and its records' metadata; each record's
// bytes are a separate entry keyed [post key, hash], written once and deleted
// when the host confirms it stored them. A post saved before the split keeps
// its bytes inline until it finishes: every path below reads and keeps both.
type SavedRecord = Omit<PostRecord, 'bytes'> & { bytes?: Uint8Array }
type SavedPost = Omit<PendingPost, 'records'> & { records: SavedRecord[] }
const STORED = [STORES.pending, STORES.pendingBytes]
const bytesKey = (post: string, hash: Hex) => [post, hash]
/** Every byte entry of one post: hashes are hex strings, so they sort between these bounds. */
const bytesOf = (post: string) => IDBKeyRange.bound([post, ''], [post, '\uffff'])

export function newPendingPost(chainId: number, author: Address, records: PostRecord[]): PendingPost {
  return {
    key: crypto.randomUUID(), chainId, author, bodyHash: records[0].hash, parentId: 0n,
    createdAt: Date.now(), messageId: null, txHash: null, signed: null,
    records: records.map((r) => ({ ...r, status: 'pending', error: undefined })),
  }
}

export async function savePending(post: PendingPost): Promise<void> {
  // Svelte proxies cannot be cloned by IndexedDB. Copy the small objects;
  // Uint8Array contents are already plain binary data.
  await across(STORED, 'readwrite', (t) => {
    const records = post.records.map(({ bytes: _bytes, ...r }) => ({ ...r }))
    t.objectStore(STORES.pending).put({ ...post, signed: post.signed && { ...post.signed }, records })
    for (const r of post.records) t.objectStore(STORES.pendingBytes).put(r.bytes, bytesKey(post.key, r.hash))
  })
}

/** Every saved post with its records' bytes, read in one transaction so none is caught half finished. */
export async function listPending(): Promise<PendingPost[]> {
  const posts: PendingPost[] = []
  await across(STORED, 'readonly', (t) => {
    const bytes = t.objectStore(STORES.pendingBytes)
    const all = t.objectStore(STORES.pending).getAll() as IDBRequest<SavedPost[]>
    all.onsuccess = () => {
      for (const saved of all.result) {
        const post = saved as PendingPost
        posts.push(post)
        for (const record of post.records) {
          if (record.bytes) continue
          const read = bytes.get(bytesKey(saved.key, record.hash))
          // A missing entry is lost data, not a record to drop: the empty bytes
          // fail the upload's hash check, so the loss shows instead of passing.
          read.onsuccess = () => { record.bytes = read.result ?? new Uint8Array() }
        }
      }
    }
  })
  return posts
}

export async function deletePending(key: string): Promise<void> {
  await across(STORED, 'readwrite', (t) => {
    t.objectStore(STORES.pending).delete(key)
    t.objectStore(STORES.pendingBytes).delete(bytesOf(key))
  })
}

/**
 * Read and change one post in the same transaction, so concurrent uploads
 * cannot resurrect records. Only its metadata is rewritten; the bytes of the
 * records the change removed are deleted with it.
 */
async function change(key: string, update: (post: SavedPost) => void): Promise<void> {
  await across(STORED, 'readwrite', (t) => {
    const posts = t.objectStore(STORES.pending), bytes = t.objectStore(STORES.pendingBytes)
    const req = posts.get(key)
    req.onsuccess = () => {
      const post: SavedPost | undefined = req.result
      if (!post) return
      const before = post.records.map((r) => r.hash)
      update(post)
      const kept = new Set(post.records.map((r) => r.hash))
      for (const hash of before) if (!kept.has(hash)) bytes.delete(bytesKey(key, hash))
      if (post.records.length || post.messageId === null) posts.put(post)
      else { posts.delete(key); bytes.delete(bytesOf(key)) }
    }
  })
}

/** Update the live post even if this browser cannot save the recovery copy. */
export async function updatePending(post: PendingPost, patch: Progress): Promise<void> {
  Object.assign(post, patch)
  await change(post.key, (saved) => Object.assign(saved, patch))
}

export async function recordUploaded(key: string, hash: Hex, held: boolean): Promise<void> {
  await change(key, (post) => {
    if (held) {
      const record = post.records.find((r) => r.hash === hash)
      if (record) record.status = 'held'
    } else post.records = post.records.filter((r) => r.hash !== hash)
  })
}

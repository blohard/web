// The harness every client test file shares: real client modules loaded
// through Vite, IndexedDB and HTTP replaced at their boundaries, and one
// HTTP fixture whose switches live on `mock`, reset before every test. No browser,
// wallet or running chain is required. Each subject has its own file; the
// runner includes feature and shared tests under src, plus scripts/*.test.mjs.
// load() and renderComponent() take paths relative to src/.
import assert from 'node:assert/strict'
import { address, hash, response } from './fixture-values.mjs'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { componentRenderer } from './svelte-test.mjs'
import { encodeAbiParameters, encodeEventTopics, keccak256, zeroAddress } from 'viem'

const renderer = await componentRenderer()
export const { load, renderComponent } = renderer
const pending = await load('features/publishing/pending.ts')
const { bodyRecord } = await load('features/publishing/posting.ts')
const { gating } = await load('features/messages/gating.svelte.ts')
const { boardAbi } = await load('lib/abi/board.ts')
const { Wallet } = await load('lib/wallet.svelte.ts')
const originalFetch = globalThis.fetch
const originalIndexedDB = globalThis.indexedDB
const originalLocation = globalThis.location
globalThis.location = { origin: 'https://client.invalid', hash: '' }

export { address, hash, response, deferred } from './fixture-values.mjs'
export const author = address('22')
export const txHash = hash('44')

/**
 * The mock's switches: the chain under test (a fresh id isolates chain-keyed
 * caches), HTTP answers, and recorded requests (`calls`, `shapes`).
 */
export const mock = {}
let chainId = 40000

/** A fresh IndexedDB, a fresh chain and the mock content host, before every test. */
export function install() {
  globalThis.indexedDB = new IDBFactory()
  // A browser global the pending store needs to delete a post's bytes by range.
  globalThis.IDBKeyRange = IDBKeyRange
  mock.chain = { id: chainId++, name: 'test', contract: address('11'), public_rpc_url: 'https://mock.invalid', start_block: 0, confirmations: 5,
    blocklist: { registry: address('66'), list: 'blocklist' },
    blocking: { gate: address('55'), registry: address('66'), list: 'blocklist' } }
  mock.calls = []; mock.logs = []; mock.relayStatus = 504; mock.relayOutcome = undefined; mock.relayHash = txHash; mock.held = false
  mock.relayRetryAfter = null
  mock.perMessageGate = zeroAddress; mock.authorGate = mock.chain.blocking.gate; mock.blocked = true
  mock.receiptStatus = '0x1'; mock.gateError = false; mock.onRelay = async () => {}
  mock.receiptMissing = false; mock.receiptError = false; mock.receiptLogs = null
  mock.previewReply = null; mock.previewError = null
  mock.gates = new Map(); mock.head = 1n
  mock.hostStatus = 200; mock.publishedStatus = null
  mock.uploadErrorHash = null
  mock.timestampOf = (number) => 1_700_000_000n + number * 2n
  mock.onlyKnownMessages = false
  mock.messages = new Map()
  // Bodies the host serves, by hash (lower-case); any other hash is not stored here.
  mock.bodies = new Map()
  // Hashes the host has taken down (lower-case): refused whether or not stored.
  mock.takenDown = new Set()
  mock.onContent = async () => {}
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('/api/relay/')) {
      mock.calls.push({ method: 'relay', signed: JSON.parse(init.body) })
      await mock.onRelay()
      if (mock.relayStatus === 0) throw new Error('network unavailable')
      if (mock.relayStatus === 200) return response({ tx_hash: mock.relayHash })
      const refusal = response({ error: 'test refusal', outcome: mock.relayOutcome === undefined ? ([408, 409, 504].includes(mock.relayStatus) ? 'unknown' : 'refused') : mock.relayOutcome }, mock.relayStatus)
      if (mock.relayRetryAfter !== null) refusal.headers.set('retry-after', String(mock.relayRetryAfter))
      return refusal
    }
    if (String(url).startsWith('/api/content/')) {
      mock.calls.push({ method: 'content', url: String(url) })
      await mock.onContent(String(url))
      const key = String(url).slice('/api/content/'.length).split('?')[0].toLowerCase()
      if (mock.takenDown.has(key)) return response({ error: 'this host has taken this content down', code: 'taken_down' }, 410)
      const bytes = mock.bodies.get(key)
      return bytes ? new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } }) : response({ error: 'not stored here' }, 404)
    }
    if (String(url).startsWith('/api/publish?')) {
      mock.calls.push({ method: 'upload', url: String(url) })
      const hash = keccak256(new Uint8Array(init.body))
      if (hash === mock.uploadErrorHash) return response({ error: 'attachment refused' }, 400)
      const keep = mock.held || String(url).includes('tx_hash=')
      return response({ hash, held: keep }, keep ? 202 : 200)
    }
    throw new Error(`unexpected request ${url}; application reads need the host fixture`)
  }
}

export async function teardown() {
  globalThis.fetch = originalFetch
  globalThis.indexedDB = originalIndexedDB
  globalThis.location = originalLocation
  await renderer.close()
}

export function makePost(attachments = false) {
  const records = [bodyRecord('test post')]
  if (attachments) records.push({ ...bodyRecord('image bytes'), kind: 'attachment', name: 'image' })
  return pending.newPendingPost(mock.chain.id, author, records)
}
export function sign(post, deadline = Date.now() + 60_000) {
  post.signed = { author, contentHash: post.bodyHash, parentId: '0', replyGate: zeroAddress, nonce: '7', deadline: String(Math.floor(deadline / 1000)), sig: '0x1234', gateData: '0x' }
}
export function posted(post, parentId = 0n) {
  return { address: mock.chain.contract, blockNumber: '0x1', blockHash: hash('77'), transactionHash: txHash, transactionIndex: '0x0', logIndex: '0x0', removed: false,
    topics: encodeEventTopics({ abi: boardAbi, eventName: 'Posted', args: { author, parentId, parentAuthor: parentId === 0n ? zeroAddress : author } }),
    data: encodeAbiParameters([{ type: 'uint64' }, { type: 'bytes32' }, { type: 'address' }], [7n, post.bodyHash, zeroAddress]) }
}

export function replyArgs() {
  const wallet = { account: author, chainId: mock.chain.id,
    ensureChain: async (_chain, need = 'required') => { mock.calls.push({ method: 'wallet:ensureChain', need }) },
    provider: { request: async (req) => {
      mock.calls.push(req)
      if (req.method === 'eth_chainId') return `0x${mock.chain.id.toString(16)}`
      if (req.method === 'eth_accounts') return [author]
      if (req.method === 'eth_signTypedData_v4') return '0x1234'
      if (req.method === 'eth_sendTransaction') return txHash
      throw new Error(`unexpected wallet request ${req.method}`)
    } } }
  return { chain: mock.chain, wallet, parentId: 6n, pending: makePost(), sponsored: true, onNote() {}, onWarn() {} }
}
export async function verdict(reply = { id: 9n, parentId: 7n, author: address('88'), contentHash: hash('33'), blockNumber: 9n }) {
  return gating.check(mock.chain, reply, author)
}

/** A response body of `total` bytes in 64 KiB pieces, counting how many were handed out. */
export function bigBody(total) {
  const piece = 1 << 16
  const state = { pulled: 0, cancelled: false }
  let sent = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= total) return controller.close()
      const n = Math.min(piece, total - sent)
      sent += n
      state.pulled += n
      controller.enqueue(new Uint8Array(n))
    },
    cancel() { state.cancelled = true },
  }, { highWaterMark: 0 }) // hand out a piece only when read, so the count is what the reader took
  return { stream, state }
}
/** A post for the feed fixtures; `parentAuthor` is filled in by `feedHistory` from the list when the parent is in it. */
export function feedPost(id, parentId = 0, who = author, parentAuthor) {
  return { id: BigInt(id), parentId: BigInt(parentId), author: who, parentAuthor, contentHash: hash('66'),
    blockNumber: BigInt(id), logIndex: 0, txHash }
}
/** Seed indexed message history; the checkpoint is the newest block among them. */
export function feedHistory(posts) {
  mock.head = posts.reduce((n, p) => p.blockNumber > n ? p.blockNumber : n, 1n)
  const authorOf = (id) => posts.find((q) => q.id === id)?.author
  mock.logs = posts.map((p) => {
    // The parent's author is a topic: the given one, else the parent's from this list, else the default author.
    const parentAuthor = p.parentId === 0n ? zeroAddress : (p.parentAuthor ?? authorOf(p.parentId) ?? author)
    return { ...posted({ bodyHash: p.contentHash }), blockNumber: `0x${p.blockNumber.toString(16)}`,
      topics: encodeEventTopics({ abi: boardAbi, eventName: 'Posted', args: { author: p.author, parentId: p.parentId, parentAuthor } }),
      data: encodeAbiParameters([{ type: 'uint64' }, { type: 'bytes32' }, { type: 'address' }], [p.id, p.contentHash, zeroAddress]) }
  })
}
export const ids = (posts) => posts.map((p) => Number(p.id))

/** A gate set on the chain after history was laid down: what the mock answers, plus the indexed change a refresh reads, at `block`. */
export function gateChanged(id, gate, block, old = zeroAddress) {
  mock.gates.set(id, gate)
  if (block > mock.head) mock.head = block
  mock.logs.push({ address: mock.chain.contract, blockNumber: `0x${block.toString(16)}`, blockHash: hash('77'), transactionHash: txHash, transactionIndex: '0x0', logIndex: `0x${mock.logs.length.toString(16)}`, removed: false,
    topics: encodeEventTopics({ abi: boardAbi, eventName: 'ReplyGateChanged', args: { id } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [old, gate]) })
}
export function authorGateChanged(who, gate, block, old = zeroAddress) {
  mock.authorGate = gate
  if (block > mock.head) mock.head = block
  mock.logs.push({ address: mock.chain.contract, blockNumber: `0x${block.toString(16)}`, blockHash: hash('77'), transactionHash: txHash, transactionIndex: '0x0', logIndex: `0x${mock.logs.length.toString(16)}`, removed: false,
    topics: encodeEventTopics({ abi: boardAbi, eventName: 'AuthorGateChanged', args: { author: who } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [old, gate]) })
}

/** A wallet already on the chain, with configurable RPC reads and network updates. */
export function walletOn(chainHex, { reads, update }) {
  const asked = []
  const provider = {
    on: () => {},
    request: async (req) => {
      asked.push(req.method)
      switch (req.method) {
        case 'eth_accounts': return [author]
        case 'eth_chainId': return chainHex
        case 'eth_blockNumber': return reads()
        case 'wallet_addEthereumChain': return update()
        default: throw new Error(`unexpected ${req.method}`)
      }
    },
  }
  const w = new Wallet(provider)
  w.chainId = Number(chainHex)
  w.probeTimeoutMs = 50
  return { w, asked }
}
export const chainHex = () => `0x${mock.chain.id.toString(16)}`
export const rejects = (code, message) => () => { throw Object.assign(new Error(message), { code }) }

// ---- fixtures for feed pagination, replies and gating tests

/** Wait for missing context counts as well as the indexed rows. */
export const counted = async (page) => { const p = await page; await p.countsReady; return p }
/** A post at a given block; `feedPost` alone puts each post in the block of its id. */
export const at = (block, id, parentId = 0, who = author) => ({ ...feedPost(id, parentId, who), blockNumber: BigInt(block) })

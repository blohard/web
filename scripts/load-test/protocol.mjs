// Host domain reads and ordinary wallet RPC. Writes are saved before broadcast; no node-admin RPC is used.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { createPublicClient, createWalletClient, custom, encodeAbiParameters, encodeFunctionData,
  isAddress, keccak256, parseGwei, zeroAddress } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { boardAbi } from '../../src/lib/abi/board.ts'
import { registryAbi } from '../../src/lib/abi/registry.ts'
import { record } from '../../src/lib/api.ts'
import { boardDomain, POST_TYPES } from '../../src/lib/signing.js'
import { Failure, problem, save, secretFile, sleep } from './support.mjs'

export { boardAbi, registryAbi, zeroAddress }
export const DELETED = '0x0000000000000000000000000000000000000001'
export const REMOVED = '0x0000000000000000000000000000000000000002'
export const ended = (gate) => gate === DELETED || gate === REMOVED
export const same = (a, b) => a?.toLowerCase() === b?.toLowerCase()
const HASH = /^0x[0-9a-fA-F]{64}$/

// Local stacks only (--forwarded-ips). Real visitors reach the host through the
// site's proxy, each from its own address, and the host meters visitors by the
// address a loopback proxy forwards. Simulated users share this process's
// sockets, so each user's requests carry an address of their own. Behind the
// deployed site's proxy the header is replaced with the generator's own.
const visitors = new AsyncLocalStorage()
export function asVisitor(config, index, fn) {
  return config.forwardedIps ? visitors.run(`10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`, fn) : fn()
}

export class Http {
  constructor(site, timeout, recorder) { this.site = site; this.timeout = timeout; this.recorder = recorder; this.nextId = 0 }
  async request(path, { body, method = body === undefined ? 'GET' : 'POST', name = 'http', chain, maxBytes = 8 << 20 } = {}) {
    const start = performance.now(), phase = this.recorder.phase
    let status = 0, bytes = 0, outcome = 'network', payload
    const signal = AbortSignal.timeout(this.timeout)
    try {
      const visitor = visitors.getStore()
      const response = await fetch(new URL(path, this.site), { method, body, signal, redirect: 'error',
        headers: { ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}), ...(visitor ? { 'x-forwarded-for': visitor } : {}),
          'user-agent': 'blohard-load-test/1' } })
      status = response.status
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Failure('oversized', status) }
      const chunks = []
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length
        if (bytes > maxBytes) throw new Failure('oversized', status)
        chunks.push(chunk)
      }
      payload = Buffer.concat(chunks)
      outcome = response.ok ? 'ok' : status === 429 ? 'quota' : status === 503 ? 'busy' : `http_${status}`
      if (!response.ok) {
        const error = new Failure(outcome, status)
        try { error.outcome = JSON.parse(payload).outcome === 'refused' ? 'refused' : 'unknown' } catch { error.outcome = 'unknown' }
        throw error
      }
      return { bytes: payload, status }
    } catch (e) {
      if (e instanceof Failure) throw e
      throw new Failure('network', 0)
    } finally {
      await this.recorder.event({ type: 'measure', phase, name, chain, ms: performance.now() - start, outcome, status, bytes })
    }
  }
  async json(path, args) {
    const answer = await this.request(path, args)
    try { return JSON.parse(answer.bytes.toString('utf8')) } catch { throw new Failure('unreadable', 0) }
  }
  async rpc(url, request, chain) {
    const wire = { jsonrpc: '2.0', id: ++this.nextId, ...request }
    const start = performance.now(), phase = this.recorder.phase
    const answer = await this.json(url, { body: JSON.stringify(wire), name: `http.wallet.${wire.method}`, chain })
    if (answer?.id !== wire.id || answer.jsonrpc !== '2.0' || (!('result' in answer) && !answer.error)) throw new Failure('rpc_shape', 0)
    const outcome = answer.error ? answer.error.code === -32005 ? 'busy' : 'rpc_error' : 'ok'
    await this.recorder.event({ type: 'measure', phase, name: `rpc.${wire.method}`, chain, ms: performance.now() - start, outcome, code: answer.error?.code })
    if (answer.error) throw new Failure(outcome, answer.error.code)
    return answer.result
  }
}

/** Wallet transport only; page reads never pass through it. */
export class Rpc {
  constructor(http, url, chain) { Object.assign(this, { http, url, chain }) }
  request = (request) => this.http.rpc(this.url, request, this.chain)
}

export function clients(http, info, account) {
  const chain = { id: info.id, name: info.name ?? `${info.id}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [info.public_rpc_url] } } }
  const walletRpc = new Rpc(http, info.public_rpc_url, info.id)
  const writeRead = createPublicClient({ chain, cacheTime: 0, ccipRead: false, transport: custom(walletRpc, { retryCount: 0 }) })
  const wallet = account ? createWalletClient({ account, chain, transport: custom(walletRpc, { retryCount: 0 }) }) : null
  const app = (path, body) => http.json(`/api/chains/${info.id}/${path}`, { body: body === undefined ? undefined : JSON.stringify(body), name: `api.${path.split(/[/?]/)[0]}`, chain: info.id, maxBytes: 1 << 20 })
  const message = async (id, ancestors = 0, pin) => {
    const answer = await app(`message/${id}?ancestors=${ancestors}${pin ? `&commit=${pin}` : ''}`)
    const record = recordImage(answer.message)
    if (record.id !== BigInt(id) || (pin && record.commitment !== pin)) throw new Failure('integrity', 0)
    let parent = record.parentId
    const context = answer.ancestors.map(recordImage)
    if (context.length > ancestors) throw new Failure('integrity', 0)
    for (const p of context) { if (p.id !== parent) throw new Failure('integrity', 0); parent = p.parentId }
    if (context.length < ancestors && parent !== 0n) throw new Failure('integrity', 0)
    return { at: answer.at, record, ancestors: context }
  }
  return { app, message, writeRead, wallet, info, account }
}

export async function discover(config, http) {
  const status = await http.json('/api/status', { name: 'status' })
  if (!status.gateway || !status.store || status.verifier !== 'eth-rpc') throw new Error('the site needs a gateway and a verifying content store')
  const chains = config.chainIds.map((id) => {
    const c = status.chains?.find((c) => c.id === id)
    if (!c || !isAddress(c.contract) || !c.public_rpc_url || !Number.isSafeInteger(c.start_block)) throw new Error(`chain ${id} is not fully advertised by this site`)
    const resolveRoute = (route) => {
      const u = new URL(route, config.site)
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error(`chain ${id} advertises an invalid wallet RPC`)
      return u.href
    }
    return { ...c, public_rpc_url: resolveRoute(c.public_rpc_url) }
  })
  for (const c of chains) {
    const api = clients(http, c)
    const actual = await api.writeRead.getChainId()
    const code = await api.writeRead.getCode({ address: c.contract })
    if (actual !== c.id || !code || code === '0x') throw new Error(`chain ${c.id} identity or Board code differs from status`)
    // Validate the current preview API without relying on an example deployment address.
    await api.app('state', { ids: [], accounts: [], memberships: [] })
  }
  let relay = null
  if (config.sponsored > 0) {
    relay = await http.json('/api/relay/status', { name: 'relay.status' })
    for (const c of chains) if (!same(relay.chains?.find((r) => r.id === c.id)?.contract, c.contract)) throw new Error(`relayer Board differs for chain ${c.id}`)
    if (config.sponsoredPerAuthor > relay.policy.per_author_per_day || config.maxSponsored > relay.policy.global_per_day - relay.today.posts) throw new Error('requested sponsored budget exceeds the advertised remaining policy; lower the budget or use --sponsored 0')
  }
  const maxImage = Math.ceil(config.imageBytes * 1.5) + 512
  if (config.attachments && (!status.store.attachments || maxImage > status.store.attachments.max_bytes || (status.store.attachments.media_types && !status.store.attachments.media_types.includes('image/png')))) throw new Error('the configured image workload exceeds the host attachment policy; use --attachments 0 or smaller images')
  return { status, chains, relay }
}

export async function accounts(config) {
  if (!config.mnemonicFile) return []
  const mnemonic = await secretFile(config.mnemonicFile)
  if (![12, 15, 18, 21, 24].includes(mnemonic.split(/\s+/).length)) throw new Error('the mnemonic file must contain a BIP-39 phrase')
  try {
    return Array.from({ length: config.users }, (_, i) => mnemonicToAccount(mnemonic, { addressIndex: config.offset + i }))
  } catch { throw new Error('could not derive accounts from the mnemonic file') }
}

export async function eligible(api) {
  const result = await api.app('state', { accounts: [api.account.address] })
  if (typeof result.accounts?.[0]?.member !== 'boolean') throw new Failure('integrity', 0)
  return result.accounts[0].member
}

export const recordImage = record

/** Exhaust a bounded host cursor only for the explicit post-run audit. */
export async function auditPages(api, path, query) {
  const found = [], seen = new Set()
  let cursor = null, generation
  do {
    const page = await api.app(path, { ...query, cursor, limit: 50 })
    if (generation !== undefined && generation !== page.at.generation) throw new Failure('integrity', 0, 'index rebuilt during audit')
    generation = page.at.generation
    for (const wire of page.items) { const p = recordImage(wire); if (seen.has(String(p.id))) throw new Failure('integrity', 0); seen.add(String(p.id)); found.push(p) }
    if (page.next && JSON.stringify(page.next) === JSON.stringify(cursor)) throw new Failure('integrity', 0, 'cursor did not progress')
    cursor = page.next
  } while (cursor)
  return found
}

export function eventFromReceipt(receipt, board, intent) {
  if (!same(board, intent.board) || (intent.txHash && !same(receipt.hash, intent.txHash))) throw new Failure('integrity', 0, 'wrong transaction or Board')
  if (receipt.status === 'reverted') throw new Failure('reverted', 0)
  if (receipt.status !== 'success') throw new Failure('integrity', 0)
  const matches = receipt.events.filter((e) => e.kind === 'posted')
  if (matches.length !== 1) throw new Failure('integrity', 0, 'expected exactly one Posted event')
  const m = matches[0].message
  if (!same(m.author, intent.author) || !same(m.content_hash, intent.contentHash) || BigInt(m.parent) !== BigInt(intent.parentId)
    || !same(m.parent_author, intent.parentAuthor) || !same(m.transaction, receipt.hash) || m.position.block !== receipt.block) throw new Failure('integrity', 0, 'Posted fields differ from the signed intent')
  const commitment = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint64' }, { type: 'uint32' }, { type: 'bytes32' }], [m.author, BigInt(m.parent), m.timestamp, m.content_hash]))
  return { id: BigInt(m.id), author: m.author, parentId: BigInt(m.parent), parentAuthor: m.parent_author, contentHash: m.content_hash,
    timestamp: m.timestamp, blockNumber: BigInt(receipt.block), logIndex: m.position.log, txHash: receipt.hash, commitment }
}

export class Nonces {
  constructor() { this.word = 0n; this.next = 256 }
  allocate() {
    if (this.next === 256) { this.word = BigInt(`0x${randomBytes(16).toString('hex')}`) << 8n; this.next = 0 }
    return this.word + BigInt(this.next++)
  }
}

// Valid PNGs with seeded pixels: distinct, bounded and cheap to create without an image dependency.
function crc32(bytes) {
  let crc = 0xffffffff
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}
export function imageRecord(size, rng) {
  const width = 128, height = Math.max(1, Math.floor(size / (width * 3 + 1))), raw = Buffer.alloc(height * (width * 3 + 1))
  for (let row = 0; row < height; row++) for (let col = 1; col <= width * 3; col++) raw[row * (width * 3 + 1) + col] = Math.floor(rng() * 256)
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from('version/1 image/png\n'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

export async function upload(http, intent, proof) {
  for (const record of intent.records) {
    const bytes = Buffer.from(record.bytes, 'base64')
    let attempt = 0
    for (;;) {
      try {
        const query = new URLSearchParams({ chain_id: `${intent.chain}`, ...proof })
        const answer = await http.json(`/api/publish?${query}`, { body: bytes, name: 'upload', chain: intent.chain })
        if (!same(answer.hash, record.hash)) throw new Failure('integrity', 0)
        break
      } catch (e) {
        // Bounded recovery for lag and overload. Every attempt remains a separate measurement.
        if (![404, 403, 409, 429, 503, 507].includes(e.code) || attempt >= 3) throw e
        await sleep(1000 * ++attempt)
      }
    }
  }
}

export async function content(http, hash, chain, id) {
  const answer = await http.request(`/api/content/${hash}?chain_id=${chain}&message_id=${id}`, { name: 'content', chain })
  if (!same(keccak256(answer.bytes), hash)) throw new Failure('integrity', 0)
  return answer.bytes
}

/** Recover by the exact receipt or by author + unique body hash, never by the relayer's predicted id. */
export async function locate(api, intent) {
  if (!same(api.info.contract, intent.board)) throw new Failure('integrity', 0, 'Board differs from the saved intent')
  if (intent.txHash) {
    const receipt = await api.app(`transaction/${intent.txHash}`)
    if (receipt.status === 'pending') return null
    const event = eventFromReceipt(receipt, api.info.contract, intent)
    // A receipt can lead accepted ingestion. The pinned record is the visibility boundary.
    try { await api.message(event.id, 0, event.commitment) } catch (e) { if (e.code === 404 || e.code === 503) return null; throw e }
    return event
  }
  const page = await api.app('lookup', { author: intent.author, parent: intent.parentId, content_hash: intent.contentHash,
    from_block: intent.fromBlock, cursor: intent.lookup?.cursor ?? null, limit: 2 })
  const found = page.items.map(recordImage)
  if (found.length > 1 || found.some((p) => !same(p.author, intent.author) || !same(p.contentHash, intent.contentHash) || String(p.parentId) !== intent.parentId)) throw new Failure('integrity', 0, 'publication lookup does not identify one request')
  if (found.length) { intent.txHash = found[0].txHash; return locate(api, intent) }
  const through = intent.lookup?.through ?? page.at.checkpoint?.block
  if (page.next) intent.lookup = { cursor: page.next, through }
  else { delete intent.lookup; if (through !== undefined && BigInt(through) >= BigInt(intent.fromBlock)) intent.fromBlock = String(BigInt(through) + 1n) }
  return null
}

export async function transmit(api, http, intent) {
  if (intent.signed) {
    const answer = await http.json(`/api/relay/${intent.chain}/post`, { body: JSON.stringify(intent.signed), name: 'relay.post', chain: intent.chain })
    if (!HASH.test(answer?.tx_hash)) throw new Failure('unreadable', 0)
    return answer.tx_hash
  }
  const hash = await api.writeRead.sendRawTransaction({ serializedTransaction: intent.raw })
  if (!same(hash, keccak256(intent.raw))) throw new Failure('integrity', 0)
  return hash
}

export async function prepare(api, http, config, { id, parent, text, image, sponsored, nonce }) {
  const parentId = parent?.id ?? 0n, author = api.account.address
  if (parentId !== 0n) await api.app('admission', { parent: String(parentId), replier: author })
  const records = []
  if (image) { const hash = keccak256(image); records.push({ hash, bytes: image.toString('base64') }); text += `\n\n![test image](record:${hash})` }
  const body = Buffer.from(`version/1 text/plain\n${text}\n`), contentHash = keccak256(body)
  records.unshift({ hash: contentHash, bytes: body.toString('base64') })
  const intent = { version: 1, logicalId: id, chain: api.info.id, board: api.info.contract, author, parentId: `${parentId}`,
    parentAuthor: parent?.author ?? zeroAddress, contentHash, depth: parent ? parent.depth + 1 : 0,
    fromBlock: (await api.app('state', {})).at.checkpoint?.block ?? String(api.info.start_block), createdAt: Date.now(), records, state: 'prepared', mode: sponsored ? 'sponsored' : 'direct' }
  intent.startBlock = intent.fromBlock
  if (sponsored) {
    const message = { author, contentHash, parentId, replyGate: zeroAddress, nonce,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) }
    const sig = await api.account.signTypedData({ domain: boardDomain(api.info), types: POST_TYPES, primaryType: 'Post', message })
    intent.signed = { ...message, parentId: `${parentId}`, nonce: `${nonce}`, deadline: `${message.deadline}`, sig, gateData: '0x' }
  } else {
    const data = encodeFunctionData({ abi: boardAbi, functionName: 'post', args: [contentHash, parentId, zeroAddress, '0x'] })
    const estimate = BigInt((await api.app('post-estimate', { author, content_hash: contentHash, parent: String(parentId), })).gas)
    if (estimate > 500000n) throw new Failure('gas_limit', 0)
    // Fees are read up front and fee and gas filling is left out of the
    // request, so viem does not try eth_fillTransaction, a method the wallet
    // endpoint does not serve and the real client never asks for.
    const fees = await api.writeRead.estimateFeesPerGas()
    const request = await api.wallet.prepareTransactionRequest({ to: api.info.contract, data, gas: estimate, ...fees, parameters: ['chainId', 'nonce', 'type'] })
    const cap = parseGwei(`${config.maxFeeGwei}`)
    if ((request.maxFeePerGas ?? request.gasPrice) > cap) throw new Failure('fee_cap', 0)
    intent.raw = await api.account.signTransaction(request)
    intent.txHash = keccak256(intent.raw)
  }
  return intent
}

/** A send that became uncertain remains uncertain even if a later resend is refused. */
export async function settle(api, http, config, recorder, intent, path, { send = true } = {}) {
  const stop = Date.now() + config.settle
  let nextSend = 0, sends = 0, event = null, uploadAttempt = null, lastError
  let uncertain = intent.state !== 'prepared'
  while (Date.now() < stop) {
    if (send && !event && Date.now() >= nextSend && sends < 4 && (!intent.signed || Number(intent.signed.deadline) * 1000 > Date.now())) {
      intent.state = 'sending'; await save(path, intent) // Recovery material precedes every broadcast, even the first.
      try {
        intent.txHash = await transmit(api, http, intent)
        uncertain = true
        nextSend = Infinity
        if (!uploadAttempt) uploadAttempt = upload(http, intent, { tx_hash: intent.txHash }).catch((e) => { lastError = e })
      } catch (e) {
        if (e.kind === 'integrity') throw e
        if (intent.signed && !uncertain && e.outcome === 'refused' && ![429, 503].includes(e.code)) {
          intent.state = 'refused'; intent.failure = problem(e); await save(path, intent); throw e
        }
        if (!intent.signed || e.outcome !== 'refused') uncertain = true
        lastError = e
        nextSend = e.outcome === 'refused' && ![429, 503].includes(e.code) ? Infinity : Date.now() + 2000 * 2 ** sends
      }
      sends++; await save(path, intent)
    }
    try {
      event = await locate(api, intent)
      await save(path, intent)
      if (event) break
    } catch (e) {
      if (['integrity', 'reverted'].includes(e.kind)) { intent.state = e.kind; intent.failure = problem(e); await save(path, intent); if (uploadAttempt) await uploadAttempt; throw e }
      lastError = e
    }
    await sleep(2000)
  }
  if (uploadAttempt) await uploadAttempt
  if (!event) {
    intent.state = uncertain ? 'unknown' : 'refused'; intent.failure = problem(lastError)
    await save(path, intent); throw new Failure(intent.state, 0)
  }
  intent.event = event; intent.state = 'mined'; intent.minedAt ??= Date.now(); await save(path, intent)
  await recorder.event({ type: 'measure', name: 'publication.included', chain: intent.chain, outcome: 'ok', ms: intent.minedAt - intent.createdAt })
  // Re-upload by canonical id after a held/failed early upload; still no success until a fresh reader verifies all records.
  await upload(http, intent, { message_id: `${event.id}` })
  do {
    try {
      for (const record of intent.records) await content(http, record.hash, intent.chain, event.id)
      intent.state = 'visible'; intent.visibleAt = Date.now(); await save(path, intent)
      await recorder.event({ type: 'measure', name: 'publication.visible', chain: intent.chain, outcome: 'ok', ms: intent.visibleAt - intent.createdAt, depth: intent.depth, mode: intent.mode })
      return { ...event, depth: intent.depth, ending: null, logicalId: intent.logicalId }
    } catch (e) {
      if (e.kind === 'integrity') throw e
      lastError = e
    }
    await sleep(2000)
  } while (Date.now() < stop)
  throw new Failure('content_unavailable', lastError?.code ?? 0)
}

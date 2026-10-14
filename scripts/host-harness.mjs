// HTTP boundary for transaction/recovery tests. The wallet mock in harness
// signs and sends only; application reads must use one of these host routes.
import { decodeEventLog, zeroAddress } from 'viem'
import { answerIndex } from './index-fixture.mjs'
import { load, install as installBase, posted as postedBase, mock, response, author, hash, txHash } from './harness.mjs'
export * from './harness.mjs'
const { host } = await load('lib/host.svelte.ts')
export function curate(accounts = []) {
  mock.chain.curated = true
  const old = host.status?.host_policy
  mock.hostPolicy = { admin: author, admin_chain: mock.chain.id, origin: 'https://client.invalid', revision: String(BigInt(old?.revision ?? '0') + 1n), curated: accounts, blocked: [], bots: [], declared_bots: [], declarations: '0' }
  host.status = { chains: [mock.chain], host_policy: mock.hostPolicy }
}
const { boardAbi } = await load('lib/abi/board.ts')
const { commitment } = await load('lib/api.ts')

export function install() {
  installBase()
  mock.hostPolicy = null
  host.status = { chains: [mock.chain], host_policy: null }
  mock.chain.confirmations = 5
  mock.holdsKey = true
  mock.holdingsCheckpoint = { block: '9', hash: hash('77') }
  mock.holdingsError = false
  mock.lookupError = false
  mock.failRead = null
  mock.membershipEvents = []
  // Body references by message id, as the index records mentions and quotes: { account, reference }.
  mock.associations = new Map()
  mock.transactions = new Map()
  // The index's history and the oldest change it still keeps; a test changes
  // them to act out a rebuild or expired history.
  mock.generation = hash('aa')
  mock.firstRetained = 0n
  const seen = new Set(), changes = []
  let sequence = 0n, head = -1n
  const contentFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (/^\/api\/(relay|content|publish)/.test(url)) return contentFetch(input, init)
    const path = new URL(url, 'https://client.invalid').pathname.split('/').at(-1)
    const ask = init?.body ? JSON.parse(init.body) : {}
    mock.calls.push({ method: url.includes('/message/') ? 'message' : url.includes('/transaction/') ? 'transaction' : path, ...ask, url })
    if (mock.hostStatus !== 200) return response({ error: 'host_unavailable' }, mock.hostStatus)
    if (path === 'host-policy') return response(mock.hostPolicy)
    if (path === 'status') return response(mock.publishedStatus ?? { chains: [mock.chain], keyrings: [] })
    const chainEvents = [...eventsOf(mock.logs), ...mock.membershipEvents]
    for (const event of chainEvents) {
      const key = JSON.stringify(event)
      if (!seen.has(key)) { seen.add(key); changes.push({ sequence: String(++sequence), event: { kind: 'chain', event } }) }
    }
    if (head !== mock.head) { sequence++; head = mock.head }
    const at = { generation: mock.generation, sequence: String(sequence), checkpoint: { block: String(mock.head), hash: hash('77') } }
    const posted = new Map(chainEvents.filter((e) => e.kind === 'posted').map((e) => [BigInt(e.message.id), e.message]))
    const rows = new Map([...new Set([...mock.messages.keys(), ...posted.keys()])].map((id) => [id, row(id, posted)]))
    for (const message of rows.values()) {
      const parent = rows.get(BigInt(message.parent))
      if (parent && !['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'].includes(message.gate)) parent.replies = String(BigInt(parent.replies) + 1n)
    }
    if (mock.failRead?.(url, ask)) return response({ error: 'index_unavailable' }, 503)
    if (url.includes('/transaction/')) {
      mock.calls.at(-1).method = 'transaction'
      if (mock.transactions.has(path)) return response({ hash: path, ...mock.transactions.get(path) })
      if (mock.receiptError) return response({ error: 'receipt_unavailable' }, 503)
      if (mock.receiptMissing) return response({ hash: path, status: 'pending' })
      const events = eventsOf(mock.receiptLogs ?? mock.logs)
      const block = events[0]?.kind === 'posted' ? events[0].message.position.block : events[0]?.position.block ?? '1'
      return response({ hash: path, status: mock.receiptStatus === '0x0' ? 'reverted' : 'success', block, block_hash: hash('77'), events })
    }
    if (path === 'key-holdings') return mock.holdingsError ? response({ error: 'keyring_syncing' }, 503) : response({ checkpoint: mock.holdingsCheckpoint, held: ask.pairs.map(() => mock.holdsKey) })
    if (path === 'admission') {
      if (mock.previewError) return response({ error: mock.previewError.code === 3 ? 'simulation_reverted' : 'admission_unavailable', revert: mock.previewError.data }, mock.previewError.code === 3 ? 422 : 503)
      return response({ gate: mock.previewReply ?? mock.authorGate })
    }
    if (path === 'post-estimate') return response({ gas: '125000' })
    if (path === 'state') {
      if (mock.gateError) return response({ error: 'state_unavailable' }, 503)
      return response({ at, items: (ask.ids ?? []).map((id) => rows.get(BigInt(id)) ?? row(BigInt(id), posted)),
        accounts: (ask.accounts ?? []).map((address) => ({ address, gate: mock.authorGate, member: mock.blocked })),
        memberships: (ask.memberships ?? []).map(() => mock.blocked) })
    }
    if (url.includes('/message/')) {
      mock.calls.at(-1).method = 'message'
      if (mock.gateError) return response({ error: 'message_unavailable' }, 503)
      const message = rows.get(BigInt(path)) ?? row(BigInt(path), posted)
      if (!message) return response({ error: 'message_not_found' }, 404)
      const pin = new URL(url, 'https://client.invalid').searchParams.get('commit')
      if (pin && pin !== message.commitment) return response({ error: 'commitment_mismatch' }, 409)
      rows.set(BigInt(path), message)
      return answerIndex({ chain: mock.chain, rows, at, events: changes, first: mock.firstRetained }, new URL(url, 'https://client.invalid'), init)
    }
    if (path === 'lookup') {
      if (mock.lookupError) return response({ error: 'lookup_unavailable' }, 503)
      const items = [...rows.values()]
        .filter((m) => m.author === ask.author && m.content_hash === ask.content_hash && m.parent === ask.parent && BigInt(m.position.block) >= BigInt(ask.from_block))
      return response({ at, items: items.slice(0, ask.limit), next: null })
    }
    return answerIndex({ chain: mock.chain, rows, at, events: changes, first: mock.firstRetained, policy: mock.hostPolicy, authorGate: mock.authorGate, member: mock.blocked, associations: mock.associations }, new URL(url, 'https://client.invalid'), init)
  }
}

export function posted(post, parent = 0n) {
  return { ...postedBase(post, parent), blockNumber: `0x${mock.head.toString(16)}` }
}

function eventsOf(logs) {
  return logs.filter((l) => l.address.toLowerCase() === mock.chain.contract.toLowerCase()).map((l) => {
    const { eventName, args: a } = decodeEventLog({ abi: boardAbi, data: l.data, topics: l.topics })
    const position = { block: String(BigInt(l.blockNumber)), log: Number(BigInt(l.logIndex)) }
    if (eventName === 'Posted') return { kind: 'posted', message: {
      id: String(a.id), author: a.author.toLowerCase(), parent: String(a.parentId), parent_author: a.parentAuthor.toLowerCase(),
      timestamp: Number(mock.timestampOf(BigInt(l.blockNumber))), content_hash: a.contentHash, transaction: l.transactionHash, position, gate: a.replyGate,
    } }
    if (eventName === 'ReplyGateChanged') return { kind: 'reply_gate', id: String(a.id), old: a.oldGate, new: a.newGate, position }
    if (eventName === 'AuthorGateChanged') return { kind: 'author_gate', author: a.author, old: a.oldGate, new: a.newGate, position }
    throw new Error(`unexpected test event ${eventName}`)
  })
}

function row(id, posts) {
  const posted = posts.get(id)
  const m = mock.messages.get(id)
  if (!posted && !m && mock.onlyKnownMessages) return null
  const record = posted ?? { id: String(id), author: m?.author ?? author, parent: String(m?.parentId ?? 0n),
    parent_author: m?.parentId ? author : zeroAddress, timestamp: Number(m?.timestamp ?? 1700000000),
    content_hash: m?.contentHash ?? hash('66'), transaction: txHash, position: { block: '1', log: 0 } }
  const gate = mock.gates.get(id) ?? mock.perMessageGate
  return { ...record, gate, author_gate: mock.authorGate, effective_gate: gate === zeroAddress ? mock.authorGate : gate, replies: '0',
    commitment: commitment({ author: record.author, parentId: BigInt(record.parent), timestamp: record.timestamp, contentHash: record.content_hash }) }
}

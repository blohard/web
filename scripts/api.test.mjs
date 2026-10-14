import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { zeroAddress } from 'viem'
import { answerIndex } from './index-fixture.mjs'
import { deferred, load, mock, install, teardown, address, hash, response } from './harness.mjs'

const api = await load('lib/api.ts')
const { gates } = await load('lib/gates.svelte.ts')
const { TOMBSTONE, REMOVED } = await load('lib/board.ts')
const { getMessage, readMessage, ancestorsOf, quoteOf, resolveQuote, rememberMessages } = await load('lib/messages.ts')
const { readThread, replySlice, peekReplies } = await load('features/streams/replies.ts')
const quoting = await load('features/publishing/quoting.ts')
const { draft } = await load('features/publishing/draft.svelte.ts')
const { replying } = await load('features/publishing/replying.svelte.ts')
const { router } = await load('features/navigation/router.svelte.ts')
let rows, calls, send, at, events, associations
const generation = hash('ab')


function wire(id) {
  const m = {
    id: String(id), author: address('aa'), parent: String(id - 1), parent_author: id === 1 ? zeroAddress : address('aa'),
    timestamp: 1700000000 + id, content_hash: `0x${id.toString(16).padStart(64, '0')}`, transaction: hash('cc'),
    position: { block: String(id), log: 0 }, gate: zeroAddress, author_gate: zeroAddress, effective_gate: zeroAddress, replies: '0',
  }
  m.commitment = api.commitment({ author: m.author, parentId: BigInt(m.parent), timestamp: m.timestamp, contentHash: m.content_hash })
  return m
}
/** A snapshot read naming this message id: single records are read through the shared snapshot. */
const asksFor = (c, id) => c.url.pathname.endsWith('/state') && JSON.parse(c.init?.body ?? '{}').ids?.includes(String(id))
const collect = async (from, limit) => {
  const out = []
  for await (const r of ancestorsOf(mock.chain, from, limit)) out.push(r)
  return out
}

beforeEach(() => {
  install()
  at = { generation, sequence: '20', checkpoint: { block: '100', hash: hash('ac') } }
  events = []
  associations = new Map()
  rows = new Map(Array.from({ length: 10 }, (_, i) => [BigInt(i + 1), wire(i + 1)]))
  calls = []
  send = (url, init) => answerIndex({ chain: mock.chain, rows, at, events, associations }, url, init)
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://client.invalid')
    calls.push({ url, init })
    return send(url, init)
  }
})
after(teardown)

test('status remains readable with a stopped chain, but proxy refusals still fail', async () => {
  const { getStatus } = await load('lib/store.ts')
  const status = { verifier: 'eth-rpc', chains: [
    { ...mock.chain, index: { state: 'stopped' } },
    { ...mock.chain, id: mock.chain.id + 1, index: { state: 'ready' } },
  ], store: null, gateway: { names: false } }
  for (const code of [200, 503]) {
    send = () => new Response(JSON.stringify(status), { status: code })
    assert.deepEqual(await getStatus(), status)
  }
  for (const [code, body] of [
    [503, '<html>unavailable</html>'],
    [503, JSON.stringify({ error: 'proxy unavailable' })],
    [503, JSON.stringify({ chains: [{ index: { state: 'stopped' } }] })],
    [502, JSON.stringify(status)],
  ]) {
    send = () => new Response(body, { status: code, statusText: 'unavailable' })
    await assert.rejects(getStatus(), (error) => error.status === code)
  }
})

test('the host record pin is recomputed from immutable fields, including the author', () => {
  const original = wire(2)
  const decoded = api.record(original)
  assert.equal(decoded.id, 2n)
  assert.equal(decoded.blockNumber, 2n)
  assert.equal(decoded.timestamp, 1700000002)
  assert.equal(decoded.commitment, original.commitment)
  assert.equal(api.record({ ...original, gate: TOMBSTONE, effective_gate: TOMBSTONE }).commitment, original.commitment)
  assert.throws(() => api.record({ ...original, author: address('bb') }), /inconsistent/)
  assert.throws(() => api.record({ ...original, replies: '-1' }), /integer/)
  assert.throws(() => api.record({ ...original, parent: original.id }), /message/)
  assert.throws(() => api.record({ ...original, effective_gate: TOMBSTONE }), /inconsistent/)
})

test('a thread record and its parent arrive in one host read', async () => {
  const result = await readMessage(mock.chain, 4n, 1)
  assert.equal(result.record.id, 4n)
  assert.deepEqual(result.ancestors.map((m) => m.id), [3n])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.searchParams.get('ancestors'), '1')
  assert.equal((await getMessage(mock.chain, 3n)).id, 3n)
  assert.equal(calls.length, 1, 'the parent joined the record cache')
})

test('cold sibling walks share exactly one request and continue without duplicates', async () => {
  const children = [20n, 21n, 22n].map((id) => ({ id, parentId: 8n }))
  const results = await Promise.all(children.map((child) => collect(child, 5)))
  for (const result of results) assert.deepEqual(result.map((m) => m.id), [8n, 7n, 6n, 5n, 4n])
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.pathname.endsWith('/message/8'))
  assert.equal(calls[0].url.searchParams.get('ancestors'), '4')
  const rest = await collect(results[0].at(-1), 5)
  assert.deepEqual(rest.map((m) => m.id), [3n, 2n, 1n])
  assert.equal(calls.length, 2)
})

test('cached messages and ancestors expose only immutable fields while fresh snapshots carry current state', async () => {
  const first = await readMessage(mock.chain, 4n, 1)
  assert.equal(first.record.gate, zeroAddress)
  assert.equal(first.record.replies, 0)
  const cached = await getMessage(mock.chain, 4n)
  const parents = await collect(cached, 1)
  for (const value of [cached, ...parents]) {
    for (const field of ['gate', 'authorGate', 'effectiveGate', 'replies']) assert.equal(field in value, false)
  }
  assert.equal(calls.length, 1)
  rows.set(4n, { ...rows.get(4n), gate: TOMBSTONE, effective_gate: TOMBSTONE, replies: '2' })
  at = { ...at, sequence: '21' }
  const fresh = await readMessage(mock.chain, 4n)
  assert.equal(fresh.record.gate, TOMBSTONE)
  assert.equal(fresh.record.replies, 2)
  assert.equal(gates.message(mock.chain, 4n), zeroAddress, 'a gate already known moves by the change log, not by a read')
  assert.deepEqual(await getMessage(mock.chain, 4n), cached)
  assert.equal(calls.length, 2)
})

test('an invalid ancestor answer is rejected whole and caches no prefix', async () => {
  const normal = send
  send = async () => response({ at, message: wire(8), ancestors: [wire(7), wire(5)] })
  await assert.rejects(collect({ id: 9n, parentId: 8n }, 3), /out of order/)
  send = normal
  await getMessage(mock.chain, 7n)
  assert.equal(calls.length, 2, 'the earlier valid row was not cached from a bad answer')
})

test('shared record acceptance rejects an entire conflicting batch before updating records or gates', async () => {
  const original = api.record(wire(8))
  assert.deepEqual(rememberMessages(mock.chain, at, [original]), [original])
  const replacement = wire(8)
  replacement.author = address('bb')
  replacement.commitment = api.commitment({ author: replacement.author, parentId: 7n, timestamp: replacement.timestamp, contentHash: replacement.content_hash })
  const prefix = api.record(wire(7))
  assert.throws(() => rememberMessages(mock.chain, at, [prefix, api.record(replacement)]), /reload this page/)
  assert.equal(gates.message(mock.chain, 7n), undefined, 'the rejected prefix did not reach the gate ledger')
  assert.equal((await getMessage(mock.chain, 8n)).author, original.author)
  assert.equal(calls.length, 0)
  await getMessage(mock.chain, 7n)
  assert.equal(calls.length, 1, 'the rejected prefix did not reach the record cache')
})

test('shared record acceptance refuses snapshots behind the gate baseline without caching them', async () => {
  gates.observe(mock.chain, at, [])
  assert.throws(() => rememberMessages(mock.chain, { ...at, sequence: '19' }, [api.record(wire(4))]), /behind this view/)
  assert.equal(gates.message(mock.chain, 4n), undefined)
  await getMessage(mock.chain, 4n)
  assert.equal(calls.length, 1)
})

test('a failed suffix preserves yielded context and the next walk retries', async () => {
  const cached = await getMessage(mock.chain, 8n)
  const normal = send
  send = async () => response({ error: 'index_unavailable' }, 503)
  const got = []
  await assert.rejects((async () => {
    for await (const m of ancestorsOf(mock.chain, { id: 9n, parentId: 8n }, 4)) got.push(m.id)
  })(), /index unavailable/)
  assert.deepEqual(got, [8n])
  send = normal
  assert.deepEqual((await collect(cached, 3)).map((r) => r.id), [7n, 6n, 5n])
  assert.equal(calls.length, 3)
})

test('a supplied pin is checked on cache hits as well as fresh answers', async () => {
  const pin = wire(3).commitment
  assert.equal((await getMessage(mock.chain, 3n, pin)).commitment, pin)
  await assert.rejects(getMessage(mock.chain, 3n, hash('ff')), /commitment/)
  await assert.rejects(readMessage(mock.chain, 4n, 0, pin), /commitment/)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url.searchParams.get('commit'), pin)
})

test('quoting captures the accepted record shown, and pinned thread navigation rejects a replacement', async () => {
  const shown = api.record(wire(3))
  assert.deepEqual(await quoteOf(mock.chain, shown), { chainId: mock.chain.id, id: 3n, commit: shown.commitment })
  await assert.rejects(quoteOf(mock.chain, { ...shown, author: address('ef') }), /no longer matches/)
  await assert.rejects(quoteOf(mock.chain, { ...shown, contentHash: hash('ef') }), /no longer matches/)
  await assert.rejects(readThread(mock.chain, 3n, hash('ff')), /commitment/)
  const valid = await readThread(mock.chain, 3n, shown.commitment)
  assert.equal(valid.record.commitment, shown.commitment)
})

test('a stopped index clears a cached quote preview on refresh, and a rebuilt one reads it again from the new history', async () => {
  const pin = wire(3).commitment, normal = send
  assert.equal((await resolveQuote(mock.chain, 3n, pin)).commitment, pin)
  send = () => response({ error: 'index_unavailable' }, 503)
  assert.equal(await resolveQuote(mock.chain, 3n, pin, true), null)
  send = normal
  assert.equal((await resolveQuote(mock.chain, 3n, pin, true)).commitment, pin)
  at = { ...at, generation: hash('de') }
  calls.length = 0
  assert.equal((await resolveQuote(mock.chain, 3n, pin, true)).commitment, pin)
  assert.ok(calls.some((c) => asksFor(c, 3)), 'the old history\'s cached preview is not reused')
  // A new history whose post 3 is other content fails the pinned quote.
  at = { ...at, generation: hash('df') }
  const other = { ...wire(3), content_hash: hash('ee') }
  other.commitment = api.commitment({ author: other.author, parentId: BigInt(other.parent), timestamp: other.timestamp, contentHash: other.content_hash })
  rows.set(3n, other)
  assert.equal(await resolveQuote(mock.chain, 3n, pin, true), null)
})

test('a quote whose host could not be asked on first load is a failure to retry, not an unavailable post', async () => {
  const pin = wire(3).commitment, normal = send
  send = () => response({ error: 'index_unavailable' }, 503)
  await assert.rejects(resolveQuote(mock.chain, 3n, pin), /index unavailable/)
  send = normal
  assert.equal((await resolveQuote(mock.chain, 3n, pin)).commitment, pin, 'the retry finds it')
  rows.delete(4n)
  assert.equal(await resolveQuote(mock.chain, 4n, pin), null, 'an unknown post is an answer')
})

test('loading a quote checks its pin but leaves other posts on screen as they are until a refresh', async () => {
  const pin = wire(3).commitment
  await getMessage(mock.chain, 2n)
  assert.equal(await gates.ensureMessage(mock.chain, 2n), zeroAddress)
  changed(removal(2))
  calls.length = 0
  assert.equal((await resolveQuote(mock.chain, 3n, pin)).commitment, pin)
  assert.equal(await resolveQuote(mock.chain, 3n, hash('ff')), null, 'a wrong pin still fails on first load')
  assert.equal(gates.message(mock.chain, 2n), zeroAddress, 'a post deleted elsewhere does not collapse because a quote loaded')
  assert.ok(!calls.some((c) => c.url.pathname.endsWith('/changes')))
  assert.equal((await resolveQuote(mock.chain, 3n, pin, true)).commitment, pin)
  assert.equal(gates.message(mock.chain, 2n), TOMBSTONE, 'a refresh applies it')
})

test('unknown ids are not remembered, and a new index generation replaces cached records once the host confirms it', async () => {
  const { gates } = await load('lib/gates.svelte.ts')
  rows.delete(2n)
  await assert.rejects(getMessage(mock.chain, 2n), /message not found/)
  rows.set(2n, wire(2))
  assert.equal((await getMessage(mock.chain, 2n)).id, 2n)
  at = { ...at, generation: hash('bc') }
  await assert.rejects(getMessage(mock.chain, 3n), (e) => e.code === 'reset_required', 'refused until the host\'s head confirms the rebuild')
  await gates.advanceToHead(mock.chain)
  assert.equal((await getMessage(mock.chain, 3n)).id, 3n, 'the new history is read')
  calls.length = 0
  assert.equal((await getMessage(mock.chain, 2n)).id, 2n)
  assert.equal(calls.length, 1, 'the old history\'s record is read again, not served from the cache')
})

test('oversized answers cancel their stream and proxy failures expose no text', async () => {
  let cancelled = false
  send = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(700000)) },
    cancel() { cancelled = true },
  }))
  await assert.rejects(api.request(mock.chain, 'state', {}), /too large/)
  assert.equal(cancelled, true)
  send = async () => new Response('secret upstream https://private.invalid/?key=secret', { status: 502 })
  await assert.rejects(api.request(mock.chain, 'state', {}), (error) => error instanceof api.ApiError && !error.message.includes('secret'))
})

/** Entries the host looks through per changes page (host/src/index/changes.rs). */
const PAGE = 2000
function changed(event) {
  const sequence = String(BigInt(at.sequence) + 1n)
  at = { ...at, sequence, checkpoint: { block: (event.position ?? event.message.position).block, hash: hash('ad') } }
  events.push({ sequence, event: { kind: 'chain', event } })
}
const removal = (id, gate = TOMBSTONE) => ({ kind: 'reply_gate', id: String(id), old: zeroAddress, new: gate, position: { block: '101', log: 0 } })

test('a quote by an author deactivated elsewhere leaves that author\'s cards as shown until a refresh', async () => {
  const author = address('aa')
  await getMessage(mock.chain, 2n)
  assert.equal(await gates.ensureAuthor(mock.chain, author), zeroAddress)
  changed({ kind: 'author_gate', author, old: zeroAddress, new: TOMBSTONE, position: { block: '101', log: 0 } })
  for (const [id, r] of rows) rows.set(id, { ...r, author_gate: TOMBSTONE, effective_gate: TOMBSTONE })
  const pin = wire(3).commitment
  assert.equal((await resolveQuote(mock.chain, 3n, pin)).commitment, pin)
  assert.equal(gates.author(mock.chain, author), zeroAddress, 'the quote\'s read does not deactivate cards already shown')
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.author(mock.chain, author), TOMBSTONE, 'a refresh applies it')
})

test('a read covering this reader\'s own receipt confirms it instead of reverting it', async () => {
  await getMessage(mock.chain, 5n)
  assert.equal(await gates.ensureMessage(mock.chain, 5n), zeroAddress)
  gates.settleMessage(mock.chain, 5n, TOMBSTONE, { block: 150n, index: 0 })
  rows.set(5n, { ...rows.get(5n), gate: TOMBSTONE, effective_gate: TOMBSTONE })
  at = { ...at, sequence: '30', checkpoint: { block: '149', hash: hash('ae') } }
  await readMessage(mock.chain, 5n)
  assert.equal(gates.message(mock.chain, 5n), TOMBSTONE, 'a read before the receipt\'s block keeps the overlay')
  at = { ...at, sequence: '31', checkpoint: { block: '150', hash: hash('af') } }
  await readMessage(mock.chain, 5n)
  assert.equal(gates.message(mock.chain, 5n), TOMBSTONE, 'the covering read confirms the delete')
})

test('indexed gate changes update cards without another state read', async () => {
  await getMessage(mock.chain, 2n)
  assert.equal(await gates.ensureMessage(mock.chain, 2n), zeroAddress)
  changed(removal(2))
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.message(mock.chain, 2n), TOMBSTONE)
  assert.equal(calls.length, 2)
  assert.ok(calls[1].url.pathname.endsWith('/changes'))
})

test('a change learned while an unknown gate read is out wins over that read', async () => {
  await getMessage(mock.chain, 1n)
  const normal = send, started = deferred(), held = deferred()
  send = async (url, init) => {
    const answer = await normal(url, init)
    if (url.pathname.endsWith('/state')) { started.resolve(); await held.promise }
    return answer
  }
  const reading = gates.ensureMessage(mock.chain, 2n)
  await started.promise
  changed(removal(2))
  await gates.advanceToHead(mock.chain)
  held.resolve()
  assert.equal(await reading, TOMBSTONE)
})

test('a read predating the first baseline is repeated instead of losing intervening changes', async () => {
  const normal = send, started = deferred(), held = deferred()
  let states = 0
  send = async (url, init) => {
    const answer = await normal(url, init)
    if (url.pathname.endsWith('/state') && ++states === 1) { started.resolve(); await held.promise }
    return answer
  }
  const reading = gates.ensureMessage(mock.chain, 2n)
  await started.promise
  at = { ...at, sequence: '21', checkpoint: { block: '101', hash: hash('ac') } }
  rows.set(2n, { ...rows.get(2n), gate: TOMBSTONE, effective_gate: TOMBSTONE })
  await gates.ensureAuthor(mock.chain, address('aa'))
  held.resolve()
  assert.equal(await reading, TOMBSTONE)
  assert.equal(states, 3, 'the second message read is fresh; the account established the baseline')
})

test('a branch whose first reply page predates the gate baseline reads it once more', async () => {
  const { readRoot } = await load('features/streams/replies.ts')
  const normal = send, started = deferred(), held = deferred()
  let pages = 0
  send = async (url, init) => {
    const answer = await normal(url, init)
    if (url.pathname.endsWith('/replies') && ++pages === 1) { started.resolve(); await held.promise }
    return answer
  }
  const opening = readRoot(mock.chain, 1n)
  await Promise.race([started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('the branch never read a reply page')), 2000).unref())])
  at = { ...at, sequence: '21', checkpoint: { block: '101', hash: hash('ac') } }
  await gates.ensureAuthor(mock.chain, address('aa'))
  held.resolve()
  assert.equal((await opening).record.id, 1n)
  assert.equal(pages, 2, 'the account established the baseline; the second page read is current')
})

// ---- a first thread read overlaps the ledger's advance, and applies after it
const holdOn = (match) => {
  const normal = send, gate = deferred()
  const seen = []
  send = async (url, init) => {
    seen.push(url.pathname)
    const answer = await normal(url, init)
    if (match(url.pathname)) await gate.promise
    return answer
  }
  return { release: gate.resolve, seen }
}

for (const view of ['thread', 'branch']) test(`a first ${view} read goes out with the ledger's advance`, async () => {
  const { readThread, readRoot } = await load('features/streams/replies.ts')
  await getMessage(mock.chain, 2n) // the ledger now has a position to advance from
  const changes = holdOn((path) => path.endsWith('/changes'))
  const opening = view === 'thread' ? readThread(mock.chain, 3n) : readRoot(mock.chain, 3n)
  for (let i = 0; i < 5; i++) await new Promise(setImmediate)
  const first = view === 'thread' ? '/message/3' : '/replies'
  assert.ok(changes.seen.some((p) => p.endsWith(first)), 'the first read waited for the advance')
  changes.release()
  assert.equal((await opening).record.id, 3n)
})

const opens = { thread: '/message/3', branch: '/replies' }
const openView = async (view) => {
  const { readThread, readRoot } = await load('features/streams/replies.ts')
  return view === 'thread' ? readThread(mock.chain, 3n) : readRoot(mock.chain, 3n)
}

for (const view of ['thread', 'branch']) for (const first of ['root', 'changes']) test(`whichever answers first, a ${view}'s root applies after the ledger's advance (${first} first)`, async () => {
  await getMessage(mock.chain, 2n)
  // The change log deletes #3; the root's newer answer says removed. Applying
  // the log first, as when the reads ran in turn, keeps the log's gate.
  changed(removal(3))
  rows.set(3n, { ...rows.get(3n), gate: REMOVED, effective_gate: REMOVED })
  at = { ...at, sequence: String(BigInt(at.sequence) + 1n) }
  const held = holdOn((path) => path.endsWith(first === 'root' ? '/changes' : opens[view]))
  const opening = openView(view)
  for (let i = 0; i < 5; i++) await new Promise(setImmediate)
  held.release()
  const opened = await opening
  assert.equal(gates.message(mock.chain, 3n), TOMBSTONE)
  assert.equal(opened.gate, TOMBSTONE)
})

test('a failed advance or root read is the failure reported, and nothing is applied from the other', async () => {
  const { readThread } = await load('features/streams/replies.ts')
  await getMessage(mock.chain, 2n)
  const normal = send
  for (const [failing, status] of [['/changes', 503], ['/message/3', 502]]) {
    send = async (url, init) => url.pathname.endsWith(failing) ? response({ error: 'unavailable' }, status) : normal(url, init)
    await assert.rejects(readThread(mock.chain, 3n), (e) => e instanceof api.ApiError && e.status === status, failing)
  }
  send = normal
  assert.equal((await readThread(mock.chain, 3n)).record.id, 3n, 'the next open reads it')
})

for (const view of ['thread', 'branch']) for (const lost of ['expired history', 'a rebuild']) test(`a first ${view} read overlapping ${lost} opens from the host's current history`, async () => {
  await getMessage(mock.chain, 2n)
  if (lost === 'a rebuild') at = { ...at, generation: hash('de') }
  const oldest = lost === 'expired history' ? 1000 : 0
  send = (url, init) => answerIndex({ chain: mock.chain, rows, at, events, associations, first: oldest }, url, init)
  const opened = await openView(view)
  assert.equal(opened.record.id, 3n)
  if (view === 'thread') assert.equal(opened.parent.id, 2n)
  assert.equal(opened.replies.at.generation, at.generation)
  assert.equal(gates.generation(mock.chain), at.generation)
})

for (const view of ['thread', 'branch']) test(`a ${view}'s first answer arriving after its advance failed changes nothing`, async () => {
  await getMessage(mock.chain, 2n)
  const normal = send, late = deferred()
  let failAdvance = true
  send = async (url, init) => {
    if (failAdvance && url.pathname.endsWith('/changes')) return response({ error: 'unavailable' }, 503)
    const answer = await normal(url, init)
    if (failAdvance && url.pathname.endsWith(opens[view])) await late.promise
    return answer
  }
  await assert.rejects(openView(view), (e) => e.status === 503)
  // The next open reads afresh, with the post since deleted; the stale answer then lands.
  failAdvance = false
  changed(removal(3))
  rows.set(3n, { ...rows.get(3n), gate: TOMBSTONE, effective_gate: TOMBSTONE })
  const reopened = await openView(view)
  late.resolve()
  for (let i = 0; i < 5; i++) await new Promise(setImmediate)
  assert.equal(reopened.gate, TOMBSTONE)
  assert.equal(gates.message(mock.chain, 3n), TOMBSTONE, 'the late answer from the failed open is never applied')
  assert.equal(reopened.replies.session.records.get(3n).record.gate, TOMBSTONE)
})

test('a receipt leads the accepted index until a snapshot covers its block', async () => {
  await getMessage(mock.chain, 2n)
  gates.settleMessage(mock.chain, 2n, TOMBSTONE, { block: 101n, index: 0 })
  await readMessage(mock.chain, 2n)
  assert.equal(gates.message(mock.chain, 2n), TOMBSTONE, 'the older snapshot cannot undo a receipt')
  changed(removal(2))
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.message(mock.chain, 2n), TOMBSTONE)
  // An author gate is mutable: a later event in the receipt's block wins.
  gates.settleAuthor(mock.chain, address('aa'), address('bb'), { block: 102n, index: 0 })
  changed({ kind: 'author_gate', author: address('aa'), old: zeroAddress, new: address('cc'), position: { block: '102', log: 1 } })
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.author(mock.chain, address('aa')), address('cc'))
  gates.settleAuthor(mock.chain, address('aa'), address('bb'), { block: 102n, index: 0 })
  assert.equal(gates.author(mock.chain, address('aa')), address('cc'), 'a delayed earlier receipt does not override indexed state')
})

test('a failed change read leaves the cursor retryable, and concurrent refreshes share it', async () => {
  await getMessage(mock.chain, 2n)
  changed(removal(2))
  const normal = send
  send = async () => response({ error: 'index_unavailable' }, 503)
  await assert.rejects(gates.advanceToHead(mock.chain), /index unavailable/)
  send = normal
  await Promise.all([gates.advanceToHead(mock.chain), gates.advanceToHead(mock.chain)])
  const requests = calls.filter((c) => c.url.pathname.endsWith('/changes'))
  assert.equal(requests.length, 2)
  for (const r of requests) assert.equal(JSON.parse(r.init.body).after, '20')
  assert.equal(gates.message(mock.chain, 2n), TOMBSTONE)
})

test('a captured gate refresh neither follows new traffic forever nor expires a later receipt', async () => {
  feedRows(1)
  await getMessage(mock.chain, 1n)
  for (let id = 2; id <= PAGE + 2; id++) addPost(id)
  const normal = send
  let first = true
  send = async (url, init) => {
    const answer = await normal(url, init)
    if (url.pathname.endsWith('/changes') && first) {
      first = false
      addPost(PAGE + 3)
      rows.set(1n, { ...rows.get(1n), gate: TOMBSTONE, effective_gate: TOMBSTONE })
      changed({ ...removal(1), position: { block: String(PAGE + 4), log: 0 } })
      gates.settleMessage(mock.chain, 1n, TOMBSTONE, { block: BigInt(PAGE + 4), index: 0 })
    }
    return answer
  }
  await gates.advanceToHead(mock.chain)
  const requests = calls.filter((c) => c.url.pathname.endsWith('/changes')).map((c) => JSON.parse(c.init.body))
  assert.equal(requests.length, 2)
  assert.equal(requests[1].until.sequence, String(PAGE + 2))
  assert.equal(gates.message(mock.chain, 1n), TOMBSTONE, 'a later snapshot must not expire the receipt while the scan stops at its captured boundary')
  assert.equal(gates.message(mock.chain, BigInt(PAGE + 3)), undefined, 'unrelated posts are not retained in the gate ledger')
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.message(mock.chain, 1n), TOMBSTONE)
})

test('filtered change pages advance through noise, and the host cannot change their boundary', async () => {
  feedRows(1)
  const from = structuredClone(at)
  for (let id = 2; id <= PAGE + 2; id++) addPost(id)
  const scope = { feed: { any: [{ authors: [address('dd')] }] }, gates: false }
  const first = await api.changes(mock.chain, from, scope)
  assert.deepEqual(first.changes, [])
  assert.deepEqual(first.records, [])
  assert.equal(first.through, String(PAGE + 1))
  const next = api.afterChanges(from, first)
  assert.equal(next.checkpoint.block, '1', 'an incomplete scan certifies no later block')
  addPost(PAGE + 3)
  const last = await api.changes(mock.chain, next, scope, first.until)
  assert.equal(last.through, String(PAGE + 2))
  assert.equal(last.more, false)
  assert.equal(api.afterChanges(next, last).checkpoint.block, String(PAGE + 2))
  const normal = send
  send = async (url, init) => {
    const data = await (await normal(url, init)).json()
    return response({ ...data, until: at, through: at.sequence })
  }
  await assert.rejects(api.changes(mock.chain, next, scope, first.until), /boundary/)
})

test('independent snapshots share requests capped at fifty entries and keep their own answers', async () => {
  const accounts = Array.from({ length: 61 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)
  const results = await Promise.all(accounts.map((who) => api.snapshots(mock.chain, [], [who])))
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => JSON.parse(c.init.body).accounts.length), [50, 11])
  assert.deepEqual(results.map((r) => r.accounts[0].address), accounts)
  assert.ok(results.every((r) => r.at.generation === generation))
})

test('a block membership question asks for one indexed key, not the full list', async () => {
  const { contains } = await load('lib/registry.ts')
  const list = { registry: address('11'), owner: address('aa'), id: hash('01') }
  assert.equal(await contains(mock.chain, list, address('bb')), false)
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0].init.body).memberships, [{ list: { registry: list.registry, owner: list.owner, list: list.id }, member: address('bb') }])
})

function postRow(id, parent = 0, who = address('aa')) {
  const row = { ...wire(id), parent: String(parent), author: who, parent_author: parent === 0 ? zeroAddress : rows.get(BigInt(parent))?.author ?? address('aa') }
  row.commitment = api.commitment({ author: row.author, parentId: BigInt(row.parent), timestamp: row.timestamp, contentHash: row.content_hash })
  return row
}
function feedRows(count) {
  rows.clear()
  for (let id = 1; id <= count; id++) rows.set(BigInt(id), postRow(id))
  at = { ...at, sequence: String(count), checkpoint: { block: String(count), hash: hash('ac') } }
}
function addPost(id, parent = 0) {
  const row = postRow(id, parent)
  rows.set(BigInt(id), row)
  if (parent) { const target = rows.get(BigInt(parent)); rows.set(BigInt(parent), { ...target, replies: String(Number(target.replies) + 1) }) }
  changed({ kind: 'posted', message: row })
}

test('a cold feed reads twenty host records with counts and grows by cursor pages', async () => {
  const { loadFeed, olderFeed } = await load('features/streams/feed.ts')
  feedRows(60)
  const filter = { kind: 'timeline' }
  const first = await loadFeed(mock.chain, filter)
  await first.countsReady
  assert.equal(first.limit, 20)
  assert.equal(first.rows.length, 20)
  assert.equal(first.counts.get(60n), 0)
  assert.equal(calls.length, 1)
  const second = await olderFeed(mock.chain, filter)
  await second.countsReady
  assert.equal(second.limit, 40)
  assert.equal(second.rows.length, 40)
  assert.equal(calls.length, 2)
  const asks = calls.map((c) => JSON.parse(c.init.body))
  assert.equal(asks[0].cursor, null)
  assert.equal(asks[1].cursor.before, '41')
  assert.ok(calls.every((c) => c.url.pathname.endsWith('/feed')))
})

test('refresh merges new records and preserves every previously displayed live row', async () => {
  const { loadFeed } = await load('features/streams/feed.ts')
  feedRows(30)
  const filter = { kind: 'timeline' }
  const first = await loadFeed(mock.chain, filter)
  await first.countsReady
  const old = first.rows.map((r) => r.key)
  for (let id = 31; id <= 35; id++) addPost(id)
  const updated = await loadFeed(mock.chain, filter)
  await updated.countsReady
  assert.equal(updated.limit, 25)
  assert.deepEqual(updated.rows.slice(5).map((r) => r.key), old)
  assert.equal(calls.length, 2, 'one feed request, then one changes request; no count scan or second gate query')
  const remounted = await loadFeed(mock.chain, filter, { limit: 20, preserveVisibleRows: false })
  assert.equal(remounted.limit, 20, 'a new mount resets the visible limit')
})

test('a quiet feed poll changes neither the rows nor the gates before refresh', async () => {
  const { loadFeed, peekFeed } = await load('features/streams/feed.ts')
  feedRows(20)
  const filter = { kind: 'timeline' }
  const first = await loadFeed(mock.chain, filter)
  await first.countsReady
  rows.set(1n, { ...rows.get(1n), gate: TOMBSTONE, effective_gate: TOMBSTONE })
  changed({ ...removal(1), position: { block: '21', log: 0 } })
  addPost(22)
  assert.equal(await peekFeed(mock.chain, filter), 1)
  assert.equal(first.rows.length, 20)
  assert.equal(gates.message(mock.chain, 1n), zeroAddress)
  const refreshed = await loadFeed(mock.chain, filter)
  assert.equal(gates.message(mock.chain, 1n), TOMBSTONE)
  assert.ok(refreshed.rows.every((r) => r.lead.id !== 1n))
})

test('following nobody is empty and grouped replies do not finish a page early', async () => {
  const { loadFeed } = await load('features/streams/feed.ts')
  feedRows(2)
  for (let id = 3; id <= 27; id++) addPost(id, 2)
  const empty = await loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: false, authors: [] })
  assert.equal(empty.rows.length, 0)
  assert.equal(empty.complete, true)
  const view = await loadFeed(mock.chain, { kind: 'following', includeRepliesToViewer: false, authors: [address('aa')] })
  await view.countsReady
  assert.equal(view.rows.length, 2, 'twenty-five replies form one conversation; the older post is still found')
  assert.equal(view.complete, true)
  assert.equal(view.counts.get(2n), 25)
  const asks = calls.filter((c) => c.url.pathname.endsWith('/feed'))
  assert.equal(asks.length, 3, 'empty view, first page and continuation')
})

test('a failed older page preserves its cursor and a later refresh resumes it', async () => {
  const { loadFeed, olderFeed } = await load('features/streams/feed.ts')
  feedRows(60)
  const filter = { kind: 'timeline' }
  const first = await loadFeed(mock.chain, filter)
  await first.countsReady
  const normal = send
  let refuse = true
  send = (url, init) => url.pathname.endsWith('/feed') && refuse
    ? response({ error: 'index_unavailable' }, 503) : normal(url, init)
  await assert.rejects(olderFeed(mock.chain, filter), /index unavailable/)
  assert.equal(first.rows.length, 20)
  refuse = false
  const resumed = await loadFeed(mock.chain, filter)
  assert.equal(resumed.rows.length, 40)
  assert.equal(resumed.limit, 40)
  const continuations = calls.filter((c) => c.url.pathname.endsWith('/feed')).slice(1)
  assert.deepEqual(continuations.map((c) => JSON.parse(c.init.body).cursor.before), ['41', '41'])
  const before = calls.length
  await loadFeed(mock.chain, filter)
  assert.equal(calls.length, before + 1, 'an ordinary later refresh asks only for changes')
})

function referenceDiscovered(id, account, reference = { kind: 'mention', account }) {
  associations.set(BigInt(id), { account, reference })
  const sequence = String(BigInt(at.sequence) + 1n)
  at = { ...at, sequence }
  events.push({ sequence, event: { kind: 'references', id: String(id) } })
}

test('notifications read indexed reasons without downloading bodies or resolving quote authors', async () => {
  const { findNotifications } = await load('features/notifications/notifications.ts')
  feedRows(60)
  const me = address('bb')
  referenceDiscovered(2, me)
  const target = { chain: '43', id: '7', commit: hash('ee') }
  referenceDiscovered(50, me, { kind: 'quote', target })
  const result = await findNotifications([mock.chain], me)
  assert.deepEqual(result.items.map((r) => r.post.id), [50n, 2n])
  assert.deepEqual(result.items[0].quoted, { chainId: 43, id: 7n, commit: hash('ee') })
  assert.equal(result.items[1].kind, 'mention')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.pathname.endsWith('/notifications'))
  assert.equal(result.complete, true)
})

test('a late body behind the reference cursor arrives through changes without a new block', async () => {
  const { findNotifications } = await load('features/notifications/notifications.ts')
  feedRows(60)
  const me = address('bb')
  const first = await findNotifications([mock.chain], me)
  assert.equal(first.items.length, 0)
  const block = at.checkpoint.block
  referenceDiscovered(2, me)
  const second = await findNotifications([mock.chain], me)
  assert.deepEqual(second.items.map((r) => r.post.id), [2n])
  assert.equal(at.checkpoint.block, block)
  assert.equal(calls.length, 2)
  assert.ok(calls[1].url.pathname.endsWith('/changes'))
  assert.equal(JSON.parse(calls[1].init.body).scope.account, me)
})

test('reference history is paginated and a failed page is retried at the same cursor', async () => {
  const { findNotifications } = await load('features/notifications/notifications.ts')
  feedRows(30)
  const me = address('bb')
  for (let id = 1; id <= 30; id++) referenceDiscovered(id, me)
  const first = await findNotifications([mock.chain], me)
  assert.equal(first.items.length, 20)
  assert.equal(first.complete, false)
  const normal = send
  send = (url, init) => url.pathname.endsWith('/notifications') ? response({ error: 'index_unavailable' }, 503) : normal(url, init)
  await assert.rejects(findNotifications([mock.chain], me, 40), /index unavailable/)
  send = normal
  const resumed = await findNotifications([mock.chain], me, 40)
  assert.equal(resumed.items.length, 30)
  assert.equal(resumed.complete, true)
  const pages = calls.filter((c) => c.url.pathname.endsWith('/notifications')).slice(1)
  assert.deepEqual(pages.map((c) => JSON.parse(c.init.body).cursor.before), ['11', '11'])
})


function threadRows(count = 40) {
  feedRows(1)
  for (let id = 2; id <= count + 1; id++) addPost(id, 1)
}
const replyRequests = () => calls.filter((c) => c.url.pathname.endsWith('/replies')).map((c) => JSON.parse(c.init.body))

test('thread entry reads its parent and counts together; only an opened branch is fetched', async () => {
  threadRows(2)
  addPost(4, 2)
  const root = await readThread(mock.chain, 2n)
  assert.equal(root.parent.id, 1n)
  assert.equal(root.replies.counts.get(2n), 1)
  assert.equal(calls.length, 1)
  const slice = await replySlice(mock.chain, root.replies, 2n, 20)
  assert.deepEqual(slice.list.map((r) => r.id), [4n])
  assert.equal(slice.children.counts.get(4n), 0)
  assert.deepEqual(replyRequests().map((r) => r.parent), ['2'])
})

test('thread pages append by cursor and a refresh retains the complete branch', async () => {
  threadRows(40)
  const first = await readThread(mock.chain, 1n)
  const one = await replySlice(mock.chain, first.replies, 1n, 20)
  assert.equal(one.list.length, 20)
  assert.equal(one.more, true)
  const two = await replySlice(mock.chain, first.replies, 1n, 40)
  assert.equal(two.list.length, 40)
  assert.equal(two.more, false)
  addPost(42, 1)
  const updated = await readThread(mock.chain, 1n)
  const three = await replySlice(mock.chain, updated.replies, 1n, 41)
  assert.deepEqual(three.list.slice(0, 40), two.list)
  assert.equal(three.list.at(-1).id, 42n)
  assert.equal(three.total, 41)
  assert.deepEqual(replyRequests().map((r) => r.cursor?.after ?? null), [null, '21'])
})

test('a failed thread page retries its cursor without losing displayed rows', async () => {
  threadRows(40)
  const root = await readThread(mock.chain, 1n)
  const first = await replySlice(mock.chain, root.replies, 1n, 20)
  const normal = send
  send = (url, init) => url.pathname.endsWith('/replies') ? response({ error: 'index_unavailable' }, 503) : normal(url, init)
  await assert.rejects(replySlice(mock.chain, root.replies, 1n, 40), /index unavailable/)
  assert.equal(first.list.length, 20)
  send = normal
  const next = await replySlice(mock.chain, root.replies, 1n, 40)
  assert.equal(next.list.length, 40)
  assert.deepEqual(replyRequests().map((r) => r.cursor?.after ?? null), [null, '21', '21'])
})

test('a refresh adds to a branch whose first page is still in flight', async () => {
  threadRows(2)
  const root = await readThread(mock.chain, 1n)
  const normal = send, started = deferred(), held = deferred()
  send = async (url, init) => {
    const answer = await normal(url, init)
    if (url.pathname.endsWith('/replies')) { started.resolve(); await held.promise }
    return answer
  }
  const reading = replySlice(mock.chain, root.replies, 1n, 20)
  await started.promise
  addPost(4, 1)
  await readThread(mock.chain, 1n)
  held.resolve()
  const slice = await reading
  assert.deepEqual(slice.list.map((r) => r.id), [2n, 3n, 4n])
  assert.equal(slice.total, 3, 'the late old parent snapshot cannot overwrite the new count')
  assert.equal(replyRequests().length, 1)
})

test('a branch opened during a captured refresh starts its snapshot after that refresh', async () => {
  threadRows(2)
  const root = await readThread(mock.chain, 1n)
  await replySlice(mock.chain, root.replies, 1n, 20)
  const normal = send, started = deferred(), held = deferred()
  send = async (url, init) => {
    const answer = await normal(url, init)
    if (url.pathname.endsWith('/changes')) { started.resolve(); await held.promise }
    return answer
  }
  const refresh = readThread(mock.chain, 1n)
  await started.promise
  const opening = replySlice(mock.chain, root.replies, 2n, 20)
  await new Promise((r) => setImmediate(r))
  assert.equal(replyRequests().filter((r) => r.parent === '2').length, 0)
  addPost(4, 2)
  held.resolve()
  await refresh
  assert.deepEqual((await opening).list.map((r) => r.id), [4n])
})

test('thread polling excludes deleted replies, removals and unopened branches, and changes no rows', async () => {
  threadRows(2)
  const root = await readThread(mock.chain, 1n)
  const first = await replySlice(mock.chain, root.replies, 1n, 20)
  addPost(4, 1)
  addPost(5, 2)
  addPost(6, 1)
  rows.set(6n, { ...rows.get(6n), gate: TOMBSTONE, effective_gate: TOMBSTONE })
  addPost(7, 1)
  rows.set(7n, { ...rows.get(7n), gate: REMOVED, effective_gate: REMOVED })
  rows.set(1n, { ...rows.get(1n), replies: '3' })
  changed(removal(6)); changed(removal(7, REMOVED))
  assert.equal(await peekReplies(mock.chain, root.replies, [1n, 2n]), 1)
  assert.deepEqual(first.list.map((r) => r.id), [2n, 3n])
  assert.equal(gates.message(mock.chain, 6n), undefined, 'a quiet poll never publishes gates')
  const updated = await readThread(mock.chain, 1n)
  const next = await replySlice(mock.chain, updated.replies, 1n, 20)
  assert.deepEqual(next.list.map((r) => r.id), [2n, 3n, 4n])
  assert.equal(replyRequests().length, 1)
})

test('a thread poll carries the reader\'s notifications to a listener without changing its count', async () => {
  threadRows(0)
  const root = await readThread(mock.chain, 1n)
  await replySlice(mock.chain, root.replies, 1n, 20)
  addPost(2, 1)
  const reader = address('33'), answers = []
  calls.length = 0
  assert.equal(await peekReplies(mock.chain, root.replies, [1n], { account: reader, heard: (answer) => answers.push(answer) }), 1)
  const asked = calls.filter((c) => c.url.pathname.endsWith('/changes'))
  assert.equal(asked.length, 1, 'one request serves the thread and the listener')
  const scope = JSON.parse(asked[0].init.body).scope
  assert.equal(scope.account, reader)
  assert.deepEqual(scope.feed, { any: [{ parent_authors: [reader], kind: 'replies' }] })
  assert.deepEqual(scope.parents, ['1'])
  assert.equal(answers.length, 1)
})

test('incomplete thread branches do not cue replies hidden behind their older pages', async () => {
  threadRows(40)
  const root = await readThread(mock.chain, 1n)
  await replySlice(mock.chain, root.replies, 1n, 20)
  addPost(42, 1)
  const before = calls.length
  assert.equal(await peekReplies(mock.chain, root.replies, [1n]), 0)
  assert.equal(calls.length, before)
})

test('an explicit landed reply is reached without refetching the displayed prefix', async () => {
  threadRows(45)
  const root = await readThread(mock.chain, 1n)
  await replySlice(mock.chain, root.replies, 1n, 20)
  addPost(47, 1)
  const updated = await readThread(mock.chain, 1n)
  const revealed = await replySlice(mock.chain, updated.replies, 1n, 20, 47n)
  assert.equal(revealed.list.at(-1).id, 47n)
  assert.equal(revealed.more, true)
  assert.equal(revealed.loaded, 20)
  assert.equal(revealed.tailStart, 47n)
  assert.deepEqual(replyRequests().map((r) => r.cursor?.after ?? null), [null])
})

test('change traversal commits only applied pages and retries a failed page from that cursor', async () => {
  feedRows(1)
  let saved = structuredClone(at)
  const initial = structuredClone(at)
  for (let id = 2; id <= PAGE + 2; id++) addPost(id)
  const normal = send
  let pages = 0
  send = (url, init) => ++pages === 2 ? response({ error: 'index_unavailable' }, 503) : normal(url, init)
  await assert.rejects((async () => {
    for await (const { from, next } of api.changePages(mock.chain, saved)) {
      assert.deepEqual(from, saved)
      saved = next
    }
  })(), /index unavailable/)
  assert.equal(saved.sequence, String(PAGE + 1))
  assert.deepEqual(saved.checkpoint, initial.checkpoint, 'partial progress certifies no new block')
  send = normal
  for await (const { next } of api.changePages(mock.chain, saved)) saved = next
  assert.equal(JSON.parse(calls.at(-1).init.body).after, String(PAGE + 1))
  assert.deepEqual(saved, at)

  calls.length = 0
  await assert.rejects((async () => {
    for await (const _ of api.changePages(mock.chain, initial)) throw new Error('application failed')
  })(), /application failed/)
  assert.equal(calls.length, 1, 'there is no prefetched page after a consumer fails')
})

test('change traversal stops at its page budget without certifying the remaining range', async () => {
  let saved = { ...at, sequence: '0' }
  const until = { ...at, sequence: '201' }
  send = (url, init) => {
    const after = Number(JSON.parse(init.body).after)
    return response({ at: until, until, gates: true, through: String(after + 1), more: true, changes: [], records: [], references: [] })
  }
  await assert.rejects((async () => {
    for await (const { next } of api.changePages(mock.chain, saved)) saved = next
  })(), (e) => e instanceof api.ApiError && e.code === 'refresh_budget_exhausted_try_again')
  assert.equal(calls.length, 200)
  assert.equal(saved.sequence, '200')
})

test('a slow gate traversal cannot undo another view that advanced the shared ledger', async () => {
  feedRows(1)
  await getMessage(mock.chain, 1n)
  const from = structuredClone(at)
  for (let id = 2; id <= 52; id++) addPost(id)
  const normal = send, started = deferred(), held = deferred()
  let first = true
  send = async (url, init) => {
    const answer = await normal(url, init)
    if (first && url.pathname.endsWith('/changes')) {
      first = false
      started.resolve()
      await held.promise
    }
    return answer
  }
  const slow = gates.advanceToHead(mock.chain)
  await started.promise
  changed(removal(1))
  for await (const { from: cursor, answer } of api.changePages(mock.chain, from)) {
    assert.equal(gates.follow(mock.chain, cursor, answer), true)
  }
  assert.equal(gates.message(mock.chain, 1n), TOMBSTONE)
  held.resolve()
  await slow
  assert.equal(gates.message(mock.chain, 1n), TOMBSTONE)
  await gates.advanceToHead(mock.chain)
  assert.equal(JSON.parse(calls.at(-1).init.body).after, at.sequence)
})

test('a malformed reference row does not hide valid notifications beside it', async () => {
  const { findNotifications } = await load('features/notifications/notifications.ts')
  feedRows(3)
  const me = address('bb')
  referenceDiscovered(2, me)
  referenceDiscovered(3, me)
  const normal = send
  send = async (url, init) => {
    const answer = await normal(url, init)
    if (!url.pathname.endsWith('/notifications')) return answer
    const body = await answer.json()
    body.items[0].reference = null
    return response(body)
  }
  assert.deepEqual((await findNotifications([mock.chain], me)).items.map((r) => r.post.id), [2n])
})

test('the immutable record cache evicts old reads but retains recently used records', async () => {
  const base = wire(1)
  at = { ...at, checkpoint: { ...at.checkpoint, block: '11000' } }
  const batch = Array.from({ length: 10000 }, (_, i) => api.record({ ...base, id: String(i + 1) }))
  rememberMessages(mock.chain, at, batch)
  await getMessage(mock.chain, 1n) // Make the oldest record recently used.
  rememberMessages(mock.chain, at, [api.record({ ...base, id: '10001' })])
  await getMessage(mock.chain, 1n)
  await getMessage(mock.chain, 10001n)
  assert.equal(calls.length, 0)
  rows.set(2n, { ...base, id: '2' })
  await getMessage(mock.chain, 2n)
  assert.equal(calls.length, 1)
  assert.ok(asksFor(calls[0], 2))
})

// ---- quoting without a wallet: the page, not the pressed card, finishes it
function startQuoting() {
  draft.clear()
  replying.box().close()
  location.hash = ''
}

test('a quote pressed without a wallet is finished once by the page, with no card left to act', async () => {
  startQuoting()
  quoting.quoteLater(mock.chain, api.record(wire(3)))
  const box = replying.box()
  assert.equal(box.is(mock.chain.id, 3n) && box.intent, 'quote', 'the post\'s line says quote meanwhile')
  // Connecting rebuilds the stream and drops the pressed card; the page finishes the quote.
  await quoting.finishWaiting()
  assert.deepEqual(draft.quotes.map((q) => q.id), [3n])
  assert.equal(box.id, null, 'the line under the post closed')
  assert.equal(location.hash, '#/', 'the reader is taken home to write')
  startQuoting()
  await quoting.finishWaiting()
  assert.deepEqual(draft.quotes, [], 'a later connection finishes nothing')
})

test('a quote the page finishes leaves a reply already begun under that post', async () => {
  startQuoting()
  // A reply to #3 is under way in a stream; the thread's quote waits for a wallet.
  const stream = replying.box('#/quote-then-connect-stream')
  stream.open(mock.chain.id, 3n)
  stream.reply.edit({ text: 'half a reply', mentions: {}, attachments: [] })
  quoting.quoteLater(mock.chain, api.record(wire(3)))
  await quoting.finishWaiting()
  assert.deepEqual(draft.quotes.map((q) => q.id), [3n], 'the quote went into the home draft')
  assert.equal(replying.box().id, null, 'the line under the post closed')
  assert.equal(stream.is(mock.chain.id, 3n), true, 'the reply box in the stream stays')
  assert.equal(stream.reply.draft.text, 'half a reply', 'with its draft')
  stream.close()
})

test('another press on the page, or leaving it, abandons a waiting quote', async () => {
  startQuoting()
  quoting.quoteLater(mock.chain, api.record(wire(3)))
  replying.open(mock.chain.id, 4n)
  await quoting.finishWaiting()
  assert.deepEqual(draft.quotes, [], 'a reply opened under another post replaces it')
  quoting.quoteLater(mock.chain, api.record(wire(3)))
  quoting.quoteLater(mock.chain, api.record(wire(5)))
  await quoting.finishWaiting()
  assert.deepEqual(draft.quotes.map((q) => q.id), [5n], 'a later quote replaces an earlier one')
  startQuoting()
  quoting.quoteLater(mock.chain, api.record(wire(3)))
  router.leaves++ // the reader left the page; coming Back moves the count again
  await quoting.finishWaiting()
  assert.deepEqual(draft.quotes, [], 'returning to the page never sets off the old quote')
})

test('a quote that finishes after the reader moved on stays in the draft without taking them home', async () => {
  startQuoting()
  quoting.quoteLater(mock.chain, api.record(wire(3)))
  const finishing = quoting.finishWaiting()
  router.leaves++ // navigated away while the quote was loading
  await finishing
  assert.deepEqual(draft.quotes.map((q) => q.id), [3n])
  assert.equal(location.hash, '', 'the reader stays where they went')
})

test('a quote the page finishes that fails says so under the post, and trying again can finish it', async () => {
  startQuoting()
  const shown = api.record(wire(3))
  const record = rows.get(3n)
  rows.delete(3n) // the host cannot find it for now
  quoting.quoteLater(mock.chain, shown)
  await quoting.finishWaiting()
  const box = replying.box()
  assert.deepEqual(draft.quotes, [])
  assert.equal(box.is(mock.chain.id, 3n) && box.intent, 'quote', 'the post\'s line is open again')
  assert.ok(box.quoteFailure?.text, 'with the reason, not only a console warning')
  assert.equal(location.hash, '')
  rows.set(3n, record)
  await quoting.quoteAgain(mock.chain, box)
  assert.deepEqual(draft.quotes.map((q) => q.id), [3n])
  assert.equal(box.quoteFailure, null)
  assert.equal(box.id, null, 'the line closed once the quote is in the draft')
  assert.equal(location.hash, '#/')
})

test('a quote failure arriving after newer activity on the page leaves that activity alone', async () => {
  startQuoting()
  rows.delete(3n) // quote A's lookup will fail, but only after reply B has begun
  let release
  const held = new Promise((resolve) => { release = resolve })
  const answer = send
  send = async (url, init) => {
    if (asksFor({ url, init }, 3)) await held
    return answer(url, init)
  }
  quoting.quoteLater(mock.chain, api.record(wire(3)))
  const finishing = quoting.finishWaiting()
  const box = replying.box()
  replying.open(mock.chain.id, 4n)
  box.reply.edit({ text: 'reply to four', mentions: {}, attachments: [] })
  release()
  await finishing
  assert.equal(box.is(mock.chain.id, 4n), true, 'reply B keeps the box')
  assert.equal(box.reply.draft.text, 'reply to four', 'and its draft')
  assert.equal(box.quoteFailure, null, 'quote A\'s late failure is dropped')
})

test('a quote failure arriving after the reader left the page does not reopen anything there', async () => {
  startQuoting()
  rows.delete(3n)
  let release
  const held = new Promise((resolve) => { release = resolve })
  const answer = send
  send = async (url, init) => {
    if (asksFor({ url, init }, 3)) await held
    return answer(url, init)
  }
  quoting.quoteLater(mock.chain, api.record(wire(3)))
  const finishing = quoting.finishWaiting()
  router.leaves++ // left while the lookup was out; coming Back must not find the failure waiting
  release()
  await finishing
  const box = replying.box()
  assert.equal(box.id, null)
  assert.equal(box.quoteFailure, null)
})


test('host chains remain available to Settings, direct links and embeds', async () => {
  const { getStatus } = await load('lib/store.ts')
  const status = { chains: [{ id: 8453 }, { id: 84532 }], keyrings: [{ chain: 84532 }] }
  send = () => response(status)
  assert.deepEqual(await getStatus(), status)
})

test('chain selection defaults to Base mainnet but preserves an explicit choice', async () => {
  const { initialChainId } = await load('lib/chains.ts')
  const chains = [{ id: 84532 }, { id: 8453 }]
  assert.equal(initialChainId(chains, null), 8453)
  assert.equal(initialChainId(chains, 8453), 8453)
  assert.equal(initialChainId(chains, 84532), 84532)
  assert.equal(initialChainId(chains, 999), 8453)
  assert.equal(initialChainId([{ id: 810337 }], null), 810337)
  assert.equal(initialChainId([], 84532), null)
})


test('thread refresh cues stop after one changes page', async () => {
  threadRows(0)
  const root = await readThread(mock.chain, 1n)
  await replySlice(mock.chain, root.replies, 1n, 20)
  for (let id = 2; id < 152; id++) addPost(id, 1)
  calls.length = 0
  assert.equal(await peekReplies(mock.chain, root.replies, [1n]), 50)
  assert.equal(calls.filter(c => c.url.pathname.endsWith('/changes')).length, 1)
  calls.length = 0
  assert.equal(await peekReplies(mock.chain, root.replies, [1n]), Infinity)
  assert.equal(calls.filter(c => c.url.pathname.endsWith('/changes')).length, 1)
})


test('thread quiet polls pass unrelated changes without lighting refresh', async () => {
  threadRows(0)
  const root = await readThread(mock.chain, 1n)
  await replySlice(mock.chain, root.replies, 1n, 20)
  for (let id = 2; id < 153; id++) addPost(id, 0)
  for (let i = 0; i < 4; i++) assert.equal(await peekReplies(mock.chain, root.replies, [1n]), 0)
  addPost(153, 1)
  assert.equal(await peekReplies(mock.chain, root.replies, [1n]), 1)
  assert.equal(await peekReplies(mock.chain, root.replies, [1n]), 1)
})

test('an incompletely loaded thread does not make a request solely for notification cues', async () => {
  threadRows(30)
  const root = await readThread(mock.chain, 1n)
  const first = await replySlice(mock.chain, root.replies, 1n, 20)
  assert.equal(first.more, true)
  let heard = 0
  calls.length = 0
  assert.equal(await peekReplies(mock.chain, root.replies, [1n], { account: address('aa'), heard: () => { heard++ } }), 0)
  assert.equal(heard, 0)
  assert.equal(calls.length, 0)
  assert.equal(first.list.length, 20, 'the poll never changes the displayed branch')
  const all = await replySlice(mock.chain, root.replies, 1n, 40)
  assert.equal(all.more, false)
  calls.length = 0
  assert.equal(await peekReplies(mock.chain, all.children, [1n], { account: address('aa'), heard: () => { heard++ } }), 0)
  assert.equal(heard, 1, 'fully loaded branches share the usual poll again')
  assert.equal(calls.filter(c => c.url.pathname.endsWith('/changes')).length, 1)
})

test('a thread reopened after its index was rebuilt reads afresh, and a failed read keeps the page shown', async () => {
  threadRows(2)
  const first = await readThread(mock.chain, 1n)
  await replySlice(mock.chain, first.replies, 1n, 20)
  addPost(4, 1)
  at = { ...at, generation: hash('dd') }
  const normal = send
  send = (url, init) => url.pathname.includes('/message/') ? response({ error: 'index_unavailable' }, 503) : normal(url, init)
  await assert.rejects(readThread(mock.chain, 1n), /index unavailable/)
  send = normal
  const again = await readThread(mock.chain, 1n)
  assert.notEqual(again.replies.session, first.replies.session, 'a fresh session replaces the old one')
  const slice = await replySlice(mock.chain, again.replies, 1n, 20)
  assert.deepEqual(slice.list.map((r) => r.id), [2n, 3n, 4n])
  const reopened = await readThread(mock.chain, 1n)
  assert.equal(reopened.replies.session, again.replies.session, 'and is kept from then on')
})

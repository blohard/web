import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { inflateSync } from 'node:zlib'
import { encodeAbiParameters, keccak256, zeroAddress } from 'viem'
import { asVisitor, clients, DELETED, REMOVED, eventFromReceipt, Http, imageRecord, locate, Nonces, recordImage, Rpc, settle, upload } from './load-test/protocol.mjs'
import { Cache, Reader } from './load-test/reader.mjs'
import { audit, selectParent } from './load-test/workload.mjs'
import { duration, Failure, limited, options, random, Recorder, save, secretFile } from './load-test/support.mjs'
import { report } from './load-test.mjs'
import { slowUploads } from './load-test/local.mjs'

const address = (v) => `0x${v.repeat(40)}`, hash = (v) => `0x${v.repeat(64)}`
const board = address('1'), author = address('2'), parentAuthor = address('3')
const quiet = () => { const r = new Recorder(''); r.phase = 'test'; return r }

for (const code of [429, 507]) test(`upload retries ${code} with a bounded number of attempts`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const intent = { chain: 1, records: [{ hash: hash('4'), bytes: Buffer.from('test').toString('base64') }] }
  for (const failures of [1, 4]) {
    let calls = 0, finished = false
    const http = { json: async () => {
      if (++calls <= failures) throw new Failure(`http_${code}`, code)
      return { hash: hash('4') }
    } }
    const run = upload(http, intent, { message_id: '1' })
    const checked = (failures === 4 ? assert.rejects(run, (e) => e.code === code) : run).then(() => { finished = true })
    for (let i = 0; i < 10 && !finished; i++) {
      await new Promise(setImmediate)
      t.mock.timers.tick(3000)
    }
    await checked
    assert.equal(calls, failures === 4 ? 4 : 2)
  }
})

test('load config requires an explicit origin and chain, validates limits and counts ramp separately', () => {
  assert.throws(() => options(['run']), /required/)
  assert.throws(() => options(['run', '--site', 'https://example.test', '--chains', '1']), /mnemonic-file/)
  assert.throws(() => options(['check', '--site', 'https://user:pass@example.test', '--chains', '1']), /credentials/)
  assert.throws(() => options(['check', '--site', 'https://example.test', '--chains', '1,1']), /chains/)
  assert.throws(() => options(['check', '--site', 'https://example.test', '--chains', '1', '--ramp', '101:5m']), /ramp/)
  assert.throws(() => duration('Infinitys'), /duration/)
  const c = options(['run', '--site', 'https://example.test', '--chains', '810337', '--mnemonic-file', '/unused', '--duration', '30m', '--ramp', '10:5m,50:5m'])
  assert.equal(c.duration, 1800000); assert.equal(c.ramp.length, 2); assert.equal(c.maxDepth, 300)
  assert.equal(options(['check', '--site', 'https://example.test', '--chains', '1']).sponsored, 0)
})

test('nonce allocation fills all 256 positions and then chooses another word', () => {
  const n = new Nonces(), values = Array.from({ length: 258 }, () => n.allocate())
  assert.equal(new Set(values).size, 258)
  assert.equal(values[255] - values[0], 255n)
  assert.equal(values[255] >> 8n, values[0] >> 8n)
  assert.notEqual(values[256] >> 8n, values[0] >> 8n)
  assert.equal(values[256] & 255n, 0n)
})

test('failed chunk work drains started calls and starts no new ones', async () => {
  let release, active = 0
  const hold = new Promise((r) => { release = r }), started = []
  const work = limited([0, 1, 2, 3, 4], 2, async (n) => {
    active++; started.push(n)
    if (n === 0) { active--; throw new Error('no') }
    await hold; active--
  })
  release()
  await assert.rejects(work, /no/)
  assert.deepEqual(started, [0, 1]); assert.equal(active, 0)
})

test('wallet RPC is separate from domain reads and RPC refusals are measured', async (t) => {
  const shapes = []
  const server = createServer(async (req, res) => {
    let text = ''; for await (const c of req) text += c
    const body = text ? JSON.parse(text) : null
    shapes.push({ path: req.url, body })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url.endsWith('/state') ? { at, items: [], accounts: [], memberships: [] }
      : { jsonrpc: '2.0', id: body.id, ...(body.method === 'bad' ? { error: { code: -32005 } } : { result: '0x1' }) }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const r = quiet(), site = `http://127.0.0.1:${server.address().port}`, http = new Http(site, 1000, r)
  const api = clients(http, { id: 1, contract: board, public_rpc_url: `${site}/wallet` })
  await api.app('state', { ids: [], accounts: [], memberships: [] })
  const wallet = new Rpc(http, `${site}/wallet`, 1)
  await wallet.request({ method: 'eth_chainId', params: [] })
  await assert.rejects(wallet.request({ method: 'bad' }), (e) => e.kind === 'busy')
  assert.equal(api.read, undefined)
  assert.deepEqual(shapes.map((s) => s.path), ['/api/chains/1/state', '/wallet', '/wallet'])
  assert.equal(shapes[0].body.jsonrpc, undefined)
  assert.equal(shapes[1].body.method, 'eth_chainId')
  assert.equal(r.summary().find((g) => g.name === 'rpc.bad').outcome, 'busy')
})

test('on a local stack each simulated user reaches the host from its own forwarded address', async (t) => {
  const seen = []
  const server = createServer((req, res) => { seen.push(req.headers['x-forwarded-for'] ?? null); res.setHeader('content-type', 'application/json'); res.end('{}') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const http = new Http(`http://127.0.0.1:${server.address().port}`, 1000, quiet())
  const local = { forwardedIps: true }
  await Promise.all([0, 1, 258].map((i) => asVisitor(local, i, async () => {
    await http.json('/api/status')
    await new Promise(setImmediate)
    await http.json('/api/status')
  })))
  await http.json('/api/status')
  await asVisitor({ forwardedIps: false }, 5, () => http.json('/api/status'))
  assert.deepEqual(seen.slice(0, 6).sort(), ['10.0.0.0', '10.0.0.0', '10.0.0.1', '10.0.0.1', '10.0.1.2', '10.0.1.2'],
    'each user keeps its address across awaits, including while others are active')
  assert.deepEqual(seen.slice(6), [null, null], 'outside a user, or without the flag, nothing is forwarded')
  assert.equal(options(['check', '--site', 'http://127.0.0.1:1', '--chains', '1', '--forwarded-ips']).forwardedIps, true)
})

test('a slow upload refused before its body stops sending, so attempts never overlap', async (t) => {
  // Connections, not requests: once answered, a request no longer reports its client leaving.
  let open = 0, most = 0, attempts = 0, afterAnswer = 0
  const server = createServer((req, res) => {
    attempts++
    let answered = false
    req.on('data', (chunk) => { if (answered) afterAnswer += chunk.length })
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end('{"error":"the host is busy; try again shortly"}', () => { answered = true })
  })
  server.on('connection', (socket) => { most = Math.max(most, ++open); socket.on('close', () => { open-- }) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const stop = new AbortController()
  const holders = slowUploads(`http://127.0.0.1:${server.address().port}`, 1, stop.signal, 64 << 10)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  stop.abort()
  await holders.done
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(holders.statuses.slice(0, 2), [503, 503], 'refused at once, then asked again a second later')
  assert.equal(attempts, holders.statuses.length)
  assert.equal(most, 1, 'the refused attempt closed before the next began')
  assert.equal(afterAnswer, 0, 'nothing is sent after the answer')
  assert.equal(open, 0, 'nothing is left open once stopped')
})

test('stopping a slow upload that is waiting for its answer closes it', async (t) => {
  let open = 0, received = 0
  // Reads the whole body and never answers.
  const server = createServer((req) => { req.on('data', (chunk) => { received += chunk.length }) })
  server.on('connection', (socket) => { open++; socket.on('close', () => { open-- }) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const stop = new AbortController()
  const holders = slowUploads(`http://127.0.0.1:${server.address().port}`, 1, stop.signal, 8 << 10)
  const deadline = Date.now() + 5000
  while (received < 8 << 10 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(received, 8 << 10, 'the whole body went out')
  stop.abort()
  const stopped = await Promise.race([holders.done.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2000))])
  assert.ok(stopped, 'the stop ends an attempt that is only waiting for its answer')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(open, 0, 'and closes its request')
})

test('PNG attachments are valid, reproducible and distinct, with an actual image payload', () => {
  const image = imageRecord(13000, random(1)), again = imageRecord(13000, random(1)), other = imageRecord(13000, random(2))
  assert.deepEqual(image, again); assert.notEqual(keccak256(image), keccak256(other))
  const png = image.subarray(image.indexOf(10) + 1)
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  let offset = 8, width, height, raw
  while (offset < png.length) {
    const size = png.readUInt32BE(offset), name = png.subarray(offset + 4, offset + 8).toString(), bytes = png.subarray(offset + 8, offset + 8 + size)
    if (name === 'IHDR') { width = bytes.readUInt32BE(0); height = bytes.readUInt32BE(4) }
    if (name === 'IDAT') raw = inflateSync(bytes)
    offset += size + 12
  }
  assert.equal(raw.length, height * (width * 3 + 1))
  assert.ok(image.length < 14000)
})

const at = { generation: hash('a'), sequence: '1', checkpoint: { block: '19', hash: hash('b') } }
function wire(id = 9, parent = 4, who = author) {
  const m = { id: String(id), parent: String(parent), author: who, parent_author: parent ? parentAuthor : zeroAddress,
    content_hash: hash('4'), timestamp: 100, position: { block: '20', log: 0 }, transaction: hash('7'),
    gate: zeroAddress, author_gate: zeroAddress, effective_gate: zeroAddress, replies: '0' }
  m.commitment = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint64' }, { type: 'uint32' }, { type: 'bytes32' }], [m.author, BigInt(parent), m.timestamp, m.content_hash]))
  return m
}
function receipt(intent, { parent = BigInt(intent.parentId), who = intent.author } = {}) {
  return { status: 'success', block: '20', hash: hash('7'), events: [{ kind: 'posted', message: wire(9, parent, who) }] }
}
const intentFor = () => ({ logicalId: 'test', chain: 1, board, author, parentId: '4', parentAuthor,
  contentHash: hash('4'), fromBlock: '1', createdAt: Date.now(), records: [], state: 'prepared', mode: 'sponsored',
  signed: { nonce: '1', deadline: `${Math.floor(Date.now() / 1000) + 60}` } })

test('audit rejects deleted and removed replies in ordinary reply lists', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blohard-audit-unit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const config = { site: 'http://local.test', recover: false }
  const intent = { ...intentFor(), txHash: hash('7'), startBlock: '1' }
  await mkdir(`${dir}/pending`)
  await save(`${dir}/run.json`, { config })
  await save(`${dir}/pending/test.json`, intent)
  for (const gate of ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002']) {
    const message = { ...wire(), gate, effective_gate: gate }
    for (const present of [false, true]) {
      const http = { json: async (path) => {
        if (path.includes('/transaction/')) return receipt(intent)
        if (path.includes('/message/')) return { at, message, ancestors: [] }
        if (path.endsWith('/lookup')) return { at, items: [message], next: null }
        assert.ok(path.endsWith('/replies'))
        return { at, items: present ? [message] : [], next: null }
      } }
      const result = await audit(config, http, { dir }, { chains: [{ id: 1, contract: board }] }, dir)
      assert.equal(result.verified, 1)
      assert.equal(result.scanFailures, 0)
      assert.equal(result.replyIndexMismatches, present ? 1 : 0, `${gate}, present=${present}`)
    }
  }
})

test('publication verification requires exactly one event from the canonical Board with all expected fields', () => {
  const intent = intentFor()
  assert.equal(eventFromReceipt(receipt(intent), board, intent).id, 9n)
  assert.throws(() => eventFromReceipt(receipt(intent), address('9'), intent), /Board/)
  assert.throws(() => eventFromReceipt(receipt(intent, { parent: 5n }), board, intent), /fields/)
  assert.throws(() => eventFromReceipt(receipt(intent, { who: address('5') }), board, intent), /fields/)
  const duplicate = receipt(intent); duplicate.events.push(duplicate.events[0])
  assert.throws(() => eventFromReceipt(duplicate, board, intent), /exactly one/)
})

for (const code of [504, 502]) test(`an uncertain ${code} followed by 409 reuses the signature and resolves the actual event`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blohard-load-unit-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const intent = intentFor(), path = `${dir}/pending.json`, sent = []
  let landed = false
  const http = { json: async (route, { body }) => {
    assert.match(route, /\/post$/)
    sent.push(body)
    if (sent.length === 1) throw new Failure(`http_${code}`, code)
    landed = true; throw new Failure('http_409', 409)
  } }
  const api = { info: { id: 1, contract: board }, message: async () => ({ record: recordImage(wire()) }),
    app: async (route) => route === 'lookup' ? { at, items: landed ? [wire()] : [], next: null } : receipt(intent) }

  const ev = await settle(api, http, { settle: 6000 }, quiet(), intent, path)
  assert.equal(ev.id, 9n); assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]); assert.equal(intent.state, 'visible')
  assert.equal(JSON.parse(await readFile(path, 'utf8')).event.id, '9')
})

test('an initial definitive refusal is not retried or called an accepted publication', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blohard-load-unit-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const intent = intentFor(); let calls = 0
  const http = { json: async () => { calls++; throw Object.assign(new Failure('http_403', 403), { outcome: 'refused' }) } }
  await assert.rejects(settle({}, http, { settle: 100 }, quiet(), intent, `${dir}/pending.json`), (e) => e.code === 403)
  assert.equal(calls, 1); assert.equal(intent.state, 'refused')
})

test('recovery advances only successful lookup pages and a known hash never searches', async () => {
  const intent = intentFor(), asks = []
  let failed = true
  const api = { info: { contract: board }, message: async () => ({ record: recordImage(wire()) }),
    app: async (route, query) => {
      asks.push({ route, query: structuredClone(query) })
      if (route !== 'lookup') return receipt(intent)
      if (failed) throw new Failure('busy', 503)
      return { at, items: [], next: null }
    } }
  await assert.rejects(locate(api, intent), (e) => e.code === 503)
  assert.equal(intent.fromBlock, '1')
  failed = false
  assert.equal(await locate(api, intent), null)
  assert.equal(asks[1].query.from_block, '1')
  assert.equal(intent.fromBlock, '20')
  intent.txHash = hash('7')
  assert.equal((await locate(api, intent)).id, 9n)
  assert.deepEqual(asks.map((a) => a.route), ['lookup', 'lookup', `transaction/${hash('7')}`])
})

for (const gate of [DELETED, REMOVED]) test(`notifications discard ended records on refresh (${gate})`, async () => {
  const post = wire(), calls = []
  let changed = false
  const api = { info: { id: 1 }, account: { address: parentAuthor }, app: async (route) => {
    calls.push(route)
    if (route === 'references') return { at, items: [post], next: null }
    const end = { ...at, sequence: '2' }
    return { at: end, until: end, through: '2', more: false, changes: [], references: [],
      records: changed ? [{ ...post, gate, effective_gate: gate }] : [] }
  } }
  const reader = new Reader(api, null, quiet(), { bodyCache: 1 })
  let bodies = 0; reader.body = async () => { bodies++ }
  assert.equal(await reader.notifications(() => 0), 1)
  changed = true
  assert.equal(await reader.notifications(() => 0), 0)
  assert.deepEqual(calls, ['references', 'changes'])
  assert.equal(bodies, 1)
})

test('an uncertain send followed by a refusal stays unresolved until reconciled', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blohard-load-unit-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const intent = { ...intentFor(), state: 'unknown' }
  const http = { json: async () => { throw Object.assign(new Failure('http_403', 403), { outcome: 'refused' }) } }
  const api = { info: { contract: board }, app: async () => ({ at, items: [], next: null }) }
  await assert.rejects(settle(api, http, { settle: 1 }, quiet(), intent, `${dir}/pending.json`), (e) => e.kind === 'unknown')
  assert.equal(intent.state, 'unknown')
})

test('pending output is owner-only and the report reconstructs outcomes without private material', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blohard-load-unit-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const recorder = await Recorder.create(`${dir}/run`)
  await recorder.event({ type: 'measure', name: 'read.feed', chain: 1, outcome: 'ok', ms: 20 })
  await recorder.event({ type: 'published', depth: 300 })
  await recorder.event({ type: 'missed', count: 4 })
  await recorder.close()
  const result = await report(recorder.dir)
  assert.equal(result.maxDepth, 300); assert.equal(result.missed, 4); assert.equal(result.metrics[0].count, 1)
  await assert.rejects(Recorder.create(`${dir}/run`), /EEXIST/)
  await writeFile(`${dir}/phrase`, 'not private')
  // Set the mode explicitly: a restrictive umask would mask it on creation.
  await chmod(`${dir}/phrase`, 0o644)
  await assert.rejects(secretFile(`${dir}/phrase`), /600/)
})

test('deep chain selection respects depth and other authors, and collapses iteratively', () => {
  const user = { api: { info: { id: 1 }, account: { address: author } }, rng: () => 0 }
  const pool = Array.from({ length: 301 }, (_, i) => ({ id: BigInt(i + 1), parentId: BigInt(i), depth: i, chain: 1, author: parentAuthor, blockNumber: BigInt(i), logIndex: 0 }))
  const tips = new Set(['1:300', '1:301'])
  assert.equal(selectParent(pool, user, { maxDepth: 300 }, tips, { forceDeep: true }).depth, 299)
  const reader = new Reader(user.api, null, quiet(), { bodyCache: 2 })
  assert.equal(reader.select(pool, { kind: 'timeline' }).length, 1)
  const a = new Cache(1), b = new Cache(1)
  a.set('body', 'bytes'); assert.equal(b.get('body'), undefined)
  a.set('other', 'bytes'); assert.equal(a.get('body'), undefined)
})

for (const gate of [DELETED, REMOVED]) test(`feed pages, refresh and quiet polls exclude ended records (${gate})`, async () => {
  const calls = [], first = wire(1, 0), second = wire(2, 0)
  const ended = { ...wire(3, 0), gate, effective_gate: gate }
  first.replies = '50'
  let fresh = false
  const api = { info: { id: 1 }, account: { address: author }, app: async (route, query) => {
    calls.push({ route, query })
    if (route === 'feed') return { at, items: [first], next: null }
    assert.equal(route, 'changes')
    const end = { ...at, sequence: fresh ? '2' : '1' }
    return { at: end, until: end, through: end.sequence, more: false, changes: [], records: fresh ? [second, ended] : [], references: [] }
  } }
  const reader = new Reader(api, null, quiet(), { bodyCache: 1 })
  reader.body = async () => {}
  assert.equal((await reader.feed({ kind: 'timeline' }, () => 0)).rows, 1)
  assert.equal(reader.records.get('1').replies, 50)
  assert.deepEqual(calls.map((c) => c.route), ['feed'])
  assert.equal(calls[0].query.limit, 20)
  assert.deepEqual(reader.select([first, second, ended].map(recordImage), { kind: 'timeline' }).map(p => p.id), [1n, 2n])
  fresh = true
  assert.equal(await reader.poll(), 1)
  assert.equal(reader.views.get('{"kind":"timeline"}').events.size, 1, 'quiet poll does not apply its answer')
  assert.equal((await reader.feed({ kind: 'timeline' }, () => 0)).rows, 2)
  assert.deepEqual(calls.map((c) => c.route), ['feed', 'changes', 'changes'])
})

for (const gate of [DELETED, REMOVED]) test(`thread pages drop ended children on refresh without individual reads (${gate})`, async () => {
  const root = recordImage(wire(2, 1)); root.replies = 21
  const asks = [], child = wire(3, 2); child.replies = '7'
  const api = { info: { id: 1 }, account: { address: author },
    message: async (id, ancestors) => { asks.push(['message', id, ancestors]); return { record: root, ancestors: [recordImage(wire(1, 0))] } },
    app: async (route, query) => {
      asks.push([route, query])
      if (route === 'replies') return { at, items: [child], next: null }
      assert.equal(route, 'changes')
      const end = { ...at, sequence: '2' }
      return { at: end, until: end, through: '2', more: false, changes: [], references: [],
        records: [{ ...child, gate, effective_gate: gate }] }
    } }
  const reader = new Reader(api, null, quiet(), { bodyCache: 1 }); reader.body = async () => {}
  assert.deepEqual(await reader.thread(2n, () => 0, true), { root: '2', replies: 21, shown: 1 })
  assert.deepEqual(asks.map((a) => a[0]), ['message', 'replies'])
  assert.equal(asks[0][2], 1); assert.equal(asks[1][1].limit, 20)
  assert.equal(reader.threadPages.get('tip:2'), '3')
  root.replies = 20
  assert.deepEqual(await reader.thread(2n, () => 0), { root: '2', replies: 20, shown: 0 })
  assert.deepEqual(asks.map(a => a[0]), ['message', 'replies', 'message', 'changes'])
})

test('a not-yet-uploaded body is a measured placeholder and is retried, while corrupt bytes fail', async () => {
  const body = Buffer.from('version/1 text/plain\nhello'), post = { id: 1n, contentHash: keccak256(body), author }
  let calls = 0
  const http = { request: async () => { if (++calls === 1) throw new Failure('http_404', 404); return { bytes: body } } }
  const recorder = quiet(), events = [], event = recorder.event.bind(recorder)
  recorder.event = async (e) => { events.push(e); await event(e) }
  const reader = new Reader({ info: { id: 1 }, account: { address: author } }, http, recorder, { bodyCache: 1 })
  assert.equal(await reader.bodyBytes(post), null)
  assert.deepEqual(await reader.bodyBytes(post), body)
  assert.deepEqual(await reader.bodyBytes(post), body)
  assert.equal(calls, 2); assert.equal(events.filter((e) => e.type === 'content_missing').length, 1)
  http.request = async () => ({ bytes: Buffer.from('wrong bytes') })
  await assert.rejects(reader.optionalContent(hash('f'), 2n), (e) => e.kind === 'integrity')
})

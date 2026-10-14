// The reference bot's failure paths, against a mocked host and relayer: the
// integration suite covers the paths where everything answers.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'
import { keccak256 } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import * as bot from '../public/bots/bot.mjs'

bot.pause.scale = 0
const site = 'https://host.invalid'
const account = mnemonicToAccount('test test test test test test test test test test test junk')
const zero = `0x${'0'.repeat(40)}`
const fetchBefore = globalThis.fetch
afterEach(() => { globalThis.fetch = fetchBefore })
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const status = { chains: [{ id: 84532, contract: '0xca3E637985f1866b92e56fCf82Bae7cbf479c7Bf', index: { at: { checkpoint: { block: '100' } } } }] }
const tx = (n) => `0x${n.toString(16).padStart(64, '0')}`
const posted = (id) => ({ status: 'success', events: [{ kind: 'posted', message: { id: String(id) } }] })
const dir = () => mkdtemp(join(tmpdir(), 'bot-'))

/** A mock that answers each request with the first matching handler, and records what it was asked. */
function mock(handlers) {
  const asked = []
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).slice(site.length)
    asked.push({ path, body: init.body })
    for (const [match, answer] of handlers) if (path.startsWith(match)) return answer(path, init)
    throw new Error(`unexpected ${path}`)
  }
  return asked
}

/** A mention of the bot by someone else, with its body. */
function mentionOf(id, text = 'hi bot') {
  const bytes = bot.envelope(text)
  return { record: { id: String(id), author: `0x${'09'.repeat(20)}`, reference: { kind: 'mention' }, content_hash: keccak256(bytes), effective_gate: zero }, bytes }
}

/** A host and relayer that answer everything, with overrides. */
function healthy({ notifications = [], bodies = {}, relay, overrides = [] } = {}) {
  let sent = 0
  return mock([
    ...overrides,
    ['/api/status', () => json(200, status)],
    ['/api/chains/84532/notifications', () => json(200, { items: [...notifications].reverse(), next: null })],
    ['/api/content/', (path) => {
      const id = new URL(path, site).searchParams.get('message_id')
      return bodies[id] ? new Response(bodies[id]) : new Response('', { status: 404 })
    }],
    ['/api/relay/84532/post', (_, init) => (relay ? relay(init) : json(200, { tx_hash: tx(++sent) }))],
    ['/api/publish', () => json(200, { hash: '0x' })],
    ['/api/chains/84532/transaction/', (path) => json(200, posted(1000 + Number.parseInt(path.split('/').pop(), 16)))],
    ['/api/chains/84532/lookup', () => json(200, { items: [], next: null })],
  ])
}

/** Run the bot until `done()` holds after a round, or a few rounds pass. */
async function runUntil(state, done, extra = {}) {
  const stop = new AbortController()
  let rounds = 0
  const answer = extra.answer ?? (async (text) => `you said ${text}`)
  const ticking = setInterval(() => { if (done() || ++rounds > 200) stop.abort() }, 5)
  await bot.run({ site, chainId: 84532, account, state, every: 1, signal: stop.signal, answer })
  clearInterval(ticking)
}

const relayed = (asked) => asked.filter((a) => a.path.startsWith('/api/relay')).map((a) => JSON.parse(a.body))

test('an upload held only in memory is sent again until the host stores it', async () => {
  let tries = 0
  mock([['/api/publish', () => (++tries < 3 ? json(202, { hash: '0x' }) : json(200, { hash: '0x' }))]])
  await bot.upload(site, 84532, new Uint8Array([1]), { txHash: '0xab' })
  assert.equal(tries, 3)
})

test('a post whose upload failed is finished later from its saved file, with the same signature', async () => {
  const state = await dir()
  const saved = bot.store(state)
  let hostDown = true
  const asked = healthy({ overrides: [['/api/publish', () => (hostDown ? json(500, { code: 'store_failed' }) : json(200, { hash: '0x' }))]] })
  await assert.rejects(bot.post(site, 84532, account, 'hello', null, { saved }))
  const [op] = await saved.unfinished()
  assert.equal(op.txHash, tx(1), 'the transaction is saved before uploading')
  hostDown = false
  await bot.resume({ site, state })
  assert.equal(relayed(asked).length, 1, 'never sent or signed again')
  assert.deepEqual(await saved.unfinished(), [], 'a finished post leaves the queue')
})

test('a busy relayer keeps the post saved, however long it stays busy', async () => {
  const saved = bot.store(await dir())
  healthy({ relay: () => json(503, { code: 'busy', outcome: 'refused' }, { 'retry-after': '2' }) })
  const op = await bot.prepare(site, 84532, account, 'hello', null, { saved })
  await assert.rejects(bot.finish(site, op, { saved }))
  assert.equal((await saved.unfinished()).length, 1)
})

test('a declined post stays saved for attention, never deleted', async () => {
  const saved = bot.store(await dir())
  healthy({ relay: () => json(403, { code: 'deadline_passed', outcome: 'refused' }) })
  const op = await bot.prepare(site, 84532, account, 'hello', null, { saved })
  assert.equal((await bot.finish(site, op, { saved }).catch((e) => e)).code, 'deadline_passed')
  assert.equal((await saved.unfinished()).length, 1)
})

test('a lookup follows its pages', async () => {
  let pages = 0
  mock([['/api/chains/84532/lookup', () => (++pages < 3 ? json(200, { items: [], next: { page: pages } }) : json(200, { items: [{ id: '8' }], next: null }))]])
  assert.equal((await bot.lookup(site, 84532, { author: zero, contentHash: '0x', parentId: '0' }, '0')).id, '8')
})

test('a name for sponsorship reaches the relayer', async () => {
  const asked = mock([['/api/relay/84532/post', () => json(200, { tx_hash: '0xab' })]])
  await bot.send(site, 84532, {}, { name: 'alice.eth' })
  assert.equal(asked[0].path, '/api/relay/84532/post?name=alice.eth')
})

test('notifications are followed back to the last one handled, with no page limit', async () => {
  const pages = Array.from({ length: 40 }, (_, p) => Array.from({ length: 50 }, (_, i) => 3000 - p * 50 - i))
  mock([['/api/chains/84532/notifications', (_, init) => {
    const page = JSON.parse(init.body).cursor ?? 0
    return json(200, { items: pages[page].map((id) => ({ id: String(id) })), next: page + 1 < pages.length ? page + 1 : null })
  }]])
  const found = await bot.notificationsAfter(site, 84532, account.address, 1100n)
  assert.equal(found.length, 1900)
  assert.deepEqual([found[0].id, found.at(-1).id], ['1101', '3000'])
})

test('an answer saved before a crash is finished by resume, never signed again, and a second answer cannot land', async () => {
  const state = await dir()
  const { record, bytes } = mentionOf(5)
  // The crash: the answer is saved, the mark has not moved past its mention.
  await writeFile(join(state, 'state.json'), JSON.stringify({ after: '4', waiting: [] }))
  const nonce = bot.replyNonce(account.address, 84532, 5)
  healthy()
  const op = await bot.prepare(site, 84532, account, 'first answer', record, { saved: bot.store(state), nonce })
  const asked = healthy({ notifications: [record], bodies: { 5: bytes } })
  await runUntil(state, () => asked.some((a) => a.path.includes('content')))
  assert.equal(relayed(asked).length, 0, 'the run does not sign a second answer')
  await bot.resume({ site, state })
  const sent = relayed(asked)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].sig, op.request.sig, 'the saved answer, not a new one')
  // Even a second answer signed elsewhere carries the same nonce, which the Board takes once.
  assert.equal(bot.replyNonce(account.address, 84532, 5), BigInt(op.request.nonce))
})

test('a mention whose text has not arrived waits without blocking later ones, and is answered once it does', async () => {
  const state = await dir()
  await writeFile(join(state, 'state.json'), JSON.stringify({ after: '4', waiting: [] }))
  const early = mentionOf(5, 'early'), later = mentionOf(6, 'later')
  const bodies = { 6: later.bytes }
  const asked = healthy({ notifications: [early.record, later.record], bodies })
  await runUntil(state, () => relayed(asked).length >= 1)
  assert.deepEqual(relayed(asked).map((r) => r.parentId), ['6'])
  const memo = JSON.parse(await readFile(join(state, 'state.json'), 'utf8'))
  assert.equal(memo.after, '6')
  assert.deepEqual(memo.waiting.map((w) => w.record.id), ['5'], 'the early one waits, saved')
  bodies[5] = early.bytes
  await runUntil(state, () => relayed(asked).length >= 2)
  assert.deepEqual(relayed(asked).map((r) => r.parentId), ['6', '5'])
})

test('an outage on the very first round is tried again instead of stopping the bot', async () => {
  const state = await dir()
  let first = true
  const asked = healthy({ overrides: [['/api/chains/84532/notifications', () => {
    if (first) { first = false; return json(503, { code: 'host_busy' }, { 'retry-after': '2' }) }
    return json(200, { items: [], next: null })
  }]] })
  await runUntil(state, () => asked.filter((a) => a.path.includes('notifications')).length >= 3)
  assert.equal(JSON.parse(await readFile(join(state, 'state.json'), 'utf8')).after, '0')
})

test('a download stops at the limit, even without a length header', async () => {
  let pulled = 0
  const chunk = new Uint8Array(16 * 1024)
  const endless = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(chunk) } })
  mock([['/api/content/', () => new Response(endless)]])
  assert.equal(await bot.textOf(site, 84532, { id: '1', content_hash: '0x' }), null)
  assert.ok(pulled < 10, `read ${pulled} pieces`)
})

test('the bot keeps its state in one directory', async () => {
  const state = await dir()
  await mkdir(join(state, 'posts'), { recursive: true })
  const asked = healthy()
  // The second notification read follows the initial state write.
  await runUntil(state, () => asked.filter((a) => a.path.includes('notifications')).length >= 2)
  assert.deepEqual((await readdir(state)).sort(), ['posts', 'state.json'])
})

test('the bot says it is a bot by signing the host’s text, and a refusal never stops it', async () => {
  const { recoverMessageAddress } = await import('viem')
  const policy = { origin: 'https://host.invalid', declared_bots: [] }
  const declarations = []
  let refuse = 'not_an_author'
  mock([
    ['/api/status', () => json(200, { ...status, host_policy: policy })],
    ['/api/bot-declaration', (_, init) => {
      declarations.push(JSON.parse(init.body))
      return refuse ? json(403, { code: refuse, error: refuse }) : json(200, { ...policy, declared_bots: [account.address] })
    }],
  ])
  // Before its first answer lands the host does not know it: no error, just not yet.
  assert.equal(await bot.declare(site, account), false)
  refuse = null
  assert.equal(await bot.declare(site, account), true)
  const sent = declarations.at(-1)
  assert.equal(sent.account, account.address)
  assert.equal(sent.bot, true)
  const text = bot.declaration(policy.origin, account.address, sent.issued)
  assert.equal(text.split('\n')[0], 'Bot declaration')
  assert.equal(await recoverMessageAddress({ message: text, signature: sent.signature }), account.address)
  // Once listed it asks nothing more, and a host without labels needs nothing.
  policy.declared_bots = [account.address.toLowerCase()]
  assert.equal(await bot.declare(site, account), true)
  assert.equal(declarations.length, 2)
  mock([['/api/status', () => json(200, status)]])
  assert.equal(await bot.declare(site, account), true)
  mock([['/api/status', () => json(503, { code: 'host_busy' })]])
  assert.equal(await bot.declare(site, account), false, 'an outage is not an error the bot stops for')
})

test('a declaration that never answers holds up neither reading nor answering mentions', async () => {
  const state = await dir()
  await writeFile(join(state, 'state.json'), JSON.stringify({ after: '4', waiting: [] }))
  const { record, bytes } = mentionOf(5)
  let declarations = 0
  const asked = healthy({ notifications: [record], bodies: { 5: bytes }, overrides: [
    ['/api/status', () => json(200, { ...status, host_policy: { origin: site, declared_bots: [] } })],
    ['/api/bot-declaration', () => { declarations++; return new Promise(() => {}) }],
  ] })
  await runUntil(state, () => relayed(asked).length >= 1)
  assert.deepEqual(relayed(asked).map((r) => r.parentId), ['5'], 'answered while the declaration hung')
  assert.equal(declarations, 1, 'one declaration at a time, none piled up behind the stalled one')
})

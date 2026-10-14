// Signing and nonces: the shared EIP-712 vector, and the nonce-word allocator across tabs, reloads, cancellations and resends.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { hashTypedData, zeroAddress } from 'viem'
import { boardDomain, POST_TYPES } from '../src/lib/signing.js'
import { load, mock, install, teardown, address, hash, author, replyArgs } from './host-harness.mjs'
const { RelayUnknown } = await load('features/publishing/relay.ts')

const { recoverPost } = await load('features/publishing/recovery.ts')
const { publishPost } = await load('features/publishing/posting.ts')
const { signPost } = await load('features/publishing/sign-post.ts')
const { allocateNonce } = await load('features/publishing/nonces.ts')
const { STORES } = await load('lib/db.ts')

beforeEach(install)
after(teardown)

test('shared signing matches the independent cast vector used by the host', () => {
  assert.equal(hashTypedData({ domain: boardDomain({ id: 31337, contract: address('11') }), types: POST_TYPES, primaryType: 'Post',
    message: { author, contentHash: hash('33'), parentId: 5n, replyGate: zeroAddress, nonce: 7n, deadline: 1700000000n } }),
  '0x930a1316956d5730b26f714a271f757f782333b131040b7b3d9005f694332478')
})

test('independent nonce allocators share full words across concurrent reservations and reloads', async () => {
  const other = await load('features/publishing/nonces.ts?another-tab')
  const nonces = await Promise.all(Array.from({ length: 260 }, (_, i) =>
    (i % 2 ? other.allocateNonce : allocateNonce)(mock.chain, author)))
  assert.equal(new Set(nonces).size, 260)
  const words = new Map()
  for (const nonce of nonces) {
    assert.ok(nonce >= 0n && nonce < (1n << 256n))
    const word = nonce >> 8n
    words.set(word, [...(words.get(word) ?? []), Number(nonce & 255n)])
  }
  const groups = [...words.values()].sort((a, b) => b.length - a.length)
  assert.deepEqual(groups[0].sort((a, b) => a - b), Array.from({ length: 256 }, (_, i) => i))
  assert.deepEqual(groups[1].sort((a, b) => a - b), [0, 1, 2, 3])
  assert.equal(groups.length, 2)
  const reloaded = await load('features/publishing/nonces.ts?reload')
  const next = await reloaded.allocateNonce(mock.chain, author)
  assert.equal(next & 255n, 4n)
  assert.ok(words.has(next >> 8n))
})

test('nonce allocation is scoped to chain, Board and author, with address casing normalized', async () => {
  mock.chain.contract = address('cd')
  const account = address('ab')
  const first = await allocateNonce(mock.chain, account)
  for (const [network, signer] of [
    [{ ...mock.chain, id: mock.chain.id + 1 }, account],
    [{ ...mock.chain, contract: address('ef') }, account],
    [mock.chain, address('aa')],
  ]) assert.equal((await allocateNonce(network, signer)) & 255n, 0n)
  const upper = (a) => `0x${a.slice(2).toUpperCase()}`
  assert.equal(await allocateNonce({ ...mock.chain, contract: upper(mock.chain.contract) }, upper(account)), first + 1n)
})

test('an aborted nonce reservation uses a fresh word without issuing the rolled-back nonce', async (t) => {
  const first = await allocateNonce(mock.chain, author)
  const put = IDBObjectStore.prototype.put
  t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    const req = put.apply(this, args)
    if (this.name === STORES.nonces) {
      assert.equal(this.transaction.durability, 'strict')
      req.addEventListener('success', () => this.transaction.abort())
    }
    return req
  })
  const fallback = await allocateNonce(mock.chain, author)
  t.mock.restoreAll()
  assert.notEqual(fallback >> 8n, first >> 8n)
  assert.equal(await allocateNonce(mock.chain, author), first + 1n)
})

test('unavailable or cleared storage starts fresh nonce words', async () => {
  const first = await allocateNonce(mock.chain, author)
  const database = globalThis.indexedDB
  globalThis.indexedDB = { open() { throw new Error('storage unavailable') } }
  const a = await allocateNonce(mock.chain, author), b = await allocateNonce(mock.chain, author)
  assert.equal(new Set([first >> 8n, a >> 8n, b >> 8n]).size, 3)
  globalThis.indexedDB = database
  assert.equal(await allocateNonce(mock.chain, author), first + 1n)
  globalThis.indexedDB = new IDBFactory()
  assert.notEqual((await allocateNonce(mock.chain, author)) >> 8n, first >> 8n)
})

test('a rejected wallet signature does not release its reserved nonce', async () => {
  const seen = []
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_accounts') return [author]
    assert.equal(method, 'eth_signTypedData_v4')
    seen.push(BigInt(JSON.parse(params[1]).message.nonce))
    if (seen.length === 1) throw Object.assign(new Error('user rejected signing'), { code: 4001 })
    return '0x1234'
  } }
  const args = { contentHash: hash('33'), parentId: 0n, }
  await assert.rejects(signPost(provider, author, mock.chain, args), /rejected/)
  const signed = await signPost(provider, author, mock.chain, args)
  assert.equal(BigInt(signed.nonce), seen[0] + 1n)
})

test('an uncertain send resends its saved signature without allocating another nonce', async () => {
  const args = { ...replyArgs(), parentId: 0n }
  await assert.rejects(publishPost(args), RelayUnknown)
  assert.equal(!!(await recoverPost(mock.chain, args.pending)).done, false)
  const relays = mock.calls.filter((c) => c.method === 'relay')
  assert.equal(relays.length, 2)
  assert.deepEqual(relays[0].signed, relays[1].signed)
  assert.equal(await allocateNonce(mock.chain, author), BigInt(args.pending.signed.nonce) + 1n)
})

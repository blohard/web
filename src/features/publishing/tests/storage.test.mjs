// Browser storage: fresh schema and what concurrent writes may and may not touch.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { IDBObjectStore } from 'fake-indexeddb'
import { load, mock, install, teardown, address, author, txHash, makePost, sign } from '../../../../scripts/harness.mjs'

const pending = await load('features/publishing/pending.ts')
const { allocateNonce } = await load('features/publishing/nonces.ts')
const { tx, STORES } = await load('lib/db.ts')

beforeEach(install)
after(teardown)

test('fresh stores keep pending bytes and nonce reservations independently', async () => {
  const post = makePost(true); sign(post)
  await pending.savePending(post)
  const first = await allocateNonce(mock.chain, author)
  assert.equal(await allocateNonce(mock.chain, author), first + 1n)
  assert.deepEqual(await pending.listPending(), [post])
  assert.deepEqual(await tx(STORES.avatars, 'readonly', (s) => s.getAll()), [])
})

test('concurrent updates neither resurrect records nor touch identical bytes in another post', async () => {
  const a = makePost(true), b = makePost(true)
  await pending.savePending(a); await pending.savePending(b)
  await Promise.all([pending.updatePending(a, { txHash }), pending.recordUploaded(a.key, a.bodyHash, false), pending.recordUploaded(a.key, a.records[1].hash, true)])
  const saved = await pending.listPending()
  assert.equal(saved.find((p) => p.key === b.key).records.length, 2)
  const changed = saved.find((p) => p.key === a.key)
  assert.equal(changed.txHash, txHash)
  assert.equal(changed.records.length, 1)
  assert.equal(changed.records[0].status, 'held')
  await Promise.all([pending.recordUploaded(a.key, a.records[1].hash, false), pending.updatePending(a, { messageId: 7n })])
  assert.deepEqual((await pending.listPending()).map((p) => p.key), [b.key])
})

test('reactive objects are copied into cloneable IndexedDB data', async () => {
  const post = makePost(true)
  post.records = new Proxy(post.records.map((r) => new Proxy(r, {})), {})
  await pending.savePending(new Proxy(post, {}))
  assert.deepEqual((await pending.listPending())[0].records, post.records)
})

test('an address list changed in two tabs keeps both changes, and the storage event brings the other tab’s change in', async () => {
  const store = new Map()
  const listeners = []
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  globalThis.window = { addEventListener: (type, fn) => { if (type === 'storage') listeners.push(fn) } }
  try {
    const { AddressList } = await load('lib/addressList.svelte.ts')
    const a = new AddressList('t.list')
    const b = new AddressList('t.list') // a second tab, opened while the list was empty
    a.toggle(address('11'))
    b.toggle(address('22'))
    assert.deepEqual(JSON.parse(store.get('t.list')), [address('11'), address('22')], 'the second tab adds to what the first stored')
    assert.equal(b.has(address('11')), true)
    assert.equal(a.has(address('22')), false, 'not yet: the first tab has not heard')
    for (const fn of listeners) fn({ key: 't.list' })
    assert.equal(a.has(address('22')), true, 'the storage event brings it in')
    a.toggle(address('11'))
    assert.deepEqual(JSON.parse(store.get('t.list')), [address('22')])
  } finally {
    delete globalThis.localStorage
    delete globalThis.window
  }
})

test('an address list keeps its changes when storage can be read but not written, and the first save that works carries them all', async () => {
  const { AddressList } = await load('lib/addressList.svelte.ts')
  const store = new Map([['t.unwritable', JSON.stringify([address('99')])]])
  let writable = false
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { if (!writable) throw new Error('quota'); store.set(k, String(v)) }, removeItem: (k) => store.delete(k) }
  try {
    const list = new AddressList('t.unwritable')
    list.toggle(address('11'))
    list.toggle(address('22'))
    assert.deepEqual(list.addresses, [address('99'), address('11'), address('22')], 'the second toggle keeps the first, unsaved one')
    assert.deepEqual(JSON.parse(store.get('t.unwritable')), [address('99')], 'nothing could be written')
    list.toggle(address('99'))
    assert.deepEqual(list.addresses, [address('11'), address('22')], 'removing a stored entry works unsaved too')
    writable = true
    list.toggle(address('33'))
    assert.deepEqual(JSON.parse(store.get('t.unwritable')), [address('11'), address('22'), address('33')])
    assert.deepEqual(list.addresses, [address('11'), address('22'), address('33')])
  } finally {
    delete globalThis.localStorage
  }
})

test('a bounded follow list stops at 256, including when another tab filled the last slot', async (t) => {
  const { AddressList } = await load('lib/addressList.svelte.ts')
  const store = new Map()
  const previous = globalThis.localStorage
  t.after(() => { globalThis.localStorage = previous })
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  const a = new AddressList('t.cap', 256), b = new AddressList('t.cap', 256)
  const who = (n) => `0x${n.toString(16).padStart(40, '0')}`
  for (let n = 1; n <= 256; n++) a.toggle(who(n))
  b.toggle(who(257))
  assert.equal(b.full, true)
  assert.equal(b.has(who(257)), false)
  assert.equal(JSON.parse(store.get('t.cap')).length, 256)
  b.toggle(who(1)); b.toggle(who(257))
  assert.equal(b.has(who(1)), false)
  assert.equal(b.has(who(257)), true)
  assert.equal(b.addresses.length, 256)
})

test('an address list works for the tab when storage is blocked altogether', async () => {
  const { AddressList } = await load('lib/addressList.svelte.ts')
  globalThis.localStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => {} }
  try {
    const list = new AddressList('t.blocked')
    list.toggle(address('11'))
    list.toggle(address('22'))
    assert.deepEqual(list.addresses, [address('11'), address('22')])
    assert.equal(list.has(address('11')), true)
    list.toggle(address('11'))
    assert.deepEqual(list.addresses, [address('22')])
  } finally {
    delete globalThis.localStorage
  }
})

test('retiring moderation storage preserves pending posts, avatars and reserved nonces', async () => {
  const post = makePost(true); sign(post)
  const avatar = { address: author, image: 'cached avatar' }
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('blohard-indexed', 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('pending', { keyPath: 'key' }).put(post)
      db.createObjectStore('avatars', { keyPath: 'address' }).put(avatar)
      db.createObjectStore('nonces').put('123', 'reserved nonce')
      db.createObjectStore('moderation', { keyPath: 'key' }).put({ key: 'retired request' })
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { request.result.close(); resolve() }
  })
  assert.deepEqual(await pending.listPending(), [post])
  assert.deepEqual(await tx(STORES.avatars, 'readonly', s => s.get(author)), avatar)
  assert.equal(await tx(STORES.nonces, 'readonly', s => s.get('reserved nonce')), '123')
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('blohard-indexed')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const stores = [...db.objectStoreNames]
      db.close()
      try { assert.deepEqual(stores, ['avatars', 'nonces', 'pending', 'pendingBytes']); resolve() } catch (error) { reject(error) }
    }
  })
})

// ---- bytes kept apart from progress
const picture = (n) => { const bytes = new Uint8Array(1 << 20).fill(n); return { kind: 'attachment', name: `picture ${n}`, mediaType: 'image/png', bytes, hash: `0x${n.toString(16).padStart(64, '0')}`, status: 'pending' } }
const withPictures = (count) => {
  const post = makePost()
  post.records.push(...Array.from({ length: count }, (_, i) => picture(i + 1)))
  return post
}
/** Bytes carried by each write while `work` runs, by store. */
async function written(work) {
  const writes = [], put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (value, key) {
    const size = value instanceof Uint8Array ? value.length : (value?.records ?? []).reduce((n, r) => n + (r.bytes?.length ?? 0), 0)
    writes.push({ store: this.name, size })
    return put.call(this, value, key)
  }
  try { await work() } finally { IDBObjectStore.prototype.put = put }
  return writes
}
const savedBytes = () => tx(STORES.pendingBytes, 'readonly', (s) => s.count())

test('a post\'s bytes are written once; its progress saves carry none', async () => {
  const post = withPictures(4)
  const saving = await written(() => pending.savePending(post))
  assert.equal(saving.filter((w) => w.store === 'pendingBytes').length, 5, 'each record\'s bytes, once')
  assert.equal(saving.find((w) => w.store === 'pending').size, 0, 'the post itself holds no bytes')
  const progress = await written(async () => {
    await pending.updatePending(post, { walletSubmitted: true })
    await pending.updatePending(post, { txHash })
    for (const r of post.records) await pending.recordUploaded(post.key, r.hash, true)
    await pending.updatePending(post, { messageId: 7n })
  })
  assert.ok(progress.every((w) => w.store === 'pending' && w.size === 0), 'progress rewrites no bytes')
  assert.deepEqual(await pending.listPending(), [{ ...post, records: post.records.map((r) => ({ ...r, status: 'held' })) }])
})

test('a stored record drops its bytes, a held one keeps them, and a finished or deleted post leaves none', async () => {
  const post = withPictures(2)
  await pending.savePending(post)
  await pending.recordUploaded(post.key, post.records[1].hash, true)
  assert.equal(await savedBytes(), 3, 'a 202 keeps the bytes')
  await pending.recordUploaded(post.key, post.records[1].hash, false)
  assert.equal(await savedBytes(), 2, 'confirmed storage frees them')
  await pending.updatePending(post, { messageId: 7n })
  for (const r of [post.records[0], post.records[2]]) await pending.recordUploaded(post.key, r.hash, false)
  assert.deepEqual(await pending.listPending(), [])
  assert.equal(await savedBytes(), 0, 'the finished post leaves nothing behind')
  const other = withPictures(1)
  await pending.savePending(other)
  await pending.deletePending(other.key)
  assert.equal(await savedBytes(), 0)
})

test('recovery reads every record with its bytes while uploads finish around it', async () => {
  const post = withPictures(4)
  await pending.savePending(post)
  const reads = []
  await Promise.all([
    ...post.records.map((r) => pending.recordUploaded(post.key, r.hash, false)),
    ...Array.from({ length: 6 }, () => pending.listPending().then((list) => reads.push(list))),
  ])
  for (const list of reads) for (const r of list.flatMap((p) => p.records)) assert.equal(r.bytes.length, post.records.find((x) => x.hash === r.hash).bytes.length, 'never a record without its bytes')
})

test('a post saved before the split survives the upgrade and completes recovery', async () => {
  const post = withPictures(2); sign(post)
  // The previous schema: bytes inside the post, no byte store.
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('blohard-indexed', 2)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('pending', { keyPath: 'key' }).put(post)
      db.createObjectStore('avatars', { keyPath: 'address' })
      db.createObjectStore('nonces')
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { request.result.close(); resolve() }
  })
  assert.deepEqual(await pending.listPending(), [post], 'readable with its bytes')
  await pending.updatePending(post, { txHash })
  await pending.recordUploaded(post.key, post.records[1].hash, true)
  let [saved] = await pending.listPending()
  assert.equal(saved.txHash, txHash)
  assert.equal(saved.records[1].status, 'held')
  assert.deepEqual(saved.records.map((r) => r.bytes), post.records.map((r) => r.bytes), 'progress keeps every byte, held records included')
  await pending.updatePending(post, { messageId: 7n })
  await pending.recordUploaded(post.key, post.records[0].hash, false)
  ;[saved] = await pending.listPending()
  assert.deepEqual(saved.records.map((r) => r.hash), post.records.slice(1).map((r) => r.hash))
  assert.deepEqual(saved.records[0].bytes, post.records[1].bytes)
  for (const r of post.records.slice(1)) await pending.recordUploaded(post.key, r.hash, false)
  assert.deepEqual(await pending.listPending(), [], 'it completes like any post')
})

test('a save that aborts part way leaves neither the post nor any of its bytes', async () => {
  const post = withPictures(3)
  post.records[2] = { ...post.records[2], bytes: { cannot: () => 'be cloned' } }
  await assert.rejects(pending.savePending(post))
  assert.deepEqual(await pending.listPending(), [])
  assert.equal(await savedBytes(), 0)
})

test('a completion that aborts part way keeps the record and its bytes', async () => {
  const post = withPictures(2)
  await pending.savePending(post)
  const remove = IDBObjectStore.prototype.delete
  IDBObjectStore.prototype.delete = function (key) {
    if (this.name === 'pendingBytes') throw new Error('storage failed')
    return remove.call(this, key)
  }
  try { await assert.rejects(pending.recordUploaded(post.key, post.records[1].hash, false)) }
  finally { IDBObjectStore.prototype.delete = remove }
  const [saved] = await pending.listPending()
  assert.deepEqual(saved.records.map((r) => r.hash), post.records.map((r) => r.hash), 'the record is still owed')
  assert.deepEqual(saved.records[1].bytes, post.records[1].bytes, 'with its bytes')
  assert.equal(await savedBytes(), 3)
})

test('bytes lost from storage make the upload fail rather than complete', async () => {
  const { uploadPost } = await load('features/publishing/posting.ts')
  const post = withPictures(1)
  await pending.savePending(post)
  await tx(STORES.pendingBytes, 'readwrite', (s) => { s.delete([post.key, post.records[1].hash]) })
  const [saved] = await pending.listPending()
  const { hashOf } = await load('lib/store.ts')
  globalThis.fetch = async (_, init) => new Response(JSON.stringify({ hash: hashOf(new Uint8Array(init.body)) }), { status: 200, headers: { 'content-type': 'application/json' } })
  await uploadPost(saved, { messageId: 7n })
  assert.equal(saved.records[0].status, 'stored')
  assert.equal(saved.records[1].status, 'failed', 'the lost picture is not reported stored')
  assert.ok((await pending.listPending())[0].records.some((r) => r.hash === post.records[1].hash), 'and stays owed')
})

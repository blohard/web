// Component-independent publication ownership and recovery races (web/STATE.md).
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, makePost, sign, replyArgs, posted, txHash, response } from '../../../../scripts/host-harness.mjs'
const { RelayUnknown } = await load('features/publishing/relay.ts')
const { Publications } = await load('features/publishing/publications.svelte.ts')
const { DraftBox, emptyDraft } = await load('features/publishing/draft-box.svelte.ts')
const { listPending, savePending } = await load('features/publishing/pending.ts')

let elapsed, jobs
beforeEach(() => { install(); elapsed = 0; jobs = new Set() })
const manager = (accepted) => new Publications((run, delay) => {
  const job = { run, at: elapsed + delay }
  jobs.add(job)
  return () => jobs.delete(job)
}, accepted)
const tick = (ms) => {
  elapsed += ms
  for (const job of [...jobs]) if (job.at <= elapsed) { jobs.delete(job); job.run() }
}
after(teardown)
const write = (box, text) => box.edit({ ...emptyDraft(), text })
const latch = () => {
  let release, started
  const wait = new Promise((r) => { release = r })
  const arrived = new Promise((r) => { started = r })
  return { release, arrived, hold: async () => { started(); await wait } }
}
const args = () => ({ chain: mock.chain, wallet: replyArgs().wallet, parentId: 0n, sponsored: true })

test('publication and pending recovery share one send and the live record', async () => {
  const operations = manager(), post = makePost(), box = new DraftBox()
  write(box, 'sent draft')
  const op = operations.get(post), held = latch()
  mock.relayStatus = 200
  mock.logs = [posted(post)]
  mock.onRelay = held.hold
  const send = op.publish(args(), box)
  await held.arrived
  const [saved] = await operations.list(mock.chain.id)
  assert.equal(saved, op)
  assert.equal(operations.forBox(box), op, 'a remounted composer finds its active operation')
  assert.equal(saved.retry(mock.chain), send, 'retry joins the publication instead of starting a recovery scan')
  assert.equal((await op.discard(mock.chain, () => assert.fail('cannot discard a send'))), false)
  held.release()
  const result = await send
  assert.equal(result.cleared, true)
  assert.equal(box.draft.text, '')
  assert.equal(mock.calls.filter((c) => c.method === 'relay').length, 1)
  assert.deepEqual(await operations.list(mock.chain.id), [])
})

test('completion after navigation cannot clear another page or a newer send', async () => {
  const operations = manager(), post = makePost(), box = new DraftBox(), other = new DraftBox()
  write(box, 'first'); write(other, 'other page')
  const op = operations.get(post), held = latch()
  mock.relayStatus = 200; mock.logs = [posted(post)]; mock.onRelay = held.hold
  const send = op.publish(args(), box)
  await held.arrived
  write(box, 'newer'); box.begin(); other.begin()
  held.release()
  assert.equal((await send).cleared, false)
  assert.equal(box.draft.text, 'newer')
  assert.equal(box.sending, true)
  assert.equal(other.draft.text, 'other page')
  assert.equal(other.sending, true)
})

test('two retry controls join one recovery flight and preserve newer progress', async () => {
  const operations = manager(), post = makePost(true)
  post.messageId = 7n; post.txHash = txHash
  await savePending(post)
  const held = latch(), fetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { if (String(url).startsWith('/api/publish?')) await held.hold(); return fetch(url, init) }
  const [op] = await operations.list(mock.chain.id)
  const one = op.retry(mock.chain)
  await held.arrived
  const [again] = await operations.list(mock.chain.id)
  assert.equal(again, op)
  assert.equal(again.retry(mock.chain), one)
  held.release()
  await one
  assert.equal(mock.calls.filter((c) => c.method === 'upload').length, 2, 'one pass over the body and attachment')
  assert.deepEqual(await listPending(), [])
})

test('a new tab resumes only unfinished bytes from the saved copy', async () => {
  const post = makePost(true)
  post.messageId = 7n; post.txHash = txHash
  await savePending(post)
  mock.uploadErrorHash = post.records[1].hash
  const first = manager()
  const [op] = await first.list(mock.chain.id)
  await op.retry(mock.chain)
  const [saved] = await listPending()
  assert.equal(saved.records.length, 1)
  assert.equal(saved.records[0].kind, 'attachment')
  // A closed tab has no operation or owner; only IndexedDB carries the remaining work.
  const next = manager()
  const [resumed] = await next.list(mock.chain.id)
  mock.uploadErrorHash = null; mock.calls = []
  assert.equal((await resumed.retry(mock.chain)).done, true)
  assert.equal(mock.calls.filter((c) => c.method === 'upload').length, 1)
  assert.deepEqual(await listPending(), [])
})

test('an upload failure unlocks retry and recovery completes only the sent draft', async () => {
  const operations = manager(), post = makePost(true), box = new DraftBox()
  write(box, 'with picture')
  mock.relayStatus = 200; mock.logs = [posted(post)]; mock.uploadErrorHash = post.records[1].hash
  const op = operations.get(post)
  assert.equal((await op.publish(args(), box)).cleared, false)
  assert.equal(op.needsUpload, true)
  assert.equal(box.sending, false, 'the retry button must be usable')
  assert.equal(operations.forBox(box), op)
  mock.uploadErrorHash = null
  const [pending] = await operations.list(mock.chain.id)
  assert.equal((await pending.retry(mock.chain)).cleared, true)
  assert.equal(box.draft.text, '')
})

test('an unknown submission keeps its signature and releases draft ownership', async () => {
  const operations = manager(), post = makePost(), box = new DraftBox()
  write(box, 'uncertain')
  const op = operations.get(post)
  await assert.rejects(op.publish(args(), box), RelayUnknown)
  assert.equal(box.sending, false)
  assert.equal(operations.forBox(box), undefined)
  const [saved] = await operations.list(mock.chain.id)
  assert.equal(saved, op)
  mock.relayStatus = 200; mock.logs = [posted(post)]
  assert.equal((await op.retry(mock.chain)).cleared, false, 'recovery no longer owns the editable draft')
  assert.equal(box.draft.text, 'uncertain')
})

test('an uncertain wallet submission remains an operation and recovers without another send', async () => {
  const operations = manager(), post = makePost(), box = new DraftBox(), sendArgs = { ...args(), sponsored: false }
  write(box, 'wallet draft')
  const request = sendArgs.wallet.provider.request
  let sends = 0
  sendArgs.wallet.provider.request = async (ask) => {
    if (ask.method !== 'eth_sendTransaction') return request(ask)
    sends++
    throw new Error('wallet transport failed after send')
  }
  const op = operations.get(post)
  await assert.rejects(op.publish(sendArgs, box))
  assert.equal(op.done, false)
  assert.match(op.outcome.note, /may still land/)
  assert.equal(box.sending, false)
  assert.equal(box.draft.text, 'wallet draft')
  assert.equal((await operations.list(mock.chain.id))[0], op)
  assert.equal(jobs.size, 1, 'the publication continues its own recovery schedule')
  mock.head++
  mock.logs = [posted(post)]
  assert.equal((await op.retry(mock.chain)).done, true)
  assert.equal(sends, 1)
  assert.equal(jobs.size, 0)
  assert.equal(box.draft.text, 'wallet draft', 'recovery no longer owns the editable draft')
})

test('a tab closing during an attachment upload leaves its bytes recoverable', async () => {
  const post = makePost(true), first = manager(), held = latch()
  post.messageId = 7n; post.txHash = txHash
  await savePending(post)
  const fetch = globalThis.fetch
  let closing = false
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('/api/publish?') && new Uint8Array(init.body).length === post.records[1].bytes.length) {
      await held.hold()
      if (closing) throw new Error('tab closed')
    }
    return fetch(url, init)
  }
  const [op] = await first.list(mock.chain.id)
  const flight = op.retry(mock.chain)
  await held.arrived
  const [during] = await listPending()
  assert.equal(during.records.length, 1, 'the successful body is already forgotten')
  assert.deepEqual(during.records[0].bytes, post.records[1].bytes, 'the in-flight attachment survives')
  closing = true; held.release(); await flight
  globalThis.fetch = fetch; mock.calls = []
  const next = manager()
  const [resumed] = await next.list(mock.chain.id)
  assert.equal((await resumed.retry(mock.chain)).done, true)
  assert.equal(mock.calls.filter((c) => c.method === 'upload').length, 1)
})

test('the completion event reaches its owner before clearing can unmount it', async () => {
  const operations = manager(), post = makePost(), box = new DraftBox()
  write(box, 'sent')
  mock.relayStatus = 200; mock.logs = [posted(post)]
  const finish = box.finish.bind(box)
  let mounted = true, revealed = null
  box.finish = (version) => {
    const result = finish(version)
    queueMicrotask(() => { mounted = false })
    return result
  }
  await operations.get(post).publish(args(), box, (id) => { if (mounted) revealed = id })
  assert.equal(mounted, false)
  assert.equal(revealed, 7n, 'the event is delivered synchronously, not after the await in a destroyed component')
})

test('an unsaved publication remains available to recovery after its composer leaves', async () => {
  const operations = manager(), post = makePost(), box = new DraftBox()
  write(box, 'unsaved')
  const db = globalThis.indexedDB
  globalThis.indexedDB = null
  try {
    const op = operations.get(post)
    await assert.rejects(op.publish(args(), box), RelayUnknown)
    assert.match(op.warning, /refused to keep/)
    const [pending] = await operations.list(mock.chain.id)
    assert.equal(pending, op)
    assert.equal(pending.post.records.length, 1)
  } finally { globalThis.indexedDB = db }
})

test('a retry cannot resolve or discard a post against another chain', async () => {
  const operations = manager(), post = makePost()
  await savePending(post)
  const op = operations.get(post), other = { ...mock.chain, id: mock.chain.id + 1 }
  await assert.rejects(op.retry(other), /another chain/)
  await assert.rejects(op.discard(other, () => assert.fail('wrong chain')), /another chain/)
  assert.equal(mock.calls.length, 0)
  assert.equal((await listPending()).length, 1)
})

test('an idle operation learns a newer saved hash without replacing its live bytes', async () => {
  const operations = manager(), post = makePost()
  await savePending(post)
  const [op] = await operations.list(mock.chain.id)
  await savePending({ ...post, txHash, messageId: 7n }) // another tab learned the transaction
  const [again] = await operations.list(mock.chain.id)
  assert.equal(again, op)
  assert.equal(again.post.txHash, txHash)
  assert.equal(again.post.messageId, 7n)
  await savePending(post) // an older copy cannot undo the newer knowledge
  await operations.list(mock.chain.id)
  assert.equal(op.post.txHash, txHash)
  assert.equal(op.post.records.length, 1)
})

for (const continuing of [false, true]) {
  test(`another tab's newer lookup range adopts ${continuing ? 'its matching cursor' : 'the absence of a cursor'}`, async () => {
    const operations = manager(), post = makePost()
    const cursor = { generation: `0x${'aa'.repeat(32)}`, filter: `0x${'bb'.repeat(32)}`, ceiling: '1000', before: '500' }
    const old = { ...post, fromBlock: 100n, lookup: { cursor, throughBlock: 200n } }
    const op = operations.get({ ...old })
    const lookup = continuing ? { cursor: { ...cursor, filter: `0x${'cc'.repeat(32)}`, ceiling: '2000', before: '1500' }, throughBlock: 300n } : undefined
    await savePending({ ...post, fromBlock: 201n, lookup })
    await operations.list(mock.chain.id)
    assert.equal(op.post.fromBlock, 201n)
    assert.deepEqual(op.post.lookup, lookup)
    // A stale saved copy must not move either part of the live range backwards.
    await savePending(old)
    await operations.list(mock.chain.id)
    assert.equal(op.post.fromBlock, 201n)
    assert.deepEqual(op.post.lookup, lookup)

    const fetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/lookup')) {
        requests++
        const ask = JSON.parse(init.body)
        assert.equal(ask.from_block, '201')
        assert.deepEqual(ask.cursor, lookup?.cursor ?? null, 'the cursor on the wire belongs to this range')
      }
      return fetch(url, init)
    }
    mock.head = 300n; mock.logs = [posted(post)]
    assert.equal((await op.retry(mock.chain)).done, true)
    assert.equal(requests, 1)
    assert.equal(op.post.messageId, 7n)
    assert.deepEqual(await listPending(), [])
  })
}

test('a failed chain lookup cannot authorize discarding saved bytes', async () => {
  const operations = manager(), post = makePost()
  await savePending(post)
  const op = operations.get(post)
  mock.lookupError = true
  await assert.rejects(op.discard(mock.chain, () => assert.fail('an unavailable chain is not an absent post')))
  assert.equal(op.busy, false)
  assert.equal((await listPending()).length, 1)
})

test('publication backoffs are independent and repeated starts do not bypass them', async () => {
  const operations = manager(), a = makePost(), b = makePost()
  sign(a); sign(b)
  mock.relayStatus = 429
  const first = operations.get(a), second = operations.get(b)
  first.start(mock.chain)
  await first.retry(mock.chain) // joins the automatic flight
  assert.deepEqual([...jobs].map((j) => j.at), [15_000])
  tick(15_000); await first.retry(mock.chain)
  assert.deepEqual([...jobs].map((j) => j.at), [45_000])
  second.start(mock.chain); await second.retry(mock.chain)
  const calls = mock.calls.length
  first.start(mock.chain); second.start(mock.chain)
  assert.equal(mock.calls.length, calls)
  assert.deepEqual([...jobs].map((j) => j.at).sort((a, b) => a - b), [30_000, 45_000])
  tick(15_000); await second.retry(mock.chain)
  assert.deepEqual([...jobs].map((j) => j.at).sort((a, b) => a - b), [45_000, 60_000])
  await second.retry(mock.chain) // a manual press resets only its own delay
  assert.deepEqual([...jobs].map((j) => j.at), [45_000, 45_000])
})

test('automatic backoff caps at three minutes while paused and expired signatures still get chain checks', async () => {
  const operations = manager(), post = makePost(); sign(post)
  const op = operations.get(post)
  mock.relayStatus = 403
  op.start(mock.chain); await op.retry(mock.chain)
  assert.equal(post.relayPaused, true)
  for (const delay of [15_000, 30_000, 60_000, 120_000, 180_000, 180_000]) {
    assert.equal([...jobs][0].at, elapsed + delay)
    tick(delay); await op.retry(mock.chain)
  }
  assert.equal(mock.calls.filter((c) => c.method === 'relay').length, 1)
  assert.equal(mock.calls.filter((c) => c.method === 'lookup').length, 7)
  sign(post, Date.now() - 1000)
  tick(180_000); await op.retry(mock.chain)
  assert.equal(mock.calls.filter((c) => c.method === 'relay').length, 1)
  assert.equal(jobs.size, 1)
})

test('automatic completion notifies observers once and cancels the publication timer', async () => {
  const operations = manager(), post = makePost(); sign(post)
  const finished = []
  const stop = operations.watch((p) => finished.push(p.key))
  const op = operations.get(post)
  op.start(mock.chain); await op.retry(mock.chain)
  mock.head++
  mock.logs = [posted(post)]
  tick(15_000); await op.retry(mock.chain)
  assert.equal(op.done, true)
  assert.deepEqual(finished, [post.key])
  assert.equal(jobs.size, 0)
  assert.equal((await operations.list(mock.chain.id)).length, 0)
  stop()
})

test('discard cancels its timer, and a known reverted receipt stops recovery', async () => {
  const operations = manager(), post = makePost(); sign(post)
  const op = operations.get(post)
  op.start(mock.chain); await op.retry(mock.chain)
  assert.equal(await op.discard(mock.chain, () => true), true)
  assert.equal(jobs.size, 0)
  const failed = makePost(); failed.txHash = txHash
  await savePending(failed)
  mock.receiptStatus = '0x0'
  const reverted = operations.get(failed)
  await assert.rejects(reverted.retry(mock.chain))
  // No draft holds these words any more: the saved copy keeps them, without retrying, until discarded.
  assert.equal(reverted.done, false)
  assert.equal(reverted.reverted, true)
  assert.equal(reverted.text, 'test post')
  assert.equal(jobs.size, 0)
  assert.equal((await listPending()).length, 1)
  assert.equal(await reverted.discard(mock.chain, () => true), true)
  assert.equal(reverted.done, true)
  assert.deepEqual(await listPending(), [])
})

test('a send that reverts after its draft was cleared keeps its words until discarded', async () => {
  const operations = manager(), post = makePost(), box = new DraftBox()
  write(box, 'test post')
  const fetch = globalThis.fetch
  let receiptFails = true
  globalThis.fetch = async (url, init) => {
    // A host answer that ends the receipt wait, standing in for its two-minute deadline.
    if (receiptFails && String(url).includes('/transaction/')) return response({ error: 'internal' }, 500)
    return fetch(url, init)
  }
  try {
    const op = operations.get(post)
    await assert.rejects(op.publish({ ...args(), sponsored: false }, box))
    assert.equal(post.txHash, txHash)
    assert.equal(box.draft.text, '', 'a sent transaction clears its draft')
    receiptFails = false
    mock.receiptStatus = '0x0'
    await assert.rejects(op.retry(mock.chain))
    assert.equal(op.done, false, 'the saved copy is now the only one')
    assert.equal(op.text, 'test post')
    assert.match(op.outcome.note, /reverted/)
    assert.equal((await listPending()).length, 1)
    assert.equal(jobs.size, 0, 'a reverted send is not retried on its own')
    assert.equal(await op.discard(mock.chain, () => true), true)
    assert.deepEqual(await listPending(), [])
  } finally { globalThis.fetch = fetch }
})

test('a send that reverts while its composer still holds the words gives them back and keeps no copy', async () => {
  const operations = manager(), post = makePost(), box = new DraftBox()
  write(box, 'test post')
  mock.receiptStatus = '0x0'
  const op = operations.get(post)
  await assert.rejects(op.publish({ ...args(), sponsored: false }, box))
  assert.equal(box.draft.text, 'test post')
  assert.equal(box.sending, false)
  assert.equal(op.done, true)
  assert.deepEqual(await listPending(), [])
})


test('a local publication announces once when its body is accepted, even with a failed attachment', async () => {
  const events = [], operations = manager(async (...args) => { events.push(args) })
  const post = makePost(true), box = new DraftBox()
  write(box, 'with picture')
  mock.relayStatus = 200; mock.logs = [posted(post)]; mock.uploadErrorHash = post.records[1].hash
  const op = operations.get(post)
  assert.equal((await op.publish(args(), box)).cleared, false)
  assert.deepEqual(events, [[mock.chain, 7n, 0n]])
  mock.uploadErrorHash = null
  await op.retry(mock.chain)
  assert.equal(events.length, 1, 'finishing the picture must not announce again')
})

test('body failure waits for recovery before announcing, without a mounted composer', async () => {
  const events = [], operations = manager(async (...args) => { events.push(args) })
  const post = makePost(), box = new DraftBox()
  write(box, 'recover me')
  mock.relayStatus = 200; mock.logs = [posted(post)]; mock.uploadErrorHash = post.bodyHash
  const op = operations.get(post)
  await op.publish(args(), box)
  assert.deepEqual(events, [])
  write(box, 'newer draft')
  mock.uploadErrorHash = null
  assert.equal((await op.retry(mock.chain)).cleared, false)
  assert.deepEqual(events, [[mock.chain, 7n, 0n]])
  assert.equal(box.draft.text, 'newer draft')
})

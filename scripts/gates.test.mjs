// Gate knowledge follows host sequence numbers, with temporary receipt
// overlays ahead of the accepted checkpoint. RPC ordering lives in the host.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { zeroAddress } from 'viem'
import { load, mock, install, teardown, author, address, hash, feedPost, feedHistory, gateChanged, authorGateChanged } from './host-harness.mjs'
const { gates } = await load('lib/gates.svelte.ts')
const { TOMBSTONE, REMOVED } = await load('lib/board.ts')
beforeEach(install)
after(teardown)

test('message and author gates independently follow ordered changes', async () => {
  feedHistory([feedPost(1)])
  await gates.ensureMessage(mock.chain, 1n)
  assert.equal(gates.message(mock.chain, 1n), zeroAddress)
  assert.equal(gates.author(mock.chain, author), mock.authorGate)
  authorGateChanged(author, TOMBSTONE, 2n)
  gateChanged(1n, address('88'), 2n)
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.author(mock.chain, author), TOMBSTONE)
  assert.equal(gates.message(mock.chain, 1n), address('88'))
  gateChanged(1n, zeroAddress, 3n)
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.message(mock.chain, 1n), zeroAddress)
  assert.equal(gates.author(mock.chain, author), TOMBSTONE)
  assert.equal(mock.calls.filter((c) => c.method === 'state').length, 1)
})

test('same-block changes keep their order, while a snapshot includes the whole accepted block', async () => {
  feedHistory([feedPost(1)])
  await gates.ensureMessage(mock.chain, 1n)
  gateChanged(1n, address('88'), 2n)
  gateChanged(1n, TOMBSTONE, 2n)
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.message(mock.chain, 1n), TOMBSTONE)
  const other = { ...mock.chain, contract: address('99') }
  assert.equal(await gates.ensureMessage(other, 1n), TOMBSTONE)
})

test('a receipt for an author change cannot overwrite a later receipt in the same block', async () => {
  await gates.ensureAuthor(mock.chain, author)
  gates.settleAuthor(mock.chain, author, address('88'), { block: 2n, index: 3 })
  gates.settleAuthor(mock.chain, author, address('99'), { block: 2n, index: 1 })
  gates.settleAuthor(mock.chain, author, address('77'), { block: 2n, index: null })
  assert.equal(gates.author(mock.chain, author), address('88'))
  authorGateChanged(author, address('66'), 2n)
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.author(mock.chain, author), address('66'), 'accepted history supersedes the overlay')
  gates.settleAuthor(mock.chain, author, address('55'), { block: 2n, index: 4 })
  assert.equal(gates.author(mock.chain, author), address('66'), 'a delayed receipt cannot undo an accepted snapshot')
})

test('settling before any snapshot survives an earlier snapshot and ends at acceptance', async () => {
  gates.settleMessage(mock.chain, 1n, TOMBSTONE, { block: 2n, index: 0 })
  assert.equal(await gates.ensureMessage(mock.chain, 1n), TOMBSTONE)
  await gates.ensureAuthor(mock.chain, author)
  assert.equal(gates.message(mock.chain, 1n), TOMBSTONE)
  gateChanged(1n, TOMBSTONE, 2n)
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.message(mock.chain, 1n), TOMBSTONE)
})

test('an unknown id caches nothing; once indexed it has its actual gate', async () => {
  mock.onlyKnownMessages = true
  await assert.rejects(gates.ensureMessage(mock.chain, 1n), /message not found/)
  assert.equal(gates.message(mock.chain, 1n), undefined)
  feedHistory([feedPost(1)])
  mock.gates.set(1n, address('77'))
  assert.equal(await gates.ensureMessage(mock.chain, 1n), address('77'))
})

test('random read, receipt, author and message changes converge after failed refreshes', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    install()
    feedHistory(Array.from({ length: 8 }, (_, i) => feedPost(i + 1)))
    let random = seed
    const next = (n) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % n }
    const values = [zeroAddress, address('77'), address('88')]
    const known = new Set()
    await gates.ensureAuthor(mock.chain, author)
    for (let step = 0; step < 30; step++) {
      const id = BigInt(next(8) + 1), value = values[next(values.length)]
      if (next(3) === 0) { await gates.ensureMessage(mock.chain, id); known.add(id) }
      else {
        const block = mock.head + 1n
        if (next(3) === 0) {
          gates.settleAuthor(mock.chain, author, value, { block, index: mock.logs.length })
          authorGateChanged(author, value, block)
        } else {
          if (next(2)) gates.settleMessage(mock.chain, id, value, { block, index: mock.logs.length })
          gateChanged(id, value, block)
        }
      }
      if (next(5) === 0) {
        mock.failRead = (url) => url.endsWith('/changes')
        await assert.rejects(gates.advanceToHead(mock.chain), /index unavailable/)
        mock.failRead = null
      }
      await gates.advanceToHead(mock.chain)
      for (const id of known) assert.equal(gates.message(mock.chain, id), mock.gates.get(id) ?? zeroAddress, `seed ${seed}, step ${step}, id ${id}`)
      assert.equal(gates.author(mock.chain, author), mock.authorGate, `seed ${seed}, step ${step}, author`)
    }
  }
})

const reset = (e) => e?.code === 'reset_required'
const { snapshots, record } = await load('lib/api.ts')

test('a rebuilt index starts the gate ledger over, keeping this browser\'s own receipts', async () => {
  feedHistory([feedPost(1), feedPost(2)])
  await gates.ensureMessage(mock.chain, 1n)
  gateChanged(1n, address('88'), 2n)
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.message(mock.chain, 1n), address('88'))
  gates.settleMessage(mock.chain, 2n, TOMBSTONE, { block: 9n, index: 0 })
  // The host rebuilt its index: the old position means nothing in the new history.
  mock.generation = hash('bb')
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.message(mock.chain, 1n), undefined, 'nothing known from the old history is kept')
  assert.equal(gates.message(mock.chain, 2n), TOMBSTONE, 'a receipt stays until accepted history covers it')
  assert.equal(await gates.ensureMessage(mock.chain, 1n), address('88'), 'read afresh from the new history')
})

test('an answer from the replaced history is refused and cannot bring it back', async () => {
  feedHistory([feedPost(1)])
  const before = await snapshots(mock.chain, [1n])
  gates.observe(mock.chain, before.at, [record(before.items[0])])
  mock.generation = hash('bb')
  await gates.advanceToHead(mock.chain)
  const late = { ...record(before.items[0]), gate: TOMBSTONE }
  assert.throws(() => gates.observe(mock.chain, before.at, [late]), reset)
  assert.equal(gates.message(mock.chain, 1n), undefined)
  assert.equal(await gates.ensureMessage(mock.chain, 1n), zeroAddress, 'the new history still answers')
  assert.throws(() => gates.observe(mock.chain, before.at, [late]), reset, 'a second late answer is refused too')
})

test('history the host no longer keeps re-seeds the ledger at its head and forgets what may have changed', async () => {
  feedHistory([feedPost(1)])
  await gates.ensureMessage(mock.chain, 1n)
  gateChanged(1n, address('88'), 2n)
  const head = (await snapshots(mock.chain)).at
  mock.firstRetained = BigInt(head.sequence)
  gates.settleMessage(mock.chain, 5n, TOMBSTONE, { block: 9n, index: 0 })
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.message(mock.chain, 1n), undefined, 'the skipped stretch may have changed it')
  assert.equal(gates.message(mock.chain, 5n), TOMBSTONE, 'this browser\'s receipt stays')
  assert.equal(await gates.ensureMessage(mock.chain, 1n), address('88'))
  gateChanged(1n, TOMBSTONE, 3n)
  mock.calls.length = 0
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.message(mock.chain, 1n), TOMBSTONE, 'and the ledger follows changes from the head')
  assert.equal(mock.calls.filter((c) => c.method === 'changes').length, 1)
})

test('a catch-up longer than a refresh may spend re-seeds the ledger at the head', async () => {
  feedHistory([feedPost(1)])
  await gates.ensureMessage(mock.chain, 1n)
  for (let block = 2n; block < 212n; block++) gateChanged(1n, block % 2n ? address('88') : zeroAddress, block)
  // Each answer covers one entry, so the backlog needs more pages than the budget allows.
  const real = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const answer = await real(input, init)
    if (!String(input).endsWith('/changes')) return answer
    const body = JSON.parse(init.body), data = await answer.clone().json()
    const through = String(BigInt(body.after) + 1n)
    return new Response(JSON.stringify({ ...data, changes: data.changes.filter((c) => BigInt(c.sequence) <= BigInt(through)), records: [], references: [], through, more: BigInt(through) < BigInt(data.until.sequence) }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await gates.advanceToHead(mock.chain)
  } finally { globalThis.fetch = real }
  gateChanged(1n, TOMBSTONE, 212n)
  mock.calls.length = 0
  await gates.advanceToHead(mock.chain)
  assert.equal(gates.message(mock.chain, 1n), TOMBSTONE)
  assert.equal(mock.calls.filter((c) => c.method === 'changes').length, 1, 'following resumes from the head')
})

test('a rebuilt index drops the chain\'s cached records and refuses late ones, leaving other chains alone', async () => {
  const { rememberMessages, getMessage } = await load('lib/messages.ts')
  feedHistory([feedPost(1)])
  const first = await snapshots(mock.chain, [1n])
  rememberMessages(mock.chain, first.at, [record(first.items[0])])
  const other = { ...mock.chain, contract: address('99') }
  rememberMessages(other, first.at, [record(first.items[0])])
  mock.generation = hash('bb')
  const fresh = await snapshots(mock.chain, [1n])
  // The new history may commit the same id to other content.
  const rebuilt = { ...record(fresh.items[0]), commitment: hash('cd') }
  assert.throws(() => rememberMessages(mock.chain, fresh.at, [rebuilt]), reset, 'not before the host\'s head confirms the rebuild')
  await gates.advanceToHead(mock.chain)
  rememberMessages(mock.chain, fresh.at, [rebuilt])
  assert.equal((await getMessage(mock.chain, 1n)).commitment, hash('cd'))
  assert.throws(() => rememberMessages(mock.chain, first.at, [record(first.items[0])]), reset)
  assert.equal((await getMessage(mock.chain, 1n)).commitment, hash('cd'), 'the old history cannot come back')
  mock.calls.length = 0
  assert.equal((await getMessage(other, 1n)).commitment, record(first.items[0]).commitment)
  assert.equal(mock.calls.length, 0, 'another chain keeps its cached records')
})

test('a gate changed in skipped history is read again, not kept', async () => {
  feedHistory([feedPost(1)])
  assert.equal(await gates.ensureMessage(mock.chain, 1n), zeroAddress)
  gateChanged(1n, address('88'), 2n)
  mock.firstRetained = BigInt((await snapshots(mock.chain)).at.sequence)
  await gates.advanceToHead(mock.chain)
  assert.equal(await gates.ensureMessage(mock.chain, 1n), address('88'))
})

test('a failed head read after losing the position is retried by the next refresh', async () => {
  feedHistory([feedPost(1)])
  await gates.ensureMessage(mock.chain, 1n)
  gateChanged(1n, address('88'), 2n)
  mock.firstRetained = BigInt((await snapshots(mock.chain)).at.sequence)
  mock.failRead = (url) => url.endsWith('/state')
  await assert.rejects(gates.advanceToHead(mock.chain), /index unavailable/)
  mock.failRead = null
  mock.calls.length = 0
  await gates.advanceToHead(mock.chain)
  assert.ok(mock.calls.some((c) => c.method === 'state'), 'the head is asked for again')
  assert.equal(await gates.ensureMessage(mock.chain, 1n), address('88'))
})

test('a slow first read from before a rebuild cannot displace the newer history that answered first', async () => {
  const { deferred } = await import('./harness.mjs')
  feedHistory([feedPost(1), feedPost(2)])
  const real = globalThis.fetch, started = deferred(), release = deferred()
  globalThis.fetch = async (input, init) => {
    const answer = await real(input, init)
    if (String(input).endsWith('/state') && JSON.parse(init.body).ids?.[0] === '1') {
      started.resolve()
      await release.promise
    }
    return answer
  }
  try {
    const slow = gates.ensureMessage(mock.chain, 1n).then((value) => ({ value }), (error) => ({ error }))
    await started.promise
    mock.generation = hash('bb')
    assert.equal(await gates.ensureMessage(mock.chain, 2n), zeroAddress)
    assert.equal(gates.generation(mock.chain), hash('bb'))
    release.resolve()
    assert.ok(reset((await slow).error), 'the late answer is refused')
    assert.equal(gates.generation(mock.chain), hash('bb'))
    assert.equal(await gates.ensureAuthor(mock.chain, address('77')), mock.authorGate, 'the current history still answers')
  } finally { release.resolve(); globalThis.fetch = real }
})

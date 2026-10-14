// Deletion and removal are wallet actions, independent of browser storage or sponsorship.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { decodeFunctionData } from 'viem'
import { load, install, teardown, mock, replyArgs, gateChanged, address, txHash, response } from '../../../../scripts/host-harness.mjs'

const { moderate } = await load('features/messages/moderation.ts')
const { TOMBSTONE, REMOVED } = await load('lib/board.ts')
const { boardAbi } = await load('lib/abi/board.ts')
const { Reverted } = await load('lib/transactions.ts')
const { messageActions } = await load('features/messages/message-actions.svelte.ts')
const { gates } = await load('lib/gates.svelte.ts')
beforeEach(install)
after(teardown)

for (const [action, gate] of [['delete', TOMBSTONE], ['remove', REMOVED]]) {
  for (const storage of ['unavailable', 'throws']) {
    test(`${action} works when IndexedDB ${storage}`, async () => {
      const previous = globalThis.indexedDB
      let opens = 0
      globalThis.indexedDB = storage === 'unavailable' ? undefined : { open() { opens++; throw new Error('storage denied') } }
      try {
        gateChanged(9n, gate, 12n)
        const { wallet } = replyArgs()
        const landed = await moderate(wallet, mock.chain, 9n, action)
        assert.equal(landed.txHash, txHash)
        assert.equal(opens, 0, 'moderation must not depend on browser storage')
        const sends = mock.calls.filter(c => c.method === 'eth_sendTransaction')
        assert.equal(sends.length, 1)
        assert.equal(mock.calls.some(c => ['moderate', 'relay', 'eth_signTypedData_v4'].includes(c.method)), false)
      } finally { globalThis.indexedDB = previous }
    })
  }
  test(`${action} sends the selected message and gate through the wallet`, async () => {
    const { wallet } = replyArgs()
    const request = wallet.provider.request.bind(wallet.provider)
    let submitted
    wallet.provider.request = async args => {
      if (args.method === 'eth_sendTransaction') submitted = args.params[0]
      return request(args)
    }
    gateChanged(9n, gate, 12n)
    await moderate(wallet, mock.chain, 9n, action)
    assert.deepEqual(decodeFunctionData({ abi: boardAbi, data: submitted.data }), { functionName: 'setReplyGate', args: [9n, gate] })
  })
}

test('paid moderation captures the wallet before switching chains', async () => {
  const { wallet } = replyArgs()
  wallet.ensureChain = async () => { wallet.account = address('88') }
  await assert.rejects(moderate(wallet, mock.chain, 9n, 'delete'), /wallet account changed/)
  assert.equal(mock.calls.some(c => c.method === 'eth_sendTransaction'), false)
})

test('provider changes and disconnected wallets do not send moderation', async () => {
  const { wallet } = replyArgs()
  wallet.ensureChain = async () => { wallet.provider = { request: async () => assert.fail('changed provider must not send') } }
  await assert.rejects(moderate(wallet, mock.chain, 9n, 'delete'), /wallet account changed/)
  await assert.rejects(moderate({ ...wallet, account: null }, mock.chain, 9n, 'delete'), /connect a wallet/)
})

test('reverted moderation is reported as a failure', async () => {
  const { wallet } = replyArgs()
  mock.receiptStatus = '0x0'
  await assert.rejects(moderate(wallet, mock.chain, 9n, 'delete'), Reverted)
})

test('paid moderation needs no sponsorship lookup', async () => {
  gateChanged(9n, TOMBSTONE, 12n)
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.ok(!String(url).includes('/api/relay/') && !String(url).endsWith('/state'))
    return previous(url, init)
  }
  const { wallet } = replyArgs()
  await moderate(wallet, mock.chain, 9n, 'delete')
  assert.equal(mock.calls.filter(c => c.method === 'eth_sendTransaction').length, 1)
})

test('a change whose receipt never came is kept: no second send until a check finds it landed', async () => {
  const { wallet } = replyArgs()
  gateChanged(21n, TOMBSTONE, 12n)
  const fetch = globalThis.fetch
  let lost = true
  globalThis.fetch = async (url, init) => lost && String(url).includes('/transaction/') ? response({ error: 'internal' }, 500) : fetch(url, init)
  try {
    await assert.rejects(moderate(wallet, mock.chain, 21n, 'delete'))
    assert.equal(messageActions.unsettled(mock.chain, 21n), txHash, 'the hash is kept')
    await assert.rejects(moderate(wallet, mock.chain, 21n, 'delete'), /may still land/)
    assert.equal(mock.calls.filter(c => c.method === 'eth_sendTransaction').length, 1, 'never sent twice')
    lost = false
    assert.equal(await messageActions.check(mock.chain, 21n), 'landed')
    assert.equal(gates.message(mock.chain, 21n), TOMBSTONE, 'the landed change shows')
    assert.equal(messageActions.unsettled(mock.chain, 21n), null)
  } finally { globalThis.fetch = fetch }
})

test('a reverted change settles its hash, and a cleared one lets the reader send again', async (t) => {
  const saved = new Map(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage })
  const { wallet } = replyArgs()
  mock.receiptStatus = '0x0'
  await assert.rejects(moderate(wallet, mock.chain, 22n, 'delete'), Reverted)
  assert.equal(messageActions.unsettled(mock.chain, 22n), null, 'nothing can land')
  mock.receiptStatus = '0x1'
  const fetch = globalThis.fetch
  globalThis.fetch = async (url, init) => String(url).includes('/transaction/') ? response({ error: 'internal' }, 500) : fetch(url, init)
  try {
    await assert.rejects(moderate(wallet, mock.chain, 23n, 'delete'))
    assert.equal(await messageActions.check(mock.chain, 23n).catch(() => 'failed'), 'failed', 'a check that cannot read keeps the hash')
    assert.equal(messageActions.unsettled(mock.chain, 23n), txHash)
    messageActions.clear(mock.chain, 23n)
    assert.equal(messageActions.unsettled(mock.chain, 23n), null)
  } finally { globalThis.fetch = fetch }
})

test('a page grouped to the newest gate change per subject is applied, and an older overlap cannot undo it', async () => {
  const chain = mock.chain
  const at = (sequence) => ({ generation: mock.generation, sequence: String(sequence), checkpoint: { block: '100', hash: txHash } })
  const position = { block: '100', log: 0 }
  const page = (from, through, changes, more = false) => ({ at: at(Math.max(through, 20)), until: at(Math.max(through, 20)), gates: true, changes, records: [], references: [], through: String(through), more })
  const flip = (sequence, id, old, next) => ({ sequence: String(sequence), event: { kind: 'chain', event: { kind: 'reply_gate', id: String(id), old, new: next, position } } })
  const author = address('a1')
  assert.ok(gates.observe(chain, at(10), [{ id: 1n, gate: address('00'), author, authorGate: address('00') }]))
  // Only the newest flip per subject: sequence gaps, and an old value that does not follow what the ledger knows.
  const grouped = page(10, 20, [
    flip(15, 1, address('51'), address('52')),
    { sequence: '20', event: { kind: 'chain', event: { kind: 'author_gate', author, old: address('61'), new: address('62'), position } } },
  ])
  assert.equal(gates.follow(chain, at(10), grouped), true)
  assert.equal(gates.message(chain, 1n), address('52'))
  assert.equal(gates.author(chain, author), address('62'))
  // An older answer for a range already applied changes nothing...
  assert.equal(gates.follow(chain, at(10), page(10, 14, [flip(12, 1, address('00'), address('51'))])), true)
  assert.equal(gates.message(chain, 1n), address('52'))
  // ...and an overlapping one applies only what lies past the ledger's position.
  assert.equal(gates.follow(chain, at(10), page(10, 25, [flip(12, 1, address('00'), address('51')), flip(25, 1, address('52'), address('53'))])), true)
  assert.equal(gates.message(chain, 1n), address('53'))
})

test('a refresh takes up to two hundred pages: ten thousand gate changes finish, one more makes it start over', async () => {
  const { changePages } = await load('lib/api.ts')
  const chain = mock.chain
  const at = (sequence) => ({ generation: mock.generation, sequence: String(sequence), checkpoint: { block: '100', hash: txHash } })
  const position = { block: '100', log: 0 }
  const fetch = globalThis.fetch
  let total = 0
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith('/changes')) return fetch(url, init)
    const { after } = JSON.parse(init.body)
    const from = Number(after), through = Math.min(from + 50, total)
    const changes = Array.from({ length: through - from }, (_, n) => ({ sequence: String(from + n + 1), event: { kind: 'chain', event: { kind: 'reply_gate', id: String(from + n + 1), old: address('00'), new: address('51'), position } } }))
    return response({ at: at(total), until: at(total), gates: true, changes, records: [], references: [], through: String(through), more: through < total })
  }
  try {
    for (const [count, pages] of [[10_000, 200]]) {
      total = count
      let seen = 0
      for await (const _ of changePages(chain, at(0))) seen++
      assert.equal(seen, pages)
    }
    total = 10_001
    await assert.rejects((async () => { for await (const _ of changePages(chain, at(0))) { /* paging */ } })(), { code: 'refresh_budget_exhausted_try_again' })
  } finally {
    globalThis.fetch = fetch
  }
})

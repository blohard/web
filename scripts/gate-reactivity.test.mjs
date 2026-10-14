import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactiveFixture } from './svelte-test.mjs'

// The usual SSR harness cannot observe reactive invalidation. Compile this
// small fixture for the browser, then run its state-only effects in Node.
const { gates, flushSync, watchAuthor, watchMessage } = await reactiveFixture(new URL('./fixtures/gate-reactivity.svelte.ts', import.meta.url))
const address = byte => '0x' + byte.repeat(20)
const owner = address('22'), zero = address('00'), tombstone = address('00').slice(0, -1) + '1'
const chain = { id: 84532, contract: address('11') }

test('a first account read updates the mounted view, and receipt changes stay reactive', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const ask = JSON.parse(init.body)
    return new Response(JSON.stringify({
      at: { generation: '0x' + 'aa'.repeat(32), sequence: '1', checkpoint: { block: '1', hash: '0x' + '77'.repeat(32) } },
      items: [], accounts: ask.accounts.map(address => ({ address, gate: zero, member: false })), memberships: [],
    }), { headers: { 'content-type': 'application/json' } })
  }
  const seen = []
  const stop = watchAuthor(chain, owner, gate => seen.push(gate))
  try {
    flushSync()
    assert.deepEqual(seen, [undefined])
    await gates.ensureAuthor(chain, owner)
    flushSync()
    assert.deepEqual(seen, [undefined, zero], 'a cold page must notice its first account snapshot')
    gates.settleAuthor(chain, owner, tombstone, { block: 2n, index: 0 })
    flushSync()
    assert.deepEqual(seen, [undefined, zero, tombstone], 'the same view follows a confirmed change')
  } finally { stop(); globalThis.fetch = previous }
})

test('a first message receipt updates a view with no existing chain ledger', () => {
  const other = { ...chain, id: 84533 }, seen = []
  const stop = watchMessage(other, 7n, gate => seen.push(gate))
  try {
    flushSync()
    assert.deepEqual(seen, [undefined])
    gates.settleMessage(other, 7n, tombstone, { block: 2n, index: 0 })
    flushSync()
    assert.deepEqual(seen, [undefined, tombstone])
  } finally { stop() }
})

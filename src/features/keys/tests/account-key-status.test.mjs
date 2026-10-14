import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { reactiveFixture } from '../../../../scripts/svelte-test.mjs'

const address = byte => '0x' + byte.repeat(20)
const chain = { id: 84532, name: 'test', contract: address('11'), public_rpc_url: 'https://rpc.example.test' }
const { profileStatus, flushSync } = await reactiveFixture(new URL('./fixtures/account-key-status.svelte.ts', import.meta.url), {
  'import.meta.env.VITE_ACCOUNT_KEYS_ADDRESS': JSON.stringify(address('88')),
  'import.meta.env.VITE_ACCOUNT_KEYS_DEV_FUND': JSON.stringify(address('99')),
})
globalThis.location = { origin: 'https://site.example.test' }
const previousFetch = globalThis.fetch
let calls
beforeEach(() => {
  calls = []
  globalThis.fetch = (_url, init) => new Promise(resolve => {
    const ask = JSON.parse(init.body)
    assert.equal(ask.method, 'eth_call')
    calls.push({
      author: '0x' + ask.params[0].data.slice(-40),
      answer(active) { resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: ask.id, result: '0x' + (active ? '1' : '0').padStart(64, '0') }))) },
      fail() { resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: ask.id, error: { code: -32603, message: 'temporarily unavailable' } }))) },
    })
  })
})
after(() => { globalThis.fetch = previousFetch })
async function until(condition) {
  for (let n = 0; n < 500; n++) {
    flushSync()
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail('reactive state did not settle')
}

test('missing market is unavailable and never starts an RPC read', async () => {
  const view = profileStatus({ ...chain, id: 1 }, address('22'))
  try {
    flushSync()
    assert.equal(view.state, 'unavailable')
    view.retry(); view.refresh(); flushSync()
    assert.equal(view.state, 'unavailable')
    assert.equal(calls.length, 0)
  } finally { view.stop() }
})

test('failed activation reads can be retried and normal refresh still works', async () => {
  const view = profileStatus(chain, address('22'))
  try {
    assert.equal(view.state, 'loading')
    await until(() => calls.length === 1)
    calls[0].fail()
    await until(() => view.state === 'failed')
    view.retry()
    await until(() => calls.length === 2)
    assert.equal(view.state, 'loading')
    calls[1].answer(false)
    await until(() => view.state === 'inactive')
    view.refresh()
    await until(() => calls.length === 3)
    assert.equal(view.state, 'inactive', 'keep the last successful value while refreshing')
    calls[2].answer(true)
    await until(() => view.state === 'active')
    assert.equal(calls.length, 3, 'reading the result must not start another fetch')
    view.refresh()
    await until(() => calls.length === 4)
    calls[3].fail()
    await until(() => view.state === 'failed')
    assert.equal(view.active, true, 'a failed refresh must not hide the existing badge or keys tab')
  } finally { view.stop() }
})

test('switching profile or chain ignores late results and never reuses another account status', async () => {
  const view = profileStatus(chain, address('22'))
  try {
    await until(() => calls.length === 1)
    view.visit(chain, address('33'))
    assert.equal(view.state, 'loading')
    await until(() => calls.length === 2)
    assert.equal(calls[1].author, address('33'))
    calls[1].answer(false)
    await until(() => view.state === 'inactive')
    calls[0].answer(true)
    await new Promise(resolve => setTimeout(resolve, 5)); flushSync()
    assert.equal(view.state, 'inactive')
    view.refresh()
    await until(() => calls.length === 3)
    view.visit({ ...chain, id: 1 }, address('33')); flushSync()
    calls[2].answer(true)
    await new Promise(resolve => setTimeout(resolve, 5)); flushSync()
    assert.equal(view.state, 'unavailable')
    assert.equal(view.active, false)
    assert.equal(calls.length, 3)
  } finally { view.stop() }
})

test('a reader without a wallet learns key status from the host index, with no chain read', async () => {
  const asked = []
  const before = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (init?.body) return before(url, init) // a chain read would land in calls
    asked.push(String(url))
    return new Response(JSON.stringify({ market: address('88'), active: true, holders: [], holding: [], truncated: { holders: false, holding: false } }),
      { headers: { 'content-type': 'application/json' } })
  }
  const view = profileStatus(chain, address('44'), { indexed: address('88') })
  try {
    await until(() => view.state === 'active')
    assert.deepEqual(asked, [`/api/chains/84532/keyring/${address('44')}`])
    assert.equal(calls.length, 0, 'no chain read')
  } finally { view.stop(); globalThis.fetch = before }
  // A host indexing another market says nothing about this one.
  const other = profileStatus(chain, address('55'), { indexed: address('77') })
  try {
    flushSync()
    assert.equal(other.state, 'unavailable')
    assert.equal(calls.length, 0)
  } finally { other.stop() }
})

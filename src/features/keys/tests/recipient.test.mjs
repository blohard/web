import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { getAddress } from 'viem'
import { load, install, teardown, address } from '../../../../scripts/harness.mjs'
const { recipientInput, resolveRecipient, canRetryRecipient } = await load('features/keys/recipient.ts')
beforeEach(install)
after(teardown)

test('recipient input keeps addresses immediate and names separate', () => {
  const to = address('ab')
  assert.deepEqual(recipientInput(` ${to} `), { address: getAddress(to), name: null, error: '', hint: '' })
  assert.deepEqual(recipientInput(' Alice.base.eth '), { address: null, name: 'Alice.base.eth', error: '', hint: '' })
  assert.deepEqual(recipientInput(''), { address: null, name: null, error: '', hint: '' })
  for (const value of ['0x123', '0xbroken.eth', 'alice .eth', `a\n.eth`, `${'a'.repeat(256)}.eth`]) {
    assert.ok(recipientInput(value).error, value)
  }
  const checksum = getAddress(to)
  const broken = checksum.replace(/[A-F]/, c => c.toLowerCase())
  assert.ok(recipientInput(broken).error, 'a broken checksum is not treated as a name')
})

test('only complete eth names are looked up while incomplete input stays a hint', () => {
  for (const value of ['alice', 'alice.b', 'alice.base.e', 'alice.com']) {
    assert.deepEqual(recipientInput(value), { address: null, name: null, error: '', hint: 'names end in .eth' })
  }
  assert.equal(recipientInput('Alice.ETH').name, 'Alice.ETH')
})

test('the host normalizes trimmed input and returns the reviewed name and address', async () => {
  const to = address('ab'), calls = []
  globalThis.fetch = async url => {
    calls.push(url)
    return Response.json({ name: decodeURIComponent(url.split('/').at(-1)).toLowerCase(), address: to })
  }
  assert.deepEqual(await resolveRecipient(' Alice.ETH '), { name: 'alice.eth', address: getAddress(to) })
  assert.deepEqual(await resolveRecipient('Alice.BASE.eth'), { name: 'alice.base.eth', address: getAddress(to) })
  assert.deepEqual(calls, ['/api/names/resolve/Alice.ETH', '/api/names/resolve/Alice.BASE.eth'])
})

test('malformed names and host answers cannot supply a recipient', async () => {
  globalThis.fetch = async () => Response.json({ error: 'invalid_name' }, { status: 400 })
  await assert.rejects(resolveRecipient('alice..eth'), /invalid name/)
  for (const answer of [null, {}, { name: 42, address: address('22') },
    { name: 'alice.eth', address: 'broken' }, { name: 'alice.eth', address: address('00') }]) {
    globalThis.fetch = async () => Response.json(answer)
    await assert.rejects(resolveRecipient('alice.eth'), /invalid recipient/)
  }
  globalThis.fetch = async () => Response.json({ name: 'alice.eth', address: null })
  await assert.rejects(resolveRecipient('alice.eth'), /no wallet address/)
  globalThis.fetch = async () => Response.json({ error: 'name_unavailable' }, { status: 503 })
  await assert.rejects(resolveRecipient('alice.eth'), /name unavailable/)
})

test('a later lookup does not change an already reviewed recipient', async () => {
  let target = address('22')
  globalThis.fetch = async () => Response.json({ name: 'alice.eth', address: target })
  const reviewed = await resolveRecipient('alice.eth')
  target = address('33')
  assert.equal((await resolveRecipient('alice.eth')).address, target)
  assert.equal(reviewed.address, address('22'))
})


test('only unavailable or busy services offer a recipient retry', async () => {
  for (const [status, code, retry] of [[503, 'name_unavailable', true], [503, 'host_busy', true],
    [400, 'invalid_name', false], [429, 'rate_limited', false]]) {
    globalThis.fetch = async () => Response.json({ error: code }, { status })
    await assert.rejects(resolveRecipient('alice.eth'), error => canRetryRecipient(error) === retry)
  }
  globalThis.fetch = async () => Response.json({ name: 'alice.eth', address: null })
  await assert.rejects(resolveRecipient('alice.eth'), error => !canRetryRecipient(error))
  globalThis.fetch = async () => { throw new Error('offline') }
  await assert.rejects(resolveRecipient('alice.eth'), error => !canRetryRecipient(error))
})

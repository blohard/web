import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { hexToString } from 'viem'
import { load, install, teardown, curate, mock, author, address, response, replyArgs, renderComponent, hash } from './host-harness.mjs'
const { host } = await load('lib/host.svelte.ts')
const { policyMessage, saveHostList, adoptPolicy, readHostPolicy, allowHostPosting } = await load('lib/host-policy.ts')
const { wallet } = await load('lib/wallet.svelte.ts')
beforeEach(() => { install(); curate([]) })
after(teardown)

for (const change of ['account', 'provider', 'disconnect']) test(`an admin ${change} during network switching cancels the edit`, async () => {
  const { wallet } = replyArgs()
  wallet.ensureChain = async () => {
    if (change === 'account') wallet.account = address('88')
    if (change === 'provider') wallet.provider = { request: () => assert.fail('replacement provider used') }
    if (change === 'disconnect') wallet.account = null
  }
  await assert.rejects(saveHostList(wallet, 'blocked', 'add', [address('99')]), /wallet.*changed/)
  assert.equal(mock.calls.some(c => c.method === 'personal_sign' || c.method === 'eth_sendTransaction'), false)
})

test('admin edits sign a host, revision, expiry and exact addresses without a transaction', async () => {
  const { wallet } = replyArgs(), requests = [], edits = []
  wallet.provider.request = async args => {
    requests.push(args)
    if (args.method === 'eth_accounts') return [author]
    if (args.method === 'personal_sign') return '0x1234'
    assert.fail(`unexpected wallet call ${args.method}`)
  }
  const fetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/host-policy' && init?.body) {
      const edit = JSON.parse(init.body); edits.push(edit)
      return response({ ...mock.hostPolicy, revision: '2', blocked: edit.addresses })
    }
    return fetch(url, init)
  }
  await saveHostList(wallet, 'blocked', 'add', [address('99')])
  assert.equal(edits.length, 1)
  const edit = edits[0]
  assert.equal(edit.revision, '1')
  assert.equal(edit.signature, '0x1234')
  assert.equal(hexToString(requests.find(r => r.method === 'personal_sign').params[0]), policyMessage('https://client.invalid', edit))
  assert.equal(host.blocked(address('99')), true)
  assert.equal(mock.calls.find(c => c.method === 'wallet:ensureChain')?.need, 'optional', 'a signature needs no wallet RPC')
})

test('a non-admin never reaches wallet signing', async () => {
  const { wallet } = replyArgs(); mock.hostPolicy.admin = address('88')
  await assert.rejects(saveHostList(wallet, 'curated', 'add', [author]), /only the host admin/)
  assert.equal(mock.calls.length, 1, 'policy read only')
})

test('late policy reads cannot undo a newer block; failed reads retain it', async () => {
  adoptPolicy({ ...mock.hostPolicy, revision: '5', blocked: [author] })
  adoptPolicy({ ...mock.hostPolicy, revision: '4', blocked: [] })
  assert.equal(host.blocked(author), true)
  mock.hostStatus = 503
  await assert.rejects(readHostPolicy())
  assert.equal(host.blocked(author), true)
  await assert.rejects(allowHostPosting(author), /host/)
})

test('posting rechecks policy and a blocked composer has no input or attachment control', async () => {
  mock.hostPolicy.blocked = [author]
  await assert.rejects(allowHostPosting(author), /posting blocked by host/)
  wallet.account = author
  try {
    const html = await renderComponent('features/publishing/Composer.svelte', { chain: mock.chain })
    assert.match(html, /posting blocked by host/)
    assert.doesNotMatch(html, /<textarea|type="file"|attach|>post</)
  } finally { wallet.account = null }
})

test('host blocks prevent posting without disabling other wallet actions', async () => {
  const { guarded } = await load('lib/signer.ts')
  const { wallet } = replyArgs()
  mock.hostPolicy.admin = address('88')
  adoptPolicy({ ...mock.hostPolicy, blocked: [author] })
  const asked = []
  wallet.provider.request = async ({ method }) => {
    asked.push(method)
    return method === 'eth_accounts' ? [author] : 'ok'
  }
  const provider = guarded(wallet.provider, author)
  for (const method of ['eth_sendTransaction', 'wallet_sendTransaction', 'personal_sign', 'eth_signTypedData_v4']) {
    assert.equal(await provider.request({ method, params: [] }), 'ok')
  }
  assert.equal(asked.filter(method => method === 'eth_accounts').length, 4, 'wallet identity is still checked')
  mock.hostPolicy.blocked = [author]
  await assert.rejects(allowHostPosting(author), /posting blocked by host/)
})

test('a blocked post stays hidden but its author can delete it from its own page', async () => {
  const { gates } = await load('lib/gates.svelte.ts')
  const { zeroAddress } = await import('viem')
  const msg = { id: 1n, parentId: 0n, parentAuthor: zeroAddress, author, contentHash: hash('42'), blockNumber: 1n, logIndex: 0 }
  adoptPolicy({ ...mock.hostPolicy, blocked: [author] })
  gates.settleMessage(mock.chain, msg.id, zeroAddress, { block: 1n, index: 0 })
  const render = () => renderComponent('features/messages/MessageCard.svelte', { chain: mock.chain, msg, linkToThread: false })
  try {
    for (const account of [null, address('88'), author]) {
      wallet.account = account
      const html = await render()
      assert.match(html, /post blocked by host/)
      assert.equal(/delete<\/button>/.test(html), account === author)
      assert.doesNotMatch(html, /↳ reply|↱ quote|reply rule/)
    }
    assert.equal(mock.calls.some(c => c.method === 'content'), false, 'hidden post bytes are not fetched')
  } finally { wallet.account = null }
})

for (const sponsored of [false, true]) test(`a ${sponsored ? 'sponsored' : 'paid'} post checks host blocking after a wallet network switch`, async () => {
  const { publishPost } = await load('features/publishing/posting.ts')
  const args = { ...replyArgs(), parentId: 0n, sponsored }
  args.wallet.ensureChain = async () => { mock.hostPolicy.blocked = [author] }
  await assert.rejects(publishPost(args), /posting blocked by host/)
  assert.equal(mock.calls.some(c => ['eth_sendTransaction', 'wallet_sendTransaction', 'eth_signTypedData_v4'].includes(c.method)), false)
})

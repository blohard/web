// Bot labels (design/BOT_LABELS.md): which robot shows, how policy answers
// merge, the signed declaration, and the account-list tabs.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { hexToString } from 'viem'
import { load, install, teardown, curate, mock, author, address, response, replyArgs, renderComponent } from './host-harness.mjs'
const { host } = await load('lib/host.svelte.ts')
const { adoptPolicy, declareBot, declarationMessage } = await load('lib/host-policy.ts')
const { parse, href } = await load('features/navigation/router.svelte.ts')
beforeEach(() => { install(); curate([]) })
after(teardown)

test('an account’s own statement shows over the admin label, and only listed accounts get a robot', async () => {
  const labelled = address('52'), plain = address('53')
  adoptPolicy({ ...mock.hostPolicy, bots: [author, labelled], declared_bots: [author], declarations: '1' })
  assert.equal(host.bot(author), 'declared')
  assert.equal(host.bot(labelled), 'labelled')
  assert.equal(host.bot(plain), null)
  const mark = (who) => renderComponent('components/BotMark.svelte', { address: who })
  assert.match(await mark(author), /aria-label="bot · declared by this account"/)
  const muted = await mark(labelled)
  assert.match(muted, /aria-label="bot · labelled by this host"/)
  assert.match(muted, /class="bot-mark[^"]*\blabelled\b/)
  assert.doesNotMatch(await mark(plain), /bot-mark/)
})

test('late answers cannot undo newer lists or declarations, each ordered by its own counter', () => {
  const labelled = address('51')
  adoptPolicy({ ...mock.hostPolicy, revision: '3', bots: [labelled], declarations: '7', declared_bots: [author] })
  // Newer admin lists arrive with an older declarations snapshot.
  adoptPolicy({ ...mock.hostPolicy, revision: '4', bots: [], declarations: '6', declared_bots: [] })
  assert.equal(host.bot(labelled), null, 'the admin lists follow their revision')
  assert.equal(host.bot(author), 'declared', 'an older declarations answer cannot undo a newer one')
  // Newer declarations arrive with older admin lists.
  adoptPolicy({ ...mock.hostPolicy, revision: '2', bots: [labelled], declarations: '8', declared_bots: [] })
  assert.equal(host.bot(labelled), null)
  assert.equal(host.bot(author), null)
  assert.equal(host.status.host_policy.revision, '4')
  assert.equal(host.status.host_policy.declarations, '8')
})

test('declaring signs the exact statement on the admin chain and shows the answer, with no transaction', async () => {
  const { wallet } = replyArgs(), signed = [], bodies = []
  let chain = null, rpcNeed = null
  wallet.ensureChain = async (c, need) => { chain = c.id; rpcNeed = need }
  wallet.provider.request = async (args) => {
    if (args.method === 'eth_accounts') return [author]
    if (args.method === 'personal_sign') { signed.push(args); return '0x1234' }
    assert.fail(`unexpected wallet call ${args.method}`)
  }
  const fetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/bot-declaration') {
      bodies.push(JSON.parse(init.body))
      return response({ ...mock.hostPolicy, declared_bots: [author], declarations: '1' })
    }
    return fetch(url, init)
  }
  try {
    const before = Math.floor(Date.now() / 1000)
    await declareBot(wallet, true)
    assert.equal(rpcNeed, 'optional', 'a signature needs no wallet RPC')
    assert.equal(bodies.length, 1)
    const body = bodies[0]
    assert.equal(body.account.toLowerCase(), author.toLowerCase())
    assert.equal(body.bot, true)
    assert.equal(body.signature, '0x1234')
    assert.ok(body.issued >= before && body.issued <= before + 5)
    assert.equal(hexToString(signed[0].params[0]), declarationMessage('https://client.invalid', author, true, body.issued))
    assert.equal(hexToString(signed[0].params[0]).split('\n')[0], 'Bot declaration')
    assert.equal(chain, mock.hostPolicy.admin_chain, 'contract accounts are checked on the admin chain')
    assert.equal(host.bot(author), 'declared')
  } finally { globalThis.fetch = fetch }
})

test('the account-list page has one tab per list, in its URL', () => {
  assert.deepEqual(parse('#/list'), { kind: 'list', tab: 'curated' })
  assert.deepEqual(parse('#/list/bots'), { kind: 'list', tab: 'bots' })
  assert.deepEqual(parse('#/list/blocked'), { kind: 'list', tab: 'blocked' })
  assert.deepEqual(parse('#/list/takedowns'), { kind: 'list', tab: 'takedowns' })
  for (const other of ['#/list/curated', '#/list/bots/more', '#/list/members']) assert.equal(parse(other).kind, 'unknown', other)
  assert.equal(href.list(), '#/list')
  assert.equal(href.list('bots'), '#/list/bots')
})

test('two statements within one second still count up, so the host keeps the second', async () => {
  const { wallet } = replyArgs(), issued = []
  wallet.provider.request = async (args) => args.method === 'eth_accounts' ? [author] : '0x1234'
  const fetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/bot-declaration') { issued.push(JSON.parse(init.body).issued); return response({ ...mock.hostPolicy, declarations: String(issued.length) }) }
    return fetch(url, init)
  }
  const now = Date.now
  Date.now = () => 1_800_000_000_000
  try {
    await declareBot(wallet, true)
    await declareBot(wallet, false)
  } finally { Date.now = now; globalThis.fetch = fetch }
  assert.deepEqual(issued, [1_800_000_000, 1_800_000_001])
})

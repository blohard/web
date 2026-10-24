// The real app talks only to this fixture. Reuse the reader tests' API answers,
// with actual envelope bytes and commitments so cards validate them normally.
import { expect, test as base } from '@playwright/test'
import { encodeAbiParameters, keccak256, stringToBytes, zeroAddress } from 'viem'
import { answerIndex } from '../../scripts/index-fixture.mjs'
import { address, hash, response } from '../../scripts/fixture-values.mjs'
export { deferred } from '../../scripts/fixture-values.mjs'
export { expect }
export const author = address('22')
export const stranger = address('33')

export const test = base.extend({
  host: async ({ page }, use) => {
    const chain = { id: 84532, name: 'Base Sepolia', contract: address('11'), public_rpc_url: null,
      start_block: 0, confirmations: 5, curated: false, blocklist: null, blocking: null, key_gates: null }
    const state = { chain, policy: null, takedowns: { revision: '0', hashes: [] }, rows: new Map(), events: [],
      at: { generation: hash('aa'), sequence: '0', checkpoint: { block: '0', hash: hash('bb') } } }
    const bodies = new Map(), errors = []
    function post(id, text, { who = author, parent = 0 } = {}) {
      const bytes = Buffer.from(`version/1 text/plain\n${text}`)
      const contentHash = keccak256(bytes), timestamp = 1_800_000_000 + id
      const row = { id: String(id), author: who, parent: String(parent),
        parent_author: parent ? state.rows.get(BigInt(parent)).author : zeroAddress,
        content_hash: contentHash, timestamp, transaction: hash('44'), position: { block: String(id), log: 0 },
        gate: zeroAddress, author_gate: zeroAddress, effective_gate: zeroAddress, replies: '0',
        commitment: keccak256(encodeAbiParameters(
          [{ type: 'address' }, { type: 'uint64' }, { type: 'uint32' }, { type: 'bytes32' }],
          [who, BigInt(parent), timestamp, contentHash])) }
      state.rows.set(BigInt(id), row)
      bodies.set(contentHash, bytes)
      if (parent) {
        const p = state.rows.get(BigInt(parent))
        p.replies = String(Number(p.replies) + 1)
      }
      state.at.sequence = String(Number(state.at.sequence) + 1)
      state.at.checkpoint.block = String(id)
      state.events.push({ sequence: state.at.sequence, event: { kind: 'chain', event: { kind: 'posted', message: row } } })
      return row
    }
    async function answer(request) {
      const url = new URL(request.url())
      switch (url.pathname) {
        case '/api/host-policy': return response(state.policy)
        // This fixture trusts every signature; the integration test checks them against the real host.
        case '/api/host-policy/takedowns/read': return response(state.takedowns)
        case '/api/host-policy/takedowns': {
          const edit = JSON.parse(request.postData())
          if (edit.revision !== state.takedowns.revision) return response({ error: 'takedowns_changed', code: 'takedowns_changed' }, 409)
          const hashes = new Set(state.takedowns.hashes)
          for (const h of edit.hashes) edit.action === 'add' ? hashes.add(h) : hashes.delete(h)
          state.takedowns = { revision: String(Number(state.takedowns.revision) + 1), hashes: [...hashes].sort() }
          return response(state.takedowns)
        }
        case '/api/status': return response({ verifier: 'chains', chains: [chain], host_policy: state.policy,
          store: { max_content_size: 4096, envelope: { version: 1 }, attachments: null },
          gateway: { names: true, link_previews: false }, keyrings: [] })
        case '/api/relay/status': return response({ error: 'not configured' }, 404)
      }
      if (url.pathname.startsWith('/api/names/')) return response({
        name: url.pathname.endsWith(author) ? 'alice.eth' : 'bob.eth', source: 'ens', avatar: null })
      if (url.pathname.startsWith('/api/content/')) {
        const key = url.pathname.slice('/api/content/'.length)
        if (state.takedowns.hashes.includes(key)) return response({ error: 'this host has taken this content down', code: 'taken_down' }, 410)
        const bytes = bodies.get(key)
        if (!bytes) throw new Error(`unknown body: ${url}`)
        return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })
      }
      return answerIndex(state, url, { body: request.postData() })
    }
    // Unexpected APIs and third-party traffic fail the test instead of reaching
    // a real host, RPC, name service or wallet.
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === 'http://127.0.0.1:8790' && !url.pathname.startsWith('/api/')) return route.continue()
      try {
        if (url.origin !== 'http://127.0.0.1:8790') throw new Error(`external request: ${url}`)
        await fulfill(route, await answer(request))
      } catch (error) {
        errors.push(String(error))
        await route.abort()
      }
    })
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(who => {
      localStorage.setItem('blohard.home.tab', JSON.stringify('following'))
      localStorage.setItem('blohard.following', JSON.stringify([who]))
    }, author)
    /** Store any record, such as a picture a post references, and name its hash. */
    function record(bytes) {
      const contentHash = keccak256(bytes)
      bodies.set(contentHash, bytes)
      return contentHash
    }
    await use({ post, record, answer, chain, at: state.at, takedowns: () => state.takedowns,
      block(owner, member, present = true) {
        chain.blocklist ??= { registry: address('66'), list: 'blocked' }
        const list = { registry: chain.blocklist.registry, owner, list: keccak256(stringToBytes(chain.blocklist.list)) }
        state.at.sequence = String(BigInt(state.at.sequence) + 1n)
        state.events.push({ sequence: state.at.sequence, event: { kind: 'chain', event: {
          kind: 'membership', list, member, present, position: { block: state.at.checkpoint.block, log: 1 },
        } } })
      },
      policy(curated, blocked = [], { bots = [], declared = [] } = {}) {
        chain.curated = true
        state.policy = { admin: author, admin_chain: chain.id, origin: 'http://127.0.0.1:8790', revision: String(Number(state.policy?.revision ?? 0) + 1), curated, blocked, bots, declared_bots: declared, declarations: String(Number(state.policy?.declarations ?? 0) + 1) }
      },
    })
    expect(errors, 'no unexpected requests or uncaught app errors').toEqual([])
  },
})

export async function fulfill(route, answer) {
  await route.fulfill({ status: answer.status, headers: Object.fromEntries(answer.headers), body: Buffer.from(await answer.arrayBuffer()) })
}
export const card = (page, id) => page.locator('article.msg').filter({ has: page.getByRole('link', { name: `open post #${id}`, exact: true }) })

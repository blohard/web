import { readFile, readdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { parseEther } from 'viem'
import { Reader } from './reader.mjs'
import { accounts, asVisitor, auditPages, boardAbi, clients, content, DELETED, eligible, ended, imageRecord, locate, Nonces,
  prepare, REMOVED, same, settle } from './protocol.mjs'
import { Failure, jitter, limited, pick, problem, random, save, sleep } from './support.mjs'

export const hydrate = (p) => ({ ...p, id: BigInt(p.id), parentId: BigInt(p.parentId), blockNumber: BigInt(p.blockNumber) })

export async function preflight(config, http, recorder, deployment) {
  const keys = await accounts(config), users = []
  for (let i = 0; i < keys.length; i++) {
    const info = deployment.chains[i % deployment.chains.length]
    users.push({ index: i, api: clients(http, info, keys[i]), rng: random(config.seed + i + 1), nonces: new Nonces(),
      sponsored: 0, sequence: 0, paused: false })
  }
  const missing = []
  await limited(users, 8, async (u) => {
    const { api } = u
    if (await api.writeRead.getBalance({ address: api.account.address }) < parseEther('0.01')) missing.push({ user: u.index, chain: api.info.id, reason: 'balance below 0.01 ETH' })
    if (config.sponsored > 0 && !await eligible(api)) missing.push({ user: u.index, chain: api.info.id, reason: 'not a sponsor-list member' })
  })
  await save(`${recorder.dir}/accounts.json`, users.map((u) => ({ index: config.offset + u.index, chain: u.api.info.id, address: u.api.account.address })))
  await save(`${recorder.dir}/preflight.json`, { ready: missing.length === 0, accountChecks: users.length, missing })
  if (missing.length) throw new Error(`${missing.length} account checks failed; see preflight.json and accounts.json (funding does not imply sponsor membership)`)
  for (const u of users) {
    const peers = users.filter((v) => v !== u && v.api.info.id === u.api.info.id)
    const follows = Array.from({ length: Math.min(10, peers.length) }, (_, i) => peers[(u.index + i) % peers.length].api.account.address)
    const muted = peers.length > 20 ? [peers.at(-1).api.account.address] : []
    u.reader = new Reader(u.api, http, recorder, config, { follows, muted })
  }
  return users
}

export function selectParent(pool, user, config, tips, { forceDeep = false } = {}) {
  const candidates = pool.filter((p) => p.chain === user.api.info.id && !p.ending && p.depth < config.maxDepth && !same(p.author, user.api.account.address))
  if (!candidates.length) return null
  if (forceDeep || user.rng() < 0.25) {
    const available = candidates.filter((p) => tips.has(`${p.chain}:${p.id}`) && !p.extending)
    if (available.length) return pick(available, user.rng)
  }
  const hot = candidates.filter((p) => p.parentId === 0n).slice(0, 5)
  return pick(user.rng() < 0.5 && hot.length ? hot : candidates, user.rng)
}

export class Workload {
  constructor(config, http, recorder, deployment, users, pool = []) {
    Object.assign(this, { config, http, recorder, deployment, users, pool })
    this.runId = `load-${Date.now()}-${randomBytes(6).toString('hex')}`; this.posts = 0; this.sponsored = 0; this.failures = 0
    this.tips = new Set(pool.filter((p) => p.tip).map((p) => `${p.chain}:${p.id}`))
    this.abort = new AbortController(); this.integrityFailure = false
  }
  async publish(user, { parent, sponsored = false, deep = false } = {}) {
    if (this.posts >= this.config.maxPosts) { await this.recorder.event({ type: 'skipped', reason: 'post_budget' }); return null }
    if (user.paused) { await this.recorder.event({ type: 'skipped', reason: 'unresolved_previous_send', user: user.index }); return null }
    if (sponsored && (this.sponsored >= this.config.maxSponsored || user.sponsored >= this.config.sponsoredPerAuthor)) {
      await this.recorder.event({ type: 'skipped', reason: 'sponsor_budget', user: user.index }); return null
    }
    this.posts++
    if (sponsored) { this.sponsored++; user.sponsored++ } // Never refund uncertain sends or silently switch their payment mode.
    const logicalId = `${user.index}-${++user.sequence}-${randomBytes(4).toString('hex')}`
    const path = `${this.recorder.dir}/pending/${logicalId}.json`
    let intent
    if (parent) parent.extending = true
    try {
      return await this.recorder.measure(`publish.${sponsored ? 'sponsored' : 'direct'}`, user.api.info.id, async () => {
        let text = `Load test ${this.runId}\n\nUser ${user.index}, message ${user.sequence}.\n\n${parent ? `Reply to [message ${parent.id}](post://${parent.chain}/${parent.id}?commit=${parent.commitment}).` : 'A new conversation.'}`
        const peers = this.users.filter((v) => v !== user && v.api.info.id === user.api.info.id)
        if (peers.length && user.rng() < 0.15) text += `\n\nHello [reader](account://${pick(peers, user.rng).api.account.address}).`
        const image = user.rng() < this.config.attachments ? imageRecord(Math.floor(this.config.imageBytes * (0.5 + user.rng())), user.rng) : null
        intent = await prepare(user.api, this.http, this.config, { id: logicalId, parent, text, image, sponsored, nonce: sponsored ? user.nonces.allocate() : undefined })
        intent.run = this.runId
        await save(path, intent)
        const event = await settle(user.api, this.http, this.config, this.recorder, intent, path)
        const post = { ...event, chain: user.api.info.id, tip: deep || (parent && this.tips.has(`${parent.chain}:${parent.id}`)) }
        this.pool.push(post)
        if (post.tip) {
          if (parent) { this.tips.delete(`${parent.chain}:${parent.id}`); parent.tip = false }
          this.tips.add(`${post.chain}:${post.id}`)
        }
        await this.recorder.event({ type: 'published', user: user.index, chain: post.chain, id: `${post.id}`, parent: `${post.parentId}`, depth: post.depth, mode: intent.mode })
        return post
      })
    } catch (e) {
      this.failures++
      // A self-paid account cannot allocate another transaction nonce until its previous send is resolved.
      if (!sponsored && intent && ['sending', 'unknown'].includes(intent.state)) user.paused = true
      if (problem(e).kind === 'integrity') { this.integrityFailure = true; this.abort.abort() }
      await this.recorder.event({ type: 'publication_failed', logicalId, user: user.index, ...problem(e), state: intent?.state ?? 'before_send' })
      return null
    } finally { if (parent) parent.extending = false }
  }
  async fixtures() {
    return { version: 1, site: this.config.site, chains: this.deployment.chains.map((c) => ({ id: c.id, contract: c.contract })),
      posts: this.pool.map(({ extending, ...p }) => p) }
  }
  async seed() {
    const total = this.deployment.chains.length * (this.config.roots + this.config.wide + this.config.deepChains * (this.config.depth + 1))
    if (total > this.config.maxPosts) throw new Error(`seed needs ${total} publications; raise --max-posts or reduce the fixture sizes`)
    this.recorder.phase = 'seed'
    for (const chain of this.deployment.chains) {
      const users = this.users.filter((u) => u.api.info.id === chain.id)
      if (users.length < 2 && (this.config.depth || this.config.wide)) throw new Error('seed needs at least two accounts per chain to reply as different authors')
      let next = 0
      const add = async (parent = null, deep = false) => {
        if (this.abort.signal.aborted) throw new Error('seed interrupted; audit its pending files before resuming')
        const available = users.filter((u) => !parent || !same(u.api.account.address, parent.author))
        const author = available[next++ % available.length]
        const post = await asVisitor(this.config, author.index, () => this.publish(author, { parent, deep }))
        if (!post) throw new Error('seed publication failed; inspect pending files before retrying setup')
        await save(`${this.recorder.dir}/fixtures.json`, await this.fixtures())
        return post
      }
      const roots = []
      for (let i = 0; i < this.config.roots; i++) roots.push(await add())
      for (let i = 0; i < this.config.wide; i++) await add(roots[i % Math.min(3, roots.length)])
      for (let i = 0; i < this.config.deepChains; i++) {
        let parent = await add(null, true)
        const chainPosts = [parent]
        for (let d = 0; d < this.config.depth; d++) { parent = await add(parent, true); chainPosts.push(parent) }
        // Only this run's own ancestors are changed, after descendants exist; the tip remains open.
        if (this.config.moderation && chainPosts.length >= 5) {
          for (const [index, gate] of [[1, DELETED], [3, REMOVED]]) {
            if (this.abort.signal.aborted) throw new Error('seed interrupted before moderation')
            const p = chainPosts[index], signer = gate === DELETED ? p.author : chainPosts[index - 1].author
            const u = users.find((u) => same(u.api.account.address, signer))
            const tx = await u.api.wallet.writeContract({ address: chain.contract, abi: boardAbi, functionName: 'setReplyGate', args: [p.id, gate], gas: 100000n,
              maxFeePerGas: BigInt(Math.round(this.config.maxFeeGwei * 1e9)), maxPriorityFeePerGas: 0n })
            const deadline = Date.now() + this.config.settle
            await asVisitor(this.config, u.index, async () => {
              for (;;) {
                const receipt = await u.api.app(`transaction/${tx}`)
                if (receipt.status === 'reverted') throw new Error('fixture moderation reverted')
                if (receipt.status === 'success' && (await u.api.message(p.id)).record.gate === gate) break
                if (Date.now() >= deadline) throw new Error('fixture moderation was not indexed')
                await sleep(200)
              }
            })
            p.ending = gate
          }
        }
      }
      await save(`${this.recorder.dir}/fixtures.json`, await this.fixtures())
    }
  }
  async browse(user, forceHome = false) {
    const reader = user.reader, rng = user.rng, pool = this.pool.filter((p) => p.chain === user.api.info.id)
    const chance = forceHome ? 0 : rng()
    let action, fn
    if (chance < 0.4 || !pool.length) {
      const following = !forceHome && rng() < 0.3
      action = following ? 'read.following' : 'read.feed'
      fn = () => reader.feed({ kind: following ? 'following' : 'timeline' }, rng, !forceHome && rng() < 0.1)
    } else if (chance < 0.75) {
      const deep = pool.filter((p) => p.depth >= 30), p = pick(deep.length && rng() < 0.5 ? deep : pool, rng)
      if (rng() < 0.2) { action = 'read.ancestors'; fn = () => reader.ancestors(p.id, rng) }
      else { action = p.depth >= 30 ? 'read.deep_thread' : 'read.thread'; fn = () => reader.thread(p.id, rng, rng() < 0.5) }
    } else if (chance < 0.9) {
      const author = pick(pool, rng).author; action = 'read.profile'; fn = () => reader.feed({ kind: 'profile', author }, rng)
    } else {
      action = 'read.notifications'; fn = () => reader.notifications(rng)
    }
    return this.recorder.measure(action, user.api.info.id, fn)
  }
  async run() {
    if (!this.pool.length) throw new Error('run needs --fixtures from seed; it will not reply to arbitrary visitors’ posts')
    const stages = [...this.config.ramp, { users: this.config.users, duration: this.config.duration }]
    const start = Date.now(), total = stages.reduce((sum, s) => sum + s.duration, 0), end = start + total
    const activation = (i) => { let t = start; for (const stage of stages) { if (i < stage.users) return t; t += stage.duration } return end }
    let stageIndex = -1
    const resources = monitorEventLoopDelay({ resolution: 20 }); resources.enable()
    let sample = Promise.resolve()
    const timer = setInterval(() => {
      sample = sample.then(async () => {
        const elapsed = Date.now() - start
        let at = 0, current = stages.length - 1
        for (let i = 0; i < stages.length; i++) { at += stages[i].duration; if (elapsed < at) { current = i; break } }
        if (current !== stageIndex) { stageIndex = current; this.recorder.phase = current < this.config.ramp.length ? `ramp_${stages[current].users}` : 'steady' }
        await this.recorder.event({ type: 'resources', memory: process.memoryUsage(), cpu: process.cpuUsage(), eventLoopP99_ms: resources.percentile(99) / 1e6,
          users: stages[current].users, attemptedPosts: this.posts, sponsored: this.sponsored, failures: this.failures })
        resources.reset()
      }).catch(() => this.abort.abort())
    }, 1000)
    this.recorder.phase = this.config.ramp.length ? `ramp_${stages[0].users}` : 'steady'
    const signal = this.abort.signal
    const loops = this.users.map((user) => asVisitor(this.config, user.index, async () => {
      await sleep(activation(user.index) - Date.now(), signal)
      let nextRead = Date.now() + user.rng() * this.config.readEvery, nextPost = Date.now() + user.rng() * this.config.postEvery
      let poll = Promise.resolve(), polling = false
      const pollTimer = setInterval(() => {
        if (polling || signal.aborted || Date.now() >= end) return
        polling = true
        poll = this.recorder.measure('read.poll', user.api.info.id, () => user.reader.poll())
          .catch(() => {}).finally(() => { polling = false })
      }, this.config.pollEvery)
      try {
        while (!signal.aborted && Date.now() < end) {
          const due = Math.min(nextRead, nextPost)
          await sleep(Math.min(due, end) - Date.now(), signal)
          if (signal.aborted || Date.now() >= end) break
          const posting = nextPost <= nextRead
          await this.recorder.event({ type: 'scheduled', user: user.index, action: posting ? 'post' : 'read', lag_ms: Math.max(0, Date.now() - due) })
          try {
            if (posting) {
              const parent = user.rng() < 0.6 ? selectParent(this.pool, user, this.config, this.tips) : null
              await this.publish(user, { parent, sponsored: user.rng() < this.config.sponsored })
              nextPost += jitter(this.config.postEvery, user.rng)
            } else { await this.browse(user); nextRead += jitter(this.config.readEvery, user.rng) }
          } catch (e) {
            this.failures++; await this.recorder.event({ type: 'action_failed', user: user.index, ...problem(e) })
            if (problem(e).kind === 'integrity') { this.integrityFailure = true; this.abort.abort() }
            if (posting) nextPost += this.config.postEvery; else nextRead += this.config.readEvery
          }
          // Report missed scheduling opportunities instead of silently lowering offered load or accumulating an unbounded queue.
          for (const kind of ['read', 'post']) {
            const interval = kind === 'read' ? this.config.readEvery : this.config.postEvery
            let next = kind === 'read' ? nextRead : nextPost
            if (next < Date.now()) {
              const missed = Math.floor((Date.now() - next) / interval) + 1
              await this.recorder.event({ type: 'missed', user: user.index, action: kind, count: missed })
              next += missed * interval
            }
            if (kind === 'read') nextRead = next; else nextPost = next
          }
        }
      } finally { clearInterval(pollTimer); await poll }
    }))
    try { await Promise.all(loops) } finally { clearInterval(timer); resources.disable(); await sample }
    if (this.config.burst !== 'none' && !signal.aborted) {
      this.recorder.phase = `burst_${this.config.burst}`
      await Promise.all(this.users.map((u) => asVisitor(this.config, u.index, async () => {
        try {
          if (this.config.burst === 'read') await this.browse(u, true)
          else await this.publish(u, { parent: selectParent(this.pool, u, this.config, this.tips), sponsored: u.rng() < this.config.sponsored })
        } catch (e) { this.failures++; await this.recorder.event({ type: 'burst_failed', user: u.index, ...problem(e) }) }
      })))
    }
    await save(`${this.recorder.dir}/fixtures.json`, await this.fixtures())
  }
}

export async function loadFixtures(path, deployment, http, site) {
  if (!path) return []
  const data = JSON.parse(await readFile(path, 'utf8'))
  if (data.version !== 1 || data.site !== site || !Array.isArray(data.posts)) throw new Error('fixture origin or format differs')
  for (const c of deployment.chains) if (!same(data.chains.find((p) => p.id === c.id)?.contract, c.contract)) throw new Error('fixture Board differs; seed again after a chain reset')
  const pool = data.posts.filter((p) => deployment.chains.some((c) => c.id === p.chain)).map(hydrate)
  const apis = new Map(deployment.chains.map((c) => [c.id, clients(http, c)]))
  await limited(pool, 8, async (p) => {
    const api = apis.get(p.chain)
    const { record } = await api.message(p.id, 0, p.commitment)
    if (!same(record.author, p.author) || record.parentId !== p.parentId || !same(record.contentHash, p.contentHash)) throw new Error('fixture no longer matches the deployed chain; do not reuse it after a reset')
  })
  return pool
}

export async function audit(config, http, recorder, deployment, dir) {
  const original = JSON.parse(await readFile(`${dir}/run.json`, 'utf8'))
  if (original.config.site !== config.site) throw new Error('audit must use the original run’s site')
  const manifests = []
  for (const name of await readdir(`${dir}/pending`)) if (name.endsWith('.json')) {
    const intent = JSON.parse(await readFile(`${dir}/pending/${name}`, 'utf8'))
    const chain = deployment.chains.find((c) => c.id === intent.chain)
    if (!chain || !same(chain.contract, intent.board)) throw new Error('audit chain or Board differs from the recorded run')
    manifests.push({ intent, path: `${dir}/pending/${name}`, api: clients(http, chain) })
  }
  // A bulk check, not a user: on a local stack each publication is checked from a visitor address of its own.
  const results = await limited(manifests, 8, ({ intent, path, api }, i) => asVisitor(config, i, async () => {
    try {
      let event = await locate(api, intent)
      if (config.recover && !['refused', 'reverted', 'integrity'].includes(intent.state)) event = await settle(api, http, config, recorder, intent, path, { send: !event })
      if (!event) return { logicalId: intent.logicalId, state: intent.state === 'refused' ? 'refused' : 'unresolved', mode: intent.mode }
      for (const r of intent.records) await content(http, r.hash, intent.chain, event.id)
      const { record } = await api.message(event.id, 0, event.commitment)
      if (!same(record.author, intent.author) || record.parentId !== BigInt(intent.parentId) || !same(record.contentHash, intent.contentHash)) throw new Failure('integrity', 0)
      return { logicalId: intent.logicalId, state: 'verified', id: `${event.id}`, chain: intent.chain, depth: intent.depth, mode: intent.mode, gate: record.gate }
    } catch (e) { return { logicalId: intent.logicalId, state: 'failed', ...problem(e), mode: intent.mode } }
  }))
  // Recovery lookup includes deleted posts, unlike feeds. Exhaust it only in
  // this explicit audit, so duplicate detection cannot hide a tombstoned copy.
  let duplicates = 0, scanFailures = 0, replyIndexMismatches = 0
  await limited(manifests, 8, ({ intent, api }, i) => asVisitor(config, i, async () => {
    try {
      const found = await auditPages(api, 'lookup', { author: intent.author, content_hash: intent.contentHash, parent: intent.parentId, from_block: intent.startBlock })
      duplicates += Math.max(0, found.length - 1)
    } catch { scanFailures++ }
  }))
  const verified = new Set(results.filter((r) => r.state === 'verified').map((r) => r.logicalId)), replies = new Map()
  const hidden = new Set(results.filter((r) => ended(r.gate)).map((r) => r.logicalId))
  for (const { intent, api } of manifests) {
    if (BigInt(intent.parentId) === 0n || !verified.has(intent.logicalId)) continue
    const key = `${intent.chain}:${intent.parentId}`
    let group = replies.get(key)
    if (!group) { group = { api, parent: intent.parentId, expected: new Map() }; replies.set(key, group) }
    // Deleted and removed replies must be absent.
    group.expected.set(intent.contentHash.toLowerCase(), hidden.has(intent.logicalId) ? 0 : 1)
  }
  await limited([...replies.values()], 8, (g, i) => asVisitor(config, i, async () => {
    try {
      const found = await auditPages(g.api, 'replies', { parent: g.parent })
      for (const [hash, count] of g.expected) if (found.filter((p) => p.contentHash.toLowerCase() === hash).length !== count) replyIndexMismatches++
    } catch { scanFailures++ }
  }))
  const summary = { total: results.length, verified: verified.size,
    refused: results.filter((r) => r.state === 'refused').length, unresolved: results.filter((r) => r.state === 'unresolved').length,
    failed: results.filter((r) => r.state === 'failed').length, duplicates, replyIndexMismatches, scanFailures, results }
  await save(`${recorder.dir}/audit.json`, summary)
  return summary
}

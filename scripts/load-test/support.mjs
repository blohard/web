// Shared scheduling, bounded output and configuration for the deployed-site test.
import { createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { createHistogram, performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

export const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)
export const sleep = (ms, signal) => new Promise((done) => {
  if (signal?.aborted) return done()
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); done() }
  const timer = setTimeout(finish, Math.max(0, ms))
  signal?.addEventListener('abort', finish, { once: true })
})
export function random(seed) {
  let state = Number(seed) >>> 0
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
}
export const pick = (items, rng) => items[Math.floor(rng() * items.length)]
export const jitter = (ms, rng) => ms * (0.5 + rng())

/** Drain started workers on failure; never leave requests running behind a failed action. */
export async function limited(items, count, fn) {
  let next = 0, failure
  const results = new Array(items.length)
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++
      try { results[index] = await fn(items[index], index) } catch (e) { failure ??= e }
    }
  }))
  if (failure) throw failure
  return results
}

export function duration(value) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value)
  if (!m || Number(m[1]) <= 0) throw new Error(`invalid duration: ${value}; use e.g. 30s or 5m`)
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]
}

export function options(argv) {
  const command = argv[0]
  const strings = ['site', 'chains', 'mnemonic-file', 'out', 'fixtures', 'run-dir', 'users', 'offset', 'duration',
    'ramp', 'read-every', 'post-every', 'poll-every', 'timeout', 'settle', 'sponsored', 'max-posts',
    'max-sponsored', 'sponsored-per-author', 'roots', 'wide', 'deep-chains', 'depth', 'max-depth',
    'attachments', 'image-bytes', 'seed', 'burst', 'body-cache', 'max-fee-gwei']
  const { values: v } = parseArgs({ args: argv.slice(1), options: Object.fromEntries([
    ...strings.map((s) => [s, { type: 'string' }]), ['help', { type: 'boolean' }],
    ['recover', { type: 'boolean' }], ['moderation', { type: 'boolean' }], ['forwarded-ips', { type: 'boolean' }],
  ]) })
  if (v.help || command === '--help' || !command) return { command: 'help' }
  if (!['check', 'seed', 'run', 'audit', 'report'].includes(command)) throw new Error('use check, seed, run, audit or report')
  const num = (key, fallback, min, max, integer = true) => {
    const value = Number(v[key] ?? fallback)
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`invalid --${key}`)
    return value
  }
  const c = {
    command, site: v.site, mnemonicFile: v['mnemonic-file'], fixtures: v.fixtures,
    runDir: v['run-dir'], out: v.out, recover: !!v.recover, moderation: !!v.moderation, forwardedIps: !!v['forwarded-ips'],
    users: num('users', 100, 1, 1000), offset: num('offset', 0, 0, 1000000),
    duration: duration(v.duration ?? '30m'), readEvery: duration(v['read-every'] ?? '15s'),
    postEvery: duration(v['post-every'] ?? '2m'), pollEvery: duration(v['poll-every'] ?? '30s'),
    timeout: duration(v.timeout ?? '25s'), settle: duration(v.settle ?? '2m'),
    sponsored: num('sponsored', command === 'run' ? 0.5 : 0, 0, 1, false),
    maxPosts: num('max-posts', 2500, 0, 1000000), maxSponsored: num('max-sponsored', 1500, 0, 1000000),
    sponsoredPerAuthor: num('sponsored-per-author', 15, 0, 1000000),
    roots: num('roots', 20, 1, 10000), wide: num('wide', 100, 0, 100000),
    deepChains: num('deep-chains', 3, 0, 1000), depth: num('depth', 100, 0, 10000),
    maxDepth: num('max-depth', 300, 1, 10000), attachments: num('attachments', 0.1, 0, 1, false),
    imageBytes: num('image-bytes', 131072, 1024, 1500000), seed: num('seed', 1, 0, 4294967295),
    bodyCache: num('body-cache', 1000, 0, 100000), maxFeeGwei: num('max-fee-gwei', 100, 0.000001, 100000, false),
    burst: v.burst ?? 'none',
  }
  if (!['none', 'read', 'post'].includes(c.burst)) throw new Error('--burst must be none, read or post')
  c.ramp = v.ramp ? v.ramp.split(',').map((part) => {
    const [n, d, extra] = part.split(':')
    if (extra || !/^\d+$/.test(n) || +n < 1 || +n > c.users) throw new Error('invalid --ramp; use 10:5m,25:5m,50:5m')
    return { users: +n, duration: duration(d) }
  }) : []
  if (c.ramp.some((s, i) => i && s.users < c.ramp[i - 1].users)) throw new Error('--ramp must increase')
  if (c.depth > c.maxDepth) throw new Error('--depth must not exceed --max-depth')
  if (command === 'report') {
    if (!c.runDir) throw new Error('report needs --run-dir')
    return c
  }
  if (!c.site || !v.chains) throw new Error('--site and --chains are required; there is no implicit live target')
  const url = new URL(c.site)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('--site must be an HTTP(S) origin without credentials, path or query')
  c.site = url.origin
  c.chainIds = v.chains.split(',').map(Number)
  if (new Set(c.chainIds).size !== c.chainIds.length || c.chainIds.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('invalid --chains')
  if (['seed', 'run'].includes(command) && !c.mnemonicFile) throw new Error(`${command} needs --mnemonic-file`)
  if (command === 'audit' && !c.runDir) throw new Error('audit needs --run-dir')
  if (command !== 'audit' && c.recover) throw new Error('--recover is only for audit')
  if (command === 'seed' && c.sponsored !== 0) throw new Error('seed is self-paid; use --sponsored 0')
  return c
}

export async function secretFile(path) {
  const info = await stat(path)
  if (!info.isFile() || (info.mode & 0o077)) throw new Error('the mnemonic file must be readable only by its owner (chmod 600)')
  return (await readFile(path, 'utf8')).trim()
}

export async function save(path, value) {
  const tmp = `${path}.tmp`
  const file = await open(tmp, 'w', 0o600)
  try { await file.writeFile(json(value) + '\n'); await file.sync() } finally { await file.close() }
  await rename(tmp, path)
}

export class Failure extends Error {
  constructor(kind, code, message = kind) { super(message); this.kind = kind; this.code = code }
}
/** Never emit viem's verbose errors: they can contain signed requests or RPC credentials. */
export const problem = (e) => {
  let cause = e
  for (let i = 0; i < 10 && cause; i++, cause = cause.cause) if (cause instanceof Failure) return { kind: cause.kind, code: cause.code }
  return { kind: 'error', code: e?.name ?? 'Error' }
}

export class Recorder {
  constructor(dir) { this.dir = dir; this.phase = 'setup'; this.groups = new Map(); this.output = null; this.failed = null }
  static async create(path) {
    const dir = resolve(path ?? `load-results/${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(3).toString('hex')}`)
    await mkdir(dirname(dir), { recursive: true, mode: 0o700 })
    await mkdir(dir, { mode: 0o700 }) // Refuse an existing run directory, including its recovery files.
    await mkdir(`${dir}/pending`, { mode: 0o700 })
    const r = new Recorder(dir)
    r.output = createWriteStream(`${dir}/events.jsonl`, { flags: 'wx', mode: 0o600 })
    r.output.on('error', (e) => { r.failed = e })
    await once(r.output, 'open')
    return r
  }
  add(event) {
    if (event.type !== 'measure') return
    const key = json([event.phase, event.name, event.chain ?? '', event.outcome])
    let group = this.groups.get(key)
    if (!group) { group = { phase: event.phase, name: event.name, chain: event.chain, outcome: event.outcome, histogram: createHistogram(), bytes: 0 }; this.groups.set(key, group) }
    group.histogram.record(Math.max(1, Math.round(event.ms * 1000)))
    group.bytes += event.bytes ?? 0
  }
  async event(event) {
    if (this.failed) throw new Error('could not write run output')
    const row = { at: new Date().toISOString(), phase: this.phase, ...event }
    this.add(row)
    if (this.output && !this.output.write(json(row) + '\n')) await once(this.output, 'drain')
  }
  async measure(name, chain, fn, extra = {}) {
    const start = performance.now(), phase = this.phase
    let outcome = 'ok'
    try { return await fn() } catch (e) { outcome = problem(e).kind; throw e } finally {
      await this.event({ type: 'measure', phase, name, chain, ms: performance.now() - start, outcome, ...extra })
    }
  }
  summary() {
    return [...this.groups.values()].map(({ histogram: h, ...g }) => ({ ...g, count: h.count,
      p50_ms: h.percentile(50) / 1000, p95_ms: h.percentile(95) / 1000, p99_ms: h.percentile(99) / 1000,
      max_ms: h.max / 1000, mean_ms: h.mean / 1000 }))
  }
  async close() {
    if (!this.output) return
    this.output.end()
    await once(this.output, 'finish')
    this.output = null
  }
}

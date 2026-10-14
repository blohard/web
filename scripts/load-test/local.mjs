// Local load scenarios for choosing the host's and relayer's concurrency
// numbers: a cold name cache behind a slow name upstream, posting while the
// services' chain reads are delayed, slow uploads holding upload slots, and a
// relayer refusing for low funds while one of its reads is slow. Everything
// runs on a disposable stack (Anvil, host, relayer and proxies on loopback,
// temporary data); nothing reaches a deployed site. Build the Rust binaries
// and the contracts first, then from web/:
//
//   node scripts/load-test/local.mjs [names] [patience] [together] [posting] [uploads] [funds]
//
// Results go to load-results/local-<time>/results.json (ignored by Git).
// Importing this file performs no work.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { withStack } from '../integration/stack.mjs'

const CHAIN = '810337'
// Enough upstream budget that the host's concurrency limits, not its call budget, decide.
const ENOUGH = { calls_per_minute: 120000, reserved_for_ingestion: 6000 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const address = () => `0x${randomBytes(20).toString('hex')}`
const visitor = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]) : null
  return { count: sorted.length, p50_ms: at(0.5), p95_ms: at(0.95), p99_ms: at(0.99), max_ms: sorted.length ? Math.round(sorted.at(-1)) : null }
}

const tally = (items) => items.reduce((t, k) => ({ ...t, [k]: (t[k] ?? 0) + 1 }), {})

/** One load-test CLI command against the stack, keeping its summary; a failed run is data here, not an error. */
async function cli(stack, args, name) {
  const child = stack.start(process.execPath, ['scripts/load-test.mjs', ...args, '--forwarded-ips', '--out', `${stack.dir}/${name}`])
  const code = await new Promise((r, reject) => { child.once('exit', r); child.once('error', reject) })
  const summary = await readFile(`${stack.dir}/${name}/summary.json`, 'utf8').then(JSON.parse).catch(() => null)
  if (!summary) throw new Error(`${name} left no summary (exit ${code}):\n${child.output()}`)
  return { code, summary }
}

/** Counts and latencies by outcome for the named measurements. */
function measured(summary, names) {
  const out = {}
  for (const m of summary.metrics.filter((m) => names.includes(m.name))) {
    const entry = (out[m.name] ??= {})
    entry[m.outcome] = { count: (entry[m.outcome]?.count ?? 0) + m.count, p50_ms: Math.round(m.p50_ms), p95_ms: Math.round(m.p95_ms), max_ms: Math.round(m.max_ms) }
  }
  return out
}

const account = (summary) => summary.audit && { verified: summary.audit.verified, refused: summary.audit.refused, unresolved: summary.audit.unresolved,
  failed: summary.audit.failed, duplicates: summary.audit.duplicates }

async function seed(stack, users) {
  const { summary } = await cli(stack, ['seed', '--site', stack.site, '--chains', CHAIN, '--users', `${users}`, '--offset', '1',
    '--mnemonic-file', `${stack.dir}/mnemonic`, '--timeout', '20s', '--settle', '30s', '--roots', '10', '--wide', '10',
    '--deep-chains', '0', '--depth', '0', '--attachments', '0'], 'seed')
  if (summary.audit?.verified !== 20) throw new Error(`seed verified ${summary.audit?.verified} of 20`)
  return `${stack.dir}/seed/fixtures.json`
}

/**
 * 300 readers open a busy feed whose 20 authors no one asked about before,
 * then open it again once cached. A fifth of the authors have an ENS name and
 * a fifth a Basename, each with an avatar: a found ENS name costs two
 * upstream calls, a Basename four, no name two. Each reader asks as the web
 * client does: two lanes of one request each, and retries 2, 5, 10 and 20
 * seconds after a 429 or 503, after which the client shows no name and keeps
 * that failure for five minutes. `during` runs alongside each cold pass, and
 * `patience` lists the waits before each retry. A busy answer that came at
 * once means 96 distinct addresses were already waiting; one after about
 * three seconds means the lookup waited that long for one of the 24 slots.
 */
const CLIENT_RETRIES = [2000, 5000, 10000, 20000]
async function nameBursts(stack, delays, during = async () => null, patience = CLIENT_RETRIES) {
  const rounds = []
  for (const delay of delays) {
    stack.delayNames(delay)
    // Readers overlap, as the authors of one busy feed do: 6,000 lookups of about 1,400 fresh addresses.
    const pool = Array.from({ length: 1500 }, address)
    const ens = pool.filter((_, i) => i % 5 === 1), base = pool.filter((_, i) => i % 5 === 3)
    stack.nameAddresses({ ens, base })
    const expected = new Map([...ens.map((a, i) => [a, `e${i}.eth`]), ...base.map((a, i) => [a, `b${i}.base.eth`])])
    const picks = Array.from({ length: 300 }, (_, r) => Array.from({ length: 20 }, (_, k) => pool[(r * 37 + k * 101) % pool.length]))
    const ask = async (a, r) => {
      const res = await fetch(`${stack.site}/api/names/${a}`, { headers: { 'x-forwarded-for': visitor(r) }, signal: AbortSignal.timeout(60_000) })
        .catch((e) => ({ status: 0, why: e.cause?.code ?? e.name }))
      const text = res.text ? await res.text().catch(() => '') : ''
      if (res.status !== 200) return { status: res.status, why: res.why ?? text.slice(0, 40) }
      let name = null
      try { name = JSON.parse(text).name ?? null } catch { return { status: res.status, why: 'unreadable' } }
      return { status: 200, name, wrong: name !== (expected.get(a) ?? null) }
    }
    const pass = async (label, alongside) => {
      const calls = stack.nameCalls, begun = performance.now()
      const [lookups, other] = await Promise.all([Promise.all(picks.map(async (addresses, r) => {
        const done = [], queue = [...addresses]
        await Promise.all([0, 1].map(async () => {
          for (let a = queue.shift(); a; a = queue.shift()) {
            const started = performance.now(), busy = []
            const attempt = async () => {
              const at = performance.now(), answer = await ask(a, r)
              if (answer.status === 503) busy.push(performance.now() - at < 1000 ? 'at once' : 'after waiting')
              return answer
            }
            let answer = await attempt()
            for (const wait of patience) {
              if (![429, 503].includes(answer.status)) break
              await sleep(wait)
              answer = await attempt()
            }
            done.push({ ...answer, ms: performance.now() - started, busy })
          }
        }))
        return done
      })).then((all) => all.flat()), alongside()])
      const answered = lookups.filter((l) => l.status === 200)
      return { pass: label, upstream_delay_ms: delay, lookups: lookups.length, distinct: new Set(picks.flat()).size,
        answered: answered.length, named: answered.filter((l) => l.name).length, wrong: answered.filter((l) => l.wrong).length,
        statuses: tally(lookups.map((l) => l.status)), failures: tally(lookups.filter((l) => l.why).map((l) => l.why)),
        busy_answers: tally(lookups.flatMap((l) => l.busy)), patience_ms: patience,
        latency: percentiles(lookups.map((l) => l.ms)), upstream_calls: stack.nameCalls - calls,
        wall_ms: Math.round(performance.now() - begun), ...(other ? { alongside: other } : {}) }
    }
    rounds.push(await pass('cold', during))
    rounds.push(await pass('warm', async () => null))
  }
  return rounds
}

async function names() {
  return withStack((stack) => nameBursts(stack, [50, 200]), { names: true, upstream: ENOUGH })
}

/** A cold burst behind a 200 ms upstream, with the client's earlier single retry after 2 s and then with its retries over 40 seconds. */
async function patience() {
  return withStack(async (stack) => [
    ...await nameBursts(stack, [200], async () => null, [2000]),
    ...await nameBursts(stack, [200]),
  ], { names: true, upstream: ENOUGH })
}

/**
 * Names share the host's client chain-call slots with receipts and upload
 * checks. 30 self-paid users post (half with an image) while every service
 * chain read waits 150 ms: first alone, then during a cold name burst behind
 * a 200 ms name upstream.
 */
async function together() {
  return withStack(async (stack) => {
    const fixtures = await seed(stack, 20)
    stack.delayChain(() => 150)
    const posting = (name) => cli(stack, ['run', '--site', stack.site, '--chains', CHAIN, '--users', '30', '--offset', '1',
      '--mnemonic-file', `${stack.dir}/mnemonic`, '--fixtures', fixtures, '--timeout', '30s', '--settle', '60s',
      '--duration', '40s', '--read-every', '10s', '--post-every', '5s', '--poll-every', '10s', '--sponsored', '0',
      '--max-posts', '600', '--attachments', '0.5', '--image-bytes', '65536'], name)
      .then(({ summary }) => ({ published: summary.published, failures: summary.failures, audit: account(summary),
        ...measured(summary, ['publish.direct', 'upload', 'read.feed']) }))
    const alone = await posting('together-alone')
    const [burst] = await nameBursts(stack, [200], () => posting('together-burst'))
    return { posting_alone: alone, names_with_posting: burst }
  }, { names: true, chainDelay: true, sponsors: 4, upstream: ENOUGH })
}

/** 50 users post (70% sponsored) and read while every service chain read waits 0 ms, then 150 ms. */
async function posting() {
  return withStack(async (stack) => {
    const fixtures = await seed(stack, 20)
    const runs = []
    for (const delay of [0, 150]) {
      stack.delayChain(() => delay)
      const { summary } = await cli(stack, ['run', '--site', stack.site, '--chains', CHAIN, '--users', '50', '--offset', '1',
        '--mnemonic-file', `${stack.dir}/mnemonic`, '--fixtures', fixtures, '--timeout', '30s', '--settle', '60s',
        '--duration', '60s', '--read-every', '5s', '--post-every', '10s', '--poll-every', '5s', '--sponsored', '0.7',
        '--max-posts', '600', '--max-sponsored', '400', '--sponsored-per-author', '15', '--attachments', '0.2', '--image-bytes', '65536'], `posting-${delay}`)
      runs.push({ chain_delay_ms: delay, published: summary.published, failures: summary.failures, skipped: summary.skipped, audit: account(summary),
        ...measured(summary, ['publish.sponsored', 'publish.direct', 'relay.post', 'upload', 'read.feed', 'read.poll']) })
    }
    return runs
  }, { chainDelay: true, sponsors: 60, upstream: ENOUGH })
}

/**
 * `count` slow clients, each trickling 1 MiB at 32 KiB/s to `site`, one
 * attempt at a time: an attempt ends with its answer, a failure or the
 * signal, and then stops sending.
 */
export function slowUploads(site, count, signal, bytes = 1 << 20) {
  const url = new URL(`${site}/api/publish?chain_id=${CHAIN}&message_id=1`)
  const one = (i) => new Promise((resolve) => {
    let tick, done = false, sent = 0
    // A stop can come at any point, including once the body is sent and the answer is awaited.
    const stopped = () => finish(0)
    const finish = (status) => {
      if (done) return
      done = true
      clearInterval(tick)
      signal.removeEventListener('abort', stopped)
      req.destroy()
      resolve(status)
    }
    const req = request({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': `${bytes}`, 'x-forwarded-for': visitor(50_000 + i) } },
    (res) => { res.resume(); res.on('end', () => finish(res.statusCode)); res.on('error', () => finish(res.statusCode)) })
    req.on('error', () => finish(0))
    if (signal.aborted) return finish(0)
    signal.addEventListener('abort', stopped)
    tick = setInterval(() => {
      const chunk = Buffer.alloc(Math.min(4096, bytes - sent), 7)
      sent += chunk.length
      req.write(chunk)
      if (sent >= bytes) { clearInterval(tick); req.end() }
    }, 125)
  })
  const statuses = []
  const loops = Array.from({ length: count }, async (_, i) => {
    while (!signal.aborted) {
      const status = await one(i)
      statuses.push(status)
      // Turned away before sending: try again a second later, as a client would.
      if (status === 429 || status === 503) await sleep(1000)
    }
  })
  return { done: Promise.all(loops), statuses }
}

/**
 * 20 self-paid users post every 5 s while 0, 8 and then 16 slow clients
 * trickle 1 MiB each: first text posts, whose bodies take the host's small
 * upload slots, then posts each with an image, which share the large slots
 * with the slow clients.
 */
async function uploads() {
  return withStack(async (stack) => {
    const fixtures = await seed(stack, 20)
    const runs = []
    for (const images of [false, true]) {
      for (const slow of [0, 8, 16]) {
        const stop = new AbortController(), holders = slowUploads(stack.site, slow, stop.signal)
        let summary
        try {
          await sleep(slow ? 2000 : 0)
          ;({ summary } = await cli(stack, ['run', '--site', stack.site, '--chains', CHAIN, '--users', '20', '--offset', '1',
            '--mnemonic-file', `${stack.dir}/mnemonic`, '--fixtures', fixtures, '--timeout', '30s', '--settle', '60s',
            '--duration', '60s', '--read-every', '30s', '--post-every', '5s', '--poll-every', '30s', '--sponsored', '0',
            '--max-posts', '600', '--attachments', images ? '1' : '0', '--image-bytes', '65536'], `uploads-${images ? 'images' : 'text'}-${slow}`))
        } finally { stop.abort(); await holders.done }
        runs.push({ posts: images ? 'with an image' : 'text', slow_clients: slow, slow_statuses: tally(holders.statuses),
          published: summary.published, failures: summary.failures, audit: account(summary), ...measured(summary, ['publish.direct', 'upload']) })
      }
    }
    return runs
  }, { sponsors: 4, upstream: ENOUGH })
}

/** The relayer refuses every send for low funds while its pending-count read takes 3 s: 8 sponsored posts at once. */
async function funds() {
  return withStack(async (stack) => {
    const fixtures = await seed(stack, 8)
    const runs = []
    for (const slow of [false, true]) {
      stack.delayChain((call) => slow && call.method === 'eth_getTransactionCount' && call.params?.[1] === 'pending' ? 3000 : 0)
      const { summary } = await cli(stack, ['run', '--site', stack.site, '--chains', CHAIN, '--users', '8', '--offset', '1',
        '--mnemonic-file', `${stack.dir}/mnemonic`, '--fixtures', fixtures, '--timeout', '90s', '--settle', '10s',
        '--duration', '1s', '--read-every', '1h', '--post-every', '1h', '--poll-every', '1h', '--sponsored', '1',
        '--max-posts', '8', '--max-sponsored', '8', '--sponsored-per-author', '2', '--attachments', '0', '--burst', 'post'], `funds-${slow ? 'slow' : 'quick'}`)
      runs.push({ slow_pending_read: slow, ...measured(summary, ['relay.post', 'publish.sponsored']) })
    }
    return runs
  }, { sponsors: 8, chainDelay: true, relayPolicy: { min_balance_eth: '1000000.0' } })
}

export async function main(argv) {
  const all = { names, patience, together, posting, uploads, funds }
  const chosen = argv.length ? argv : Object.keys(all)
  for (const name of chosen) if (!all[name]) throw new Error(`unknown scenario ${name}; use ${Object.keys(all).join(', ')}`)
  const out = `load-results/local-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await mkdir(out, { recursive: true })
  const results = { started: new Date().toISOString() }
  for (const name of chosen) {
    console.log(`scenario ${name}…`)
    results[name] = await all[name]()
    await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results[name], null, 2))
  }
  console.log(`results: ${out}/results.json`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv.slice(2))

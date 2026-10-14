#!/usr/bin/env node
// Run from web/: npm run load-test -- --help. Importing this file performs no work.
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Http, discover } from './load-test/protocol.mjs'
import { audit, loadFixtures, preflight, Workload } from './load-test/workload.mjs'
import { json, options, problem, Recorder, save } from './load-test/support.mjs'

const HELP = `blohard deployed-site load test (Node 24+)

  npm run load-test -- check --site https://SITE --chains ID[,ID] [--mnemonic-file FILE]
  npm run load-test -- seed  --site https://SITE --chains ID --mnemonic-file FILE --out DIR
  npm run load-test -- run   --site https://SITE --chains ID --mnemonic-file FILE --fixtures DIR/fixtures.json
  npm run load-test -- audit --site https://SITE --chains ID --run-dir DIR [--recover]
  npm run load-test -- report --run-dir DIR

check is read-only. seed and run publish real, visible posts and spend test-account gas.
audit is read-only unless --recover is supplied; recovery reuses the saved signature/transaction.
No command resets chains, funds accounts, changes sponsor membership or clears server caches.

Common: --users 100 --offset 0 --seed 1 --out NEW_DIRECTORY
        --forwarded-ips (local stacks only: one visitor address per simulated user)
        --timeout 25s --settle 2m --max-fee-gwei 100
Run:    --duration 30m --ramp 10:5m,25:5m,50:5m --read-every 15s --post-every 2m
        --poll-every 30s --sponsored 0.5 --max-posts 2500 --max-sponsored 1500
        --sponsored-per-author 15 --max-depth 300 --burst none|read|post
        --attachments 0.1 --image-bytes 131072 --body-cache 1000
Seed:   --roots 20 --wide 100 --deep-chains 3 --depth 100 --moderation
        --max-posts 2500 --attachments 0.1 --image-bytes 131072

Time units: ms, s, m, h. The ramp runs BEFORE --duration. Sponsored fraction is 0 for
check/seed/audit and 0.5 for run; --sponsored 0 uses only the funded accounts.
The first N addresses use m/44'/60'/0'/0/index, starting at --offset. The mnemonic
must be in an owner-only file on the generator machine. Output directories are private.
Each pending file holds replayable recovery material: keep it private too.
See scripts/load-test/README.md for workload fidelity, quota preparation and interpretation.
`

export async function report(dir) {
  const recorder = new Recorder(dir)
  let missed = 0, failures = 0, scheduled = 0, published = 0, maxDepth = 0, missingContent = 0, skipped = {}, resources = []
  const stream = createReadStream(`${dir}/events.jsonl`)
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let invalidLines = 0
  for await (const line of lines) {
    let e
    try { e = JSON.parse(line) } catch { invalidLines++; continue }
    recorder.add(e)
    if (e.type === 'missed') missed += e.count
    if (e.type === 'scheduled') scheduled++
    if (e.type === 'content_missing') missingContent++
    if (['action_failed', 'publication_failed', 'burst_failed', 'count_failure'].includes(e.type)) failures++
    if (e.type === 'published') { published++; maxDepth = Math.max(maxDepth, e.depth) }
    if (e.type === 'skipped') skipped[e.reason] = (skipped[e.reason] ?? 0) + 1
    if (e.type === 'resources') resources.push({ at: e.at, users: e.users, rss: e.memory.rss, heap: e.memory.heapUsed,
      eventLoopP99_ms: e.eventLoopP99_ms, cpuUser_us: e.cpu.user, cpuSystem_us: e.cpu.system })
  }
  const metrics = recorder.summary()
  let verification = null
  try { verification = JSON.parse(await readFile(`${dir}/audit.json`, 'utf8')); delete verification.results } catch { /* A stopped run may not have reached its audit. */ }
  const summary = { scheduled, missed, failures, skipped, published, maxDepth, missingContent, invalidLines, audit: verification, metrics }
  await save(`${dir}/summary.json`, summary)
  const columns = ['phase', 'name', 'chain', 'outcome', 'count', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'bytes']
  const csv = (rows, columns) => columns.join(',') + '\n' + rows.map((r) => columns.map((c) => JSON.stringify(r[c] ?? '')).join(',')).join('\n') + '\n'
  await writeFile(`${dir}/metrics.csv`, csv(metrics, columns), { mode: 0o600 })
  await writeFile(`${dir}/generator.csv`, csv(resources, ['at', 'users', 'rss', 'heap', 'eventLoopP99_ms', 'cpuUser_us', 'cpuSystem_us']), { mode: 0o600 })
  return summary
}

export async function main(argv) {
  const config = options(argv)
  if (config.command === 'help') { console.log(HELP); return 0 }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer is required')
  if (config.command === 'report') { console.log(json(await report(resolve(config.runDir)))); return 0 }
  const recorder = await Recorder.create(config.out)
  console.log(`Output: ${recorder.dir}`)
  let workload, exitCode = 0, interrupted = false
  const stop = () => { interrupted = true; console.log('Stopping new work; in-flight actions will finish.'); workload?.abort.abort() }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  try {
    const http = new Http(config.site, config.timeout, recorder)
    const deployment = await discover(config, http)
    let revision = 'unknown'
    try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: new URL('..', import.meta.url) }).trim() } catch { /* The runner can also be copied without .git. */ }
    const { mnemonicFile, ...publicConfig } = config
    await save(`${recorder.dir}/run.json`, { version: 1, started: new Date().toISOString(), revision, node: process.version,
      config: publicConfig, deployment, model: 'protocol users; no DOM or wallet extension; see README' })
    if (config.command === 'audit') {
      if (interrupted) throw new Error('interrupted before audit')
      recorder.phase = config.recover ? 'recovery' : 'audit'
      const result = await audit(config, http, recorder, deployment, resolve(config.runDir))
      exitCode = result.failed || result.unresolved || result.duplicates || result.replyIndexMismatches || result.scanFailures ? 1 : 0
    } else {
      const users = await preflight(config, http, recorder, deployment)
      if (interrupted) throw new Error('interrupted before starting the workload')
      console.log(`Site ${config.site}; chains ${deployment.chains.map((c) => c.id).join(', ')}; ${users.length} funded accounts checked.`)
      if (config.command !== 'check') {
        const pool = await loadFixtures(config.fixtures, deployment, http, config.site)
        if (interrupted) throw new Error('interrupted before starting the workload')
        workload = new Workload(config, http, recorder, deployment, users, pool)
        if (config.command === 'seed') await workload.seed(); else await workload.run()
        recorder.phase = 'audit'
        const result = await audit({ ...config, recover: false }, http, recorder, deployment, recorder.dir)
        exitCode = workload.failures || workload.integrityFailure || workload.abort.signal.aborted || result.failed || result.unresolved || result.duplicates || result.replyIndexMismatches || result.scanFailures ? 1 : 0
      } else if (!users.length) console.log('Endpoint checks passed. Account funding and membership were not checked: supply --mnemonic-file for those.')
    }
  } catch (e) {
    exitCode = 1
    await recorder.event({ type: 'fatal', ...problem(e) })
    // Only our own plain errors are printable. Library errors may embed requests or credentials.
    console.error(e.constructor === Error ? e.message : `${problem(e).kind} (${problem(e).code})`)
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    await recorder.close()
    const result = await report(recorder.dir)
    if (result.failures || result.invalidLines) exitCode = 1
    console.log(`Published ${result.published}; deepest reply ${result.maxDepth}; failed actions ${result.failures}; missed schedule ${result.missed}.`)
    if (result.audit) console.log(`Audit: ${result.audit.verified}/${result.audit.total} verified, ${result.audit.unresolved} unresolved, ${result.audit.duplicates} duplicates.`)
    console.log(`Report: ${recorder.dir}/summary.json`)
  }
  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (e) => {
    console.error(e.constructor === Error ? e.message : `${problem(e).kind} (${problem(e).code})`)
    process.exitCode = 1
  })
}

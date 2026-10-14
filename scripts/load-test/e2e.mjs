// Disposable load-test smoke run. Build Rust binaries and contracts first.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { withStack } from '../integration/stack.mjs'
import { verifyQuotes } from './quotes.mjs'

await withStack(async (stack) => {
  const { site, nodeUrl, board, registry, wallet, reader, account, dir, start } = stack
  async function cli(args, name) {
    const child = start(process.execPath, ['scripts/load-test.mjs', ...args, '--out', `${dir}/${name}`])
    const code = await new Promise((r, reject) => { child.once('exit', r); child.once('error', reject) })
    if (code !== 0) {
      const events = (await readFile(`${dir}/${name}/events.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse)
      console.error(events.filter((e) => /failed|failure|fatal/.test(e.type) || (e.type === 'measure' && e.outcome !== 'ok')).slice(0, 40))
      const audit = await readFile(`${dir}/${name}/audit.json`, 'utf8').then(JSON.parse).catch(() => null)
      if (audit) { const { results, ...counts } = audit; console.error('Audit:', counts) }
    }
    assert.equal(code, 0, child.output())
    return JSON.parse(await readFile(`${dir}/${name}/summary.json`, 'utf8'))
  }
  // Posting is sponsored; deletion uses wallet gas.
  {
    const child = start(process.execPath, ['scripts/sponsored-e2e.mjs'], {
      MNEMONIC_FILE: `${dir}/mnemonic`, RPC: nodeUrl, RELAY: site, BOARD: board.address, CHAIN_ID: '810337',
      REGISTRY: registry.address, LIST_OWNER: account.address, LIST: 'load-test', MAX_INDEX: '4',
    })
    const code = await new Promise((r, reject) => { child.once('exit', r); child.once('error', reject) })
    assert.equal(code, 0, child.output())
    console.log(child.output().trim().split('\n').slice(-1)[0])
  }
  // Every simulated user reaches the local host from its own forwarded address, as behind the site's proxy.
  const common = ['--site', site, '--chains', '810337', '--users', '4', '--offset', '1', '--mnemonic-file', `${dir}/mnemonic`,
    '--timeout', '5s', '--settle', '15s', '--attachments', '1', '--image-bytes', '2048', '--forwarded-ips']
  await cli(['check', ...common, '--sponsored', '0.5'], 'check')
  const seed = await cli(['seed', ...common, '--roots', '2', '--wide', '4', '--deep-chains', '1', '--depth', '100', '--moderation'], 'seed')
  assert.equal(seed.audit.verified, 107); assert.equal(seed.maxDepth, 100)
  await verifyQuotes({ site, chain: 810337, board, wallet, reader })
  stack.dropNextRelayAnswer()
  const result = await cli(['run', ...common, '--fixtures', `${dir}/seed/fixtures.json`, '--duration', '5s', '--read-every', '1s',
    '--post-every', '2s', '--poll-every', '1s', '--max-posts', '4', '--sponsored', '1', '--burst', 'read'], 'run')
  assert.ok(stack.dropped, 'proxy removed a real successful relayer response')
  assert.ok(result.audit.verified > 0); assert.equal(result.audit.duplicates, 0)
  await cli(['audit', '--site', site, '--chains', '810337', '--run-dir', `${dir}/run`, '--attachments', '0', '--forwarded-ips'], 'audit')
  await cli(['audit', '--site', site, '--chains', '810337', '--run-dir', `${dir}/run`, '--attachments', '0', '--recover', '--forwarded-ips'], 'recover')
  const hundred = await cli(['run', ...common, '--users', '100', '--sponsored', '0', '--max-posts', '0',
    '--fixtures', `${dir}/seed/fixtures.json`, '--duration', '3s', '--read-every', '1s', '--burst', 'read'], 'hundred')
  assert.equal(hundred.failures, 0)
  assert.ok(hundred.metrics.filter((m) => m.name === 'read.feed' && m.phase === 'burst_read').reduce((sum, m) => sum + m.count, 0) === 100)
  console.log(`Local end-to-end passed: ${seed.audit.verified} fixture publications, depth 100; ${result.audit.verified} sponsored publications; lost-response recovery and 100 concurrent readers verified.`)
})

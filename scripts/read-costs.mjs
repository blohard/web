// Disposable Anvil + real host index + app readers. No public deployment, keys or caches are used.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { createPublicClient, createWalletClient, decodeFunctionData, http, keccak256, stringToHex, zeroAddress } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { artifactPath } from './contract-artifacts.mjs'
import { serviceBinaries } from './services.mjs'

const { values } = parseArgs({ options: { out: { type: 'string' }, latency: { type: 'string', default: '25' } } })
const latency = Number(values.latency)
if (!Number.isFinite(latency) || latency < 0 || latency > 1000) throw new Error('--latency must be 0..1000 milliseconds per HTTP request on each leg')
const web = fileURLToPath(new URL('..', import.meta.url))
const binaries = serviceBinaries({ relay: false })
const dir = await mkdtemp(join(tmpdir(), 'blohard-read-costs-'))
const children = []
let proxy
let interrupted = false
const interrupt = () => { interrupted = true; for (const child of children) child.kill('SIGTERM') }
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
const out = resolve(values.out ?? `load-results/read-costs-${Date.now()}.json`)
function start(command, args) {
  if (interrupted) throw new Error('measurement interrupted')
  const child = spawn(command, args, { cwd: web, env: { ...process.env, RUST_LOG: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (b) => { output = (output + b).slice(-20000) })
  child.stderr.on('data', (b) => { output = (output + b).slice(-20000) })
  child.finished = new Promise((done) => {
    child.once('error', (error) => done({ error }))
    child.once('exit', (code) => done({ code }))
  })
  child.output = () => output
  children.push(child)
  return child
}
async function stop(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await child.finished
  clearTimeout(timer)
}
async function port() {
  const s = createServer()
  await new Promise((ok, fail) => { s.once('error', fail); s.listen(0, '127.0.0.1', ok) })
  const n = s.address().port
  await new Promise((ok) => s.close(ok))
  return n
}
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (interrupted) throw new Error('measurement interrupted')
    try { if (await fn()) return } catch { /* Local service startup. */ }
    await sleep(100)
  }
  throw new Error(`local service did not start\n${children.map((c) => c.output()).join('\n')}`)
}
try {
  const nodePort = await port(), hostPort = await port()
  const nodeUrl = `http://127.0.0.1:${nodePort}`, site = `http://127.0.0.1:${hostPort}`
  start('anvil', ['--host', '127.0.0.1', '--port', `${nodePort}`, '--chain-id', '810339', '--accounts', '20', '--silent'])
  const chain = { id: 810339, name: 'read costs', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [nodeUrl] } } }
  const reader = createPublicClient({ chain, transport: http(nodeUrl, { retryCount: 0 }) })
  await until(async () => (await reader.getChainId()) === chain.id)
  const accounts = Array.from({ length: 20 }, (_, addressIndex) => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex }))
  const wallets = accounts.map((account) => createWalletClient({ account, chain, transport: http(nodeUrl) }))
  const artifact = async (name) => JSON.parse(await readFile(`${web}/${artifactPath(name)}`, 'utf8'))
  async function deploy(name, args = []) {
    const { abi, bytecode } = await artifact(name)
    const hash = await wallets[0].deployContract({ abi, bytecode: bytecode.object, args })
    const receipt = await reader.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${name} deployment failed`)
    return { abi, address: receipt.contractAddress, block: Number(receipt.blockNumber) }
  }
  const board = await deploy('Board')
  // Twenty distinct authors, twenty roots, then a reply with twenty direct
  // replies of its own. Two seconds per post, followed by 4,000 empty blocks.
  let id = 0n
  async function post(author, parent) {
    await reader.request({ method: 'evm_increaseTime', params: [2] })
    const hash = await wallets[author].writeContract({ address: board.address, abi: board.abi, functionName: 'post',
      args: [keccak256(stringToHex(`read-cost fixture ${++id}`)), parent, zeroAddress, '0x'], gas: 500000n })
    if ((await reader.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error(`fixture #${id} reverted`)
    return id
  }
  for (let i = 0; i < 20; i++) await post(i, 0n)
  const thread = await post(0, 1n)
  for (let i = 0; i < 20; i++) await post(i, thread)
  await reader.request({ method: 'anvil_mine', params: ['0xfa0', '0x2'] })
  const head = await reader.getBlockNumber({ cacheTime: 0 })

  // Count at the node boundary. Host log source labels are not suitable:
  // their shared counter can move for an unrelated concurrent request.
  let calls = {}, errors = 0
  proxy = createServer(async (req, res) => {
    try {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/begin') { calls = {}; errors = 0; res.end('{}'); return }
      if (req.url === '/end') { res.end(JSON.stringify({ calls, errors })); return }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString(), parsed = JSON.parse(body)
      for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
        const method = r.method === 'eth_call'
          ? decodeFunctionData({ abi: board.abi, data: r.params[0].data }).functionName
          : r.method
        calls[method] = (calls[method] ?? 0) + 1
      }
      await sleep(latency)
      const response = await fetch(nodeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(20000) })
      const answer = await response.text(), decoded = JSON.parse(answer)
      errors += (Array.isArray(decoded) ? decoded : [decoded]).filter((r) => r.error).length
      res.writeHead(response.status); res.end(answer)
    } catch {
      errors++; res.writeHead(502); res.end('{"error":"measurement proxy failed"}')
    }
  })
  await new Promise((ok, fail) => { proxy.once('error', fail); proxy.listen(0, '127.0.0.1', ok) })
  const counter = `http://127.0.0.1:${proxy.address().port}`
  await writeFile(`${dir}/host.toml`, `[[chains]]
id = ${chain.id}
rpc_url = "${counter}"
public_rpc_url = "${nodeUrl}"
contract = "${board.address}"
start_block = ${board.block}
confirmations = 2
[gateway]
`)
  const samples = []
  for (const view of ['home', 'thread']) {
    // Ingestion precedes serving. Measure it separately, then two cold tabs
    // and their refreshes against the accepted index.
    const ingestionStart = performance.now()
    const host = start(binaries.host, ['--listen', `127.0.0.1:${hostPort}`, '--config', `${dir}/host.toml`, '--data-dir', `${dir}/${view}`])
    await until(async () => (await fetch(`${site}/api/status`)).ok)
    await until(async () => {
      const response = await fetch(`${site}/api/chains/${chain.id}/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (!response.ok) return false
      const answer = await response.json()
      return BigInt(answer.at.checkpoint?.block ?? 0) === head - 2n
    })
    const ingestionMs = Math.round(performance.now() - ingestionStart)
    for (const warmth of ['first-tab', 'second-tab']) {
      const result = `${dir}/${view}-${warmth}.json`, config = `${result}.config`
      await writeFile(config, JSON.stringify({ site, counter, latency, view, host: warmth, thread: String(thread), result }))
      const worker = start(process.execPath, ['scripts/read-costs/reader.mjs', config])
      const timer = setTimeout(() => worker.kill('SIGTERM'), 120000)
      const ended = await worker.finished
      clearTimeout(timer)
      if (ended.error || ended.code !== 0) throw new Error(`measurement reader failed: ${ended.error ?? ended.code}\n${worker.output()}`)
      samples.push(...JSON.parse(await readFile(result, 'utf8')).map((s) => ({ ...s, ingestion_ms: ingestionMs })))
    }
    await stop(host)
  }
  const report = { date: new Date().toISOString(), node: process.version, latency_ms_per_leg: latency,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    uncommitted_changes: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).length > 0,
    fixture: { roots: 20, authors: 20, replies: 21, thread: String(thread), head: String(head), confirmations: 2 },
    scope: 'Actual app readers and visible-card gates against a fully ingested index. No DOM, bodies, names, avatars, sponsor list, quotes or custom gates. Fixed chain. Upstream counts include the background follower. Ingestion timed separately. Debug host binary.', samples }
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.table(samples.map((s) => ({ view: s.view, host: s.host, phase: s.phase, data_ms: s.data_ms, settled_ms: s.settled_ms,
    http: s.http_requests, api: Object.values(s.api).reduce((a, b) => a + b, 0), upstream: Object.values(s.upstream).reduce((a, b) => a + b, 0) })))
  console.log(`Method counts and timings: ${out}`)
} finally {
  for (const child of [...children].reverse()) await stop(child)
  if (proxy) await new Promise((ok) => { proxy.closeAllConnections(); proxy.close(ok) })
  await rm(dir, { recursive: true, force: true })
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}

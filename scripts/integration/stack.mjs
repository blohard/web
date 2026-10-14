// Disposable services shared by the application integration and load-test smoke run.
// Uses only temporary data, local ports and Anvil's public test keys.
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, http, keccak256, namehash,
  parseAbi, stringToHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { artifactPath } from '../contract-artifacts.mjs'
import { serviceBinaries } from '../services.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// What the host's name service asks: ENS through the Universal Resolver, Basenames through Base's L2 resolver.
const nameAbi = parseAbi([
  'function reverseWithGateways(bytes lookupAddress, uint256 coinType, string[] gateways) view returns (string primary, address resolver, address reverseResolver)',
  'function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes result, address resolver)',
  'function name(bytes32 node) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
  'function text(bytes32 node, string key) view returns (string)',
])
export async function waitFor(read, label, timeout = 20_000) {
  const until = performance.now() + timeout
  do {
    if (await read()) return
    await sleep(100)
  } while (performance.now() < until)
  throw new Error(`timed out: ${label}`)
}
async function stop(child, signal = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((done) => {
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 5000)
    child.once('exit', () => { clearTimeout(timer); done() })
    child.kill(signal)
  })
}
/**
 * Options for local load scenarios, all off by default: `sponsors` list
 * members after the owner; `chainDelay` routes the host's and relayer's chain
 * reads through a proxy that `delayChain` slows; `names` gives the host a
 * name upstream on loopback that answers after `delayNames` milliseconds,
 * with the ENS names and Basenames `nameAddresses` gives and "no name" for
 * every other address; `relayPolicy` overrides the relayer's policy;
 * `upstream` sets the host's upstream call budget.
 */
export async function withStack(run, { accountKeys = false, sponsors = 4, chainDelay = false, names = false, relayPolicy = {}, upstream = null } = {}) {
  const binaries = serviceBinaries()
  const web = fileURLToPath(new URL('../..', import.meta.url))
  const dir = await mkdtemp(join(tmpdir(), 'blohard-load-e2e-'))
  const mnemonic = 'test test test test test test test test test test test junk'
  const children = [], failures = []
  let hostProcess
  let proxy, dropRelayAnswer = false, dropped = false
  let chainProxy, delayOf = () => 0, namesServer, namesDelay = 0, nameCalls = 0
  const named = { ens: new Map(), reverse: new Map(), forward: new Map() }
  async function port() {
    const server = createServer()
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const value = server.address().port
    await new Promise((r) => server.close(r))
    return value
  }
  function start(cmd, args, env = {}) {
    const child = spawn(cmd, args, { cwd: web, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (c) => { output = (output + c).slice(-20000) })
    child.stderr.on('data', (c) => { output = (output + c).slice(-20000) })
    child.on('error', (e) => failures.push(e))
    child.output = () => output
    children.push(child)
    return child
  }
  async function ready(url) {
    for (let i = 0; i < 100; i++) {
      if (failures.length) throw failures[0]
      try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok) return } catch { /* Startup. */ }
      await sleep(100)
    }
    throw new Error(`local service failed to start: ${url}`)
  }

  try {
    const anvilPort = await port(), hostPort = await port(), relayPort = await port(), frontPort = await port()
    const nodeUrl = `http://127.0.0.1:${anvilPort}`, site = `http://127.0.0.1:${frontPort}`
    // The services' own chain reads. Wallet traffic still reaches Anvil
    // directly, as a visitor's own wallet RPC would.
    let serviceRpc = nodeUrl
    if (chainDelay) {
      chainProxy = createServer((req, res) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', async () => {
          const body = Buffer.concat(chunks)
          let calls = []
          try { const parsed = JSON.parse(body); calls = Array.isArray(parsed) ? parsed : [parsed] } catch { /* Forwarded as sent. */ }
          const wait = Math.max(0, ...calls.map((c) => delayOf(c) ?? 0))
          if (wait) await sleep(wait)
          const forward = request({ hostname: '127.0.0.1', port: anvilPort, path: req.url, method: req.method, headers: req.headers },
            (reply) => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res) })
          forward.on('error', () => { res.writeHead(502); res.end() })
          forward.end(body)
        })
      })
      const chainPort = await port()
      await new Promise((r) => chainProxy.listen(chainPort, '127.0.0.1', r))
      serviceRpc = `http://127.0.0.1:${chainPort}`
    }
    let namesConfig = ''
    if (names) {
      namesServer = createServer((req, res) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', async () => {
          nameCalls++
          let body = {}
          try { body = JSON.parse(Buffer.concat(chunks)) } catch { /* Answered as an empty call. */ }
          if (namesDelay) await sleep(namesDelay)
          const chainId = req.url === '/base' ? '0x2105' : '0x1'
          const resolver = '0x0000000000000000000000000000000000000e25'
          // The record the call asks for, or nothing: a revert, which the host reads as no name.
          const record = (call) => {
            if (call?.method !== 'eth_call') return undefined
            let asked
            try { asked = decodeFunctionData({ abi: nameAbi, data: call.params[0].data }) } catch { return undefined }
            const [first] = asked.args, reply = (result) => encodeFunctionResult({ abi: nameAbi, functionName: asked.functionName, result })
            const avatar = 'https://avatars.test/avatar.png'
            switch (asked.functionName) {
              case 'reverseWithGateways': { const found = named.ens.get(first.toLowerCase()); return found && reply([found, resolver, resolver]) }
              case 'resolveWithGateways': return reply([encodeAbiParameters([{ type: 'string' }], [avatar]), resolver])
              case 'name': { const found = named.reverse.get(first); return found && reply(found) }
              case 'addr': { const found = named.forward.get(first); return found && reply(found) }
              case 'text': return reply(avatar)
            }
          }
          const answer = (call) => {
            if (call?.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id ?? null, result: chainId }
            const result = record(call)
            return result ? { jsonrpc: '2.0', id: call.id ?? null, result } : { jsonrpc: '2.0', id: call?.id ?? null, error: { code: 3, message: 'execution reverted' } }
          }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)))
        })
      })
      const namesPort = await port()
      await new Promise((r) => namesServer.listen(namesPort, '127.0.0.1', r))
      namesConfig = `[gateway.names]\nethereum_upstream = "http://127.0.0.1:${namesPort}/eth"\nbase_upstream = "http://127.0.0.1:${namesPort}/base"\n`
    }
    const chainId = accountKeys ? 84532 : 810337
    start('anvil', ['--host', '127.0.0.1', '--port', `${anvilPort}`, '--chain-id', String(chainId), '--accounts', '105', '--silent'])
    const chain = { id: chainId, name: 'local test', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [nodeUrl] } } }
    // Anvil mines each transaction at once. At viem's default four-second
    // polling, every receipt wait here, each deploy included, took four seconds.
    const account = mnemonicToAccount(mnemonic), reader = createPublicClient({ chain, cacheTime: 0, pollingInterval: 100, transport: http(nodeUrl, { timeout: 5000 }) })
    const wallet = createWalletClient({ account, chain, transport: http(nodeUrl) })
    for (let i = 0; ; i++) { if (failures.length) throw failures[0]; try { await reader.getBlockNumber(); break } catch (e) { if (i > 10) throw e; await sleep(100) } }
    async function deploy(name, args = [], source = name) {
      const artifact = JSON.parse(await readFile(`${web}/${artifactPath(name, source)}`, 'utf8'))
      const tx = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args })
      return { address: (await reader.waitForTransactionReceipt({ hash: tx })).contractAddress, abi: artifact.abi }
    }
    const board = await deploy('Board'), registry = await deploy('ListRegistry')
    const blockGate = await deploy('AuthorBlocklistGate', [board.address, registry.address, keccak256(stringToHex('blocked'))], 'ListGates')
    const market = accountKeys ? await deploy('AccountKeys', [account.address]) : null
    const marketBlock = market ? await reader.getBlockNumber() : null
    const holders = market ? await deploy('AuthorKeyGate', [board.address, market.address], 'KeyGates') : null
    const combined = market ? await deploy('AuthorKeyBlocklistGate', [board.address, market.address, registry.address, keccak256(stringToHex('blocked'))], 'KeyGates') : null
    const list = keccak256(stringToHex('load-test'))
    const members = Array.from({ length: sponsors }, (_, i) => mnemonicToAccount(mnemonic, { addressIndex: i + 1 }).address)
    const add = await wallet.writeContract({ address: registry.address, abi: registry.abi, functionName: 'add', args: [account.address, list, members] })
    await reader.waitForTransactionReceipt({ hash: add })
    await writeFile(`${dir}/host-policy.json`, JSON.stringify({ revision: 0, curated: members, blocked: [], bots: [] }))
    await writeFile(`${dir}/host-policy.takedowns.json`, JSON.stringify({ revision: 0, hashes: [] }))
    await writeFile(`${dir}/mnemonic`, mnemonic, { mode: 0o600 })
    await writeFile(`${dir}/relay-key`, account.getHdKey().privateKey.reduce((s, b) => s + b.toString(16).padStart(2, '0'), '0x'), { mode: 0o600 })
    await writeFile(`${dir}/host.toml`, `[host_policy]
file = "${dir}/host-policy.json"
admin = "${account.address}"
admin_chain = ${chainId}
origin = "${site}"
${market ? `[[keyrings]]\nchain = ${chainId}\nmarket = "${market.address}"\nstart_block = ${marketBlock}\n` : ''}[[chains]]
id = ${chainId}
rpc_url = "${serviceRpc}"
public_rpc_url = "${site}/rpc/${chainId}"
contract = "${board.address}"
start_block = 0
confirmations = 0
blocking = { gate = "${blockGate.address}", registry = "${registry.address}", list = "blocked" }
${market ? `key_gates = { holders = "${holders.address}", holders_blocklist = "${combined.address}" }` : ''}
[store]
[store.attachments]
max_bytes = 2097152
max_per_message = 4
[gateway]
${namesConfig}${upstream ? `[upstream]\n${Object.entries(upstream).map(([k, v]) => `${k} = ${v}`).join('\n')}\n` : ''}`)
    await writeFile(`${dir}/relay.toml`, `listen = "127.0.0.1:${relayPort}"
key_file = "${dir}/relay-key"
host_policy_file = "${dir}/host-policy.json"
[policy]
${Object.entries({ per_author_per_day: 20, global_per_day: 2000, max_gas_price_gwei: '100.0', min_balance_eth: '0.01', ...relayPolicy })
    .map(([k, v]) => `${k} = ${v}`).join('\n')}
[[chains]]
id = ${chainId}
rpc_url = "${serviceRpc}"
contract = "${board.address}"
`)
    const hostArgs = ['--listen', `127.0.0.1:${hostPort}`, '--config', `${dir}/host.toml`, '--data-dir', `${dir}/data`]
    hostProcess = start(binaries.host, hostArgs)
    start(binaries.relay, ['--config', `${dir}/relay.toml`])
    proxy = createServer((req, res) => {
      const relay = req.url.startsWith('/api/relay'), wallet = req.url === `/rpc/${chainId}`, path = wallet ? '/' : req.url
      const forward = request({ hostname: '127.0.0.1', port: wallet ? anvilPort : relay ? relayPort : hostPort, path, method: req.method, headers: req.headers }, (reply) => {
        if (dropRelayAnswer && !dropped && req.url.endsWith('/post') && reply.statusCode === 200) {
          dropped = true; reply.resume(); reply.on('end', () => { res.writeHead(504, { 'content-type': 'application/json' }); res.end('{"error":"test lost response after broadcast"}') })
        } else { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res) }
      })
      forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      // A client that leaves before its answer takes the upstream request with it, as a real front proxy does.
      res.on('close', () => { if (!res.writableFinished) forward.destroy() })
      req.pipe(forward)
    })
    await new Promise((r) => proxy.listen(frontPort, '127.0.0.1', r))
    await ready(`${site}/api/status`); await ready(`${site}/api/relay/status`)
    await waitFor(async () => (await (await fetch(`${site}/api/status`)).json()).chains.every((c) => c.index?.state === 'ready'), 'indexes ready')
    return await run({ web, dir, site, nodeUrl, chain, board, registry, market, holders, combined, wallet, reader, account, mnemonic, start,
      dropNextRelayAnswer() { dropRelayAnswer = true; dropped = false },
      get dropped() { return dropped },
      /** Milliseconds each service chain call waits, from its JSON-RPC call; needs `chainDelay`. */
      delayChain(delay) { delayOf = delay },
      delayNames(ms) { namesDelay = ms },
      /** Give these addresses an ENS name (`e<i>.eth`) or a Basename (`b<i>.base.eth`), each with an avatar. */
      nameAddresses({ ens = [], base = [] }) {
        ens.forEach((a, i) => named.ens.set(a.toLowerCase(), `e${i}.eth`))
        base.forEach((a, i) => {
          named.reverse.set(namehash(`${a.slice(2).toLowerCase()}.80002105.reverse`), `b${i}.base.eth`)
          named.forward.set(namehash(`b${i}.base.eth`), a)
        })
      },
      get nameCalls() { return nameCalls },
      async restartHost(beforeStart = async () => {}) {
        await stop(hostProcess, 'SIGKILL')
        await beforeStart()
        hostProcess = start(binaries.host, hostArgs)
        await ready(`${site}/api/status`)
        await waitFor(async () => (await (await fetch(`${site}/api/status`)).json()).chains.every((c) => c.index?.state === 'ready'), 'restarted index ready')
      },
    })
  } catch (error) {
    for (const child of children) if (child.exitCode !== 0) console.error(child.output())
    throw error
  } finally {
    if (proxy) { proxy.closeAllConnections(); await new Promise((r) => proxy.close(r)) }
    for (const server of [chainProxy, namesServer]) if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)) }
    await Promise.all(children.map((child) => stop(child)))
    await rm(dir, { recursive: true, force: true })
  }
}

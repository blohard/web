// Compare a staged build with the host before publishing it. No wallet or RPC calls.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAddress, zeroAddress } from 'viem'

const address = value => typeof value === 'string' && isAddress(value, { strict: false }) && value.toLowerCase() !== zeroAddress
export function checkDeployment(build, status) {
  if (!Array.isArray(build?.chains) || build.chains.length === 0 || !Array.isArray(status?.chains)
    || !build.chains.every(id => id === 8453 || id === 84532)
    || new Set(build.chains).size !== build.chains.length) throw Error('invalid deployment metadata or host status')
  const markets = status.keyrings ?? []
  if (build.market === null && build.devFund === null) {
    if (markets.length) throw Error('host enables account keys but the build does not')
    return
  }
  if (!address(build.market) || !address(build.devFund)) throw Error('incomplete account key build configuration')
  if (!markets.length || new Set(markets.map(m => m.chain)).size !== markets.length) throw Error('host must publish its key markets exactly once')
  for (const market of markets) {
    if (!build.chains.includes(market.chain) || !address(market.market)
      || market.market.toLowerCase() !== build.market.toLowerCase()) throw Error('build and host key markets differ')
    const chains = status.chains.filter(c => c.id === market.chain)
    if (chains.length !== 1) throw Error('host must publish the account key chain exactly once')
    const chain = chains[0]
    // Published gates have been verified against this chain's market and Board.
    if (!address(chain.blocking?.gate) || !address(chain.key_gates?.holders)
      || !address(chain.key_gates?.holders_blocklist)) throw Error('host has not published the verified blocklist and key gates')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [origin, directory = 'dist'] = process.argv.slice(2)
    if (!origin) throw Error('usage: npm run check:deployment -- https://site.example [build directory]')
    const build = JSON.parse(await readFile(resolve(directory, 'deployment.json'), 'utf8'))
    const response = await fetch(new URL('/api/status', origin), { signal: AbortSignal.timeout(15_000), cache: 'no-store' })
    if (!response.ok) throw Error(`host status failed (${response.status})`)
    checkDeployment(build, await response.json())
    console.log('build and host account key configuration agree')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

import { createPublicClient, custom, http, type Transport } from 'viem'
import { chainLabel, toViemChain } from '../../lib/chains'
import { sharedRead } from '../../shared/shared-read'
import { unserved, wallet } from '../../lib/wallet.svelte'
import { withTimeout } from '../../shared/with-timeout'
import type { ChainInfo, Eip1193Provider } from '../../lib/types'

const publicClients = new Map<string, ReturnType<typeof makeClient>>()
const walletClients = new WeakMap<Eip1193Provider, Map<string, ReturnType<typeof makeClient>>>()

/** Coalesce simultaneous reads without caching balances, quotes or failures. */
function makeClient(chain: ChainInfo, transport: Transport) {
  return createPublicClient({ chain: toViemChain(chain), transport: options => {
    const upstream = transport(options)
    const pending = new Map<string, Promise<unknown>>()
    const request: typeof upstream.request = ((args: Parameters<typeof upstream.request>[0], options?: Parameters<typeof upstream.request>[1]) =>
      sharedRead(pending, JSON.stringify(args), () => upstream.request(args, options))) as typeof upstream.request
    return { ...upstream, request }
  } })
}

// Only these read methods may leave the wallet transport. Signing never does.
const FALLBACK_READS = new Set(['eth_blockNumber', 'eth_call', 'eth_getCode', 'eth_getTransactionReceipt', 'eth_getBalance'])

/** Transaction checks keep the existing unsupported-method fallback only. */
export function keyRpc(chain: ChainInfo, publicUrl: string, provider?: Eip1193Provider) {
  provider ??= wallet.account && wallet.chainId === chain.id ? wallet.provider : undefined
  return walletClient(chain, publicUrl, provider, false)
}

/** Display reads may retry a failed wallet read once on the configured public RPC. */
export function keyReadRpc(chain: ChainInfo, publicUrl: string) {
  const provider = wallet.account && wallet.chainId === chain.id ? wallet.provider : undefined
  return walletClient(chain, publicUrl, provider, true)
}

/** A provider's generic internal error is not evidence that the contract reverted. */
function canFallbackRead(error: unknown): boolean {
  const pending = [error]
  for (let i = 0; pending.length && i < 16; i++) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    const e = value as { code?: number; message?: string; data?: unknown; errorName?: string; cause?: unknown; originalError?: unknown }
    if ([4001, 4900, 4901, 4902, -32002, 3].includes(e.code ?? 0) || e.errorName ||
      /execution reverted/i.test(e.message ?? '') ||
      (typeof e.data === 'string' && /^0x[0-9a-f]+$/i.test(e.data))) return false
    pending.push(...[e.cause, e.originalError, e.data].filter(value => value && typeof value === 'object'))
  }
  return pending.length === 0
}

function walletClient(chain: ChainInfo, publicUrl: string, provider: Eip1193Provider | undefined, display: boolean) {
  if (!provider) return publicClient(chain, publicUrl)
  const selected = provider, account = display ? wallet.account : null
  let clients = walletClients.get(selected)
  if (!clients) { clients = new Map(); walletClients.set(selected, clients) }
  const key = JSON.stringify([chain.id, publicUrl, display, account])
  let client = clients.get(key)
  if (!client) {
    const guard = () => {
      if (display && (wallet.provider !== selected || wallet.account !== account || wallet.chainId !== chain.id)) {
        throw new Error('the wallet account or network changed. refresh this page')
      }
    }
    const checkNetwork = async () => {
      guard()
      const id = await selected.request({ method: 'eth_chainId' })
      guard()
      if (Number(id) !== chain.id) throw new Error(`the wallet changed networks. switch to ${chainLabel(chain)} and try again`)
      return id
    }
    const timeout = () => new Error('the wallet RPC timed out')
    client = makeClient(chain, custom({ request: async args => {
      const started = Date.now()
      let expired = false, verified = false
      try {
        return await withTimeout((async () => {
          const id = await checkNetwork()
          if (expired) throw timeout()
          verified = true
          if (args.method === 'eth_chainId') return id
          const result = await selected.request(args)
          guard()
          return result
        })(), 10_000, () => { expired = true; return timeout() })
      } catch (error) {
        guard()
        const code = (error as { code?: number } | null)?.code
        if (!verified || !FALLBACK_READS.has(args.method) ||
          (display ? !canFallbackRead(error) : expired || !unserved(code))) throw error
        // Recheck before changing providers, including a wallet that switched
        // networks silently while the failed read was outstanding.
        if (display) await withTimeout(checkNetwork(), 10_000, timeout)
        const fallback = publicClient(chain, publicUrl)
        const request = fallback.request(args as Parameters<typeof fallback.request>[0])
        const result = display ? await request
          : await withTimeout(request, Math.max(0, 10_000 - (Date.now() - started)), timeout)
        guard()
        return result
      }
    } }, { retryCount: 0 }))
    if (clients.size >= 64) clients.delete(clients.keys().next().value!)
    clients.set(key, client)
  }
  return client
}

/** For checks that must not wait on a wallet, such as a sponsored post's reply rule. */
export function publicClient(chain: ChainInfo, publicUrl: string) {
  const key = JSON.stringify([chain.id, publicUrl])
  let client = publicClients.get(key)
  if (!client) {
    client = makeClient(chain, http(publicUrl, { timeout: 10_000, retryCount: 0 }))
    if (publicClients.size >= 64) publicClients.delete(publicClients.keys().next().value!)
    publicClients.set(key, client)
  }
  return client
}

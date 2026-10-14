// A scripted wallet for development: installs `window.ethereum` backed by a
// private key, so the app can be driven in a plain browser tab (or by a test)
// without a wallet extension. Loaded by dev.html only, never by the built app.
//
//   VITE_DEV_WALLET_KEY  the signing key (default: anvil's second test account)
//   VITE_DEV_WALLET_RPC  the chain to send to (default: http://127.0.0.1:8555)
//
// Every request is answered without a prompt: this is a test key on a test
// chain. Signing and sending happen here in the page, through viem.
import { createWalletClient, defineChain, http, numberToHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Eip1193Provider } from '../lib/types'

const KEY = (import.meta.env.VITE_DEV_WALLET_KEY as Hex | undefined) ?? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const RPC = (import.meta.env.VITE_DEV_WALLET_RPC as string | undefined) ?? 'http://127.0.0.1:8555'

const account = privateKeyToAccount(KEY)
let chainId: number | null = null

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } }
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code })
  return body.result
}

async function currentChainId(): Promise<number> {
  if (chainId === null) chainId = Number(await rpc('eth_chainId'))
  return chainId
}

/** Typed data as the wallet receives it: JSON, with numbers as strings. viem wants bigints. */
function typedData(json: string) {
  type Field = { name: string; type: string }
  const td = JSON.parse(json) as {
    domain: Record<string, unknown>
    types: Record<string, Field[]>
    primaryType: string
    message: Record<string, unknown>
  }
  const fix = (typeName: string, value: Record<string, unknown>) => {
    for (const f of td.types[typeName] ?? []) {
      const v = value[f.name]
      if (/^u?int\d*$/.test(f.type) && (typeof v === 'string' || typeof v === 'number')) value[f.name] = BigInt(v)
      else if (td.types[f.type] && v && typeof v === 'object') fix(f.type, v as Record<string, unknown>)
    }
  }
  fix(td.primaryType, td.message)
  if (td.domain.chainId !== undefined) td.domain.chainId = Number(td.domain.chainId)
  return td
}

type Tx = { to?: Hex; data?: Hex; value?: Hex; gas?: Hex }

async function sendTransaction(tx: Tx): Promise<Hex> {
  const id = await currentChainId()
  const chain = defineChain({
    id,
    name: `dev ${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  })
  const client = createWalletClient({ account, chain, transport: http(RPC) })
  return client.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : undefined,
    gas: tx.gas ? BigInt(tx.gas) : undefined,
  })
}

const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

const provider: Eip1193Provider & { isDevWallet: true } = {
  isDevWallet: true,
  on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(listener)
  },
  removeListener(event, listener) {
    listeners.get(event)?.delete(listener)
  },
  async request({ method, params }) {
    const p = (params ?? []) as unknown[]
    switch (method) {
      case 'eth_accounts':
        // `?noaccount` in the page URL: installed but not connected until asked.
        if (new URLSearchParams(location.search).has('noaccount')) return []
        return [account.address]
      case 'eth_requestAccounts':
        return [account.address]
      case 'eth_chainId':
        return numberToHex(await currentChainId())
      case 'wallet_switchEthereumChain': {
        const wanted = Number((p[0] as { chainId: string }).chainId)
        if (wanted !== (await currentChainId())) throw Object.assign(new Error(`this dev wallet only knows chain ${chainId}`), { code: 4902 })
        return null
      }
      case 'wallet_addEthereumChain':
      case 'wallet_revokePermissions':
        return null
      case 'eth_signTypedData_v4': {
        const td = typedData(p[1] as string)
        return account.signTypedData(td as unknown as Parameters<typeof account.signTypedData>[0])
      }
      case 'personal_sign':
        return account.signMessage({ message: { raw: p[0] as Hex } })
      case 'eth_sendTransaction':
        return sendTransaction(p[0] as Tx)
      default:
        return rpc(method, p)
    }
  },
}

window.ethereum = provider
console.info(`dev wallet installed: ${account.address} on ${RPC}`)

import { sameAddress } from '../../lib/format'
import { getAddress, isAddress, type Address } from 'viem'
import { request } from '../../lib/api'
import type { ChainInfo } from '../../lib/types'

export type KeyringSide = 'holding' | 'holders'
export type KeyBalance = { address: Address; balance: number }
export type KeyringPage = {
  active: boolean
  entries: KeyBalance[]
  ownBalance: number
  total: number
  next: Address | null
  checkpoint: { block: bigint; hash: string }
}
const KEYRING_PAGE_SIZE = 64

/** Management reads use the host index. Quotes and wallet RPCs belong on the market page. */
export async function readKeyringPage(chain: ChainInfo, account: Address, market: Address,
  side: KeyringSide, after: Address | null, limit = KEYRING_PAGE_SIZE): Promise<KeyringPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('invalid keyring page size')
  const params = new URLSearchParams({ view: side, limit: String(limit) })
  if (after) params.set('after', after)
  const result = await request<{
    market: unknown; view: unknown; active: unknown; own_balance: unknown; total: unknown;
    entries: unknown; next: unknown; checkpoint: { block: unknown; hash: unknown }
  }>(chain, `keyring/${account}/balances?${params}`)
  const quantity = (value: unknown, min: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= 0xffff_ffff
  if (!result || typeof result.market !== 'string' || !sameAddress(result.market, market)
    || result.view !== side || typeof result.active !== 'boolean' || !quantity(result.own_balance, 0)
    || typeof result.total !== 'number' || !Number.isSafeInteger(result.total) || result.total < 0
    || !Array.isArray(result.entries) || result.entries.length > limit || result.entries.length > result.total
    || typeof result.checkpoint?.block !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(result.checkpoint.block)
    || BigInt(result.checkpoint.block) > 0xffff_ffff_ffff_ffffn
    || typeof result.checkpoint.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.checkpoint.hash)) {
    throw new Error('invalid keyring balances')
  }
  let previous = after?.toLowerCase() ?? ''
  const entries: KeyBalance[] = result.entries.map(entry => {
    if (!entry || typeof entry.address !== 'string' || !isAddress(entry.address, { strict: false })
      || entry.address.toLowerCase() <= previous || sameAddress(entry.address, account)
      || !quantity(entry.balance, 1)) throw new Error('invalid keyring balances')
    previous = entry.address.toLowerCase()
    return { address: getAddress(entry.address), balance: entry.balance }
  })
  if (result.next !== null && (typeof result.next !== 'string' || result.next.toLowerCase() !== previous
    || entries.length !== limit || result.total <= entries.length)) throw new Error('invalid keyring cursor')
  return { active: result.active, entries, ownBalance: result.own_balance, total: result.total,
    next: result.next === null ? null : getAddress(result.next as string),
    checkpoint: { block: BigInt(result.checkpoint.block), hash: result.checkpoint.hash } }
}

/** A new checkpoint alone is not a balance change. Compare only the displayed page and totals. */
export function keyringPageChanged(shown: KeyringPage, latest: KeyringPage): boolean {
  return shown.active !== latest.active || shown.ownBalance !== latest.ownBalance || shown.total !== latest.total
    || shown.next !== latest.next || shown.entries.length !== latest.entries.length
    || shown.entries.some((entry, i) => entry.address !== latest.entries[i]?.address || entry.balance !== latest.entries[i]?.balance)
}

export function byQuantity(entries: KeyBalance[]): KeyBalance[] {
  return [...entries].sort((a, b) => b.balance - a.balance || a.address.toLowerCase().localeCompare(b.address.toLowerCase()))
}

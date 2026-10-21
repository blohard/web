// Public purchases and transfers. The host replays these from its accepted
// key-market journal; this path never asks a wallet or a chain RPC.
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { integer, request } from '../../lib/api'
import { sameAddress } from '../../lib/format'
import { muted } from '../../lib/muted.svelte'
import { host } from '../../lib/host.svelte'
import type { ChainInfo } from '../../lib/types'

export type KeyPosition = { block: bigint; log: number }
export type KeyActivity = KeyPosition & {
  creator: Address; amount: number; timestamp: number; transaction: Hex
} & ({ kind: 'purchase'; buyer: Address } | { kind: 'transfer'; from: Address; to: Address })
export const keyActivityId = (e: KeyActivity) => `key/${e.block}/${e.log}`
export const keyActivityAccounts = (e: KeyActivity) => e.kind === 'purchase' ? [e.creator, e.buyer] : [e.creator, e.from, e.to]
export const visibleKeyActivity = (e: KeyActivity) => !keyActivityAccounts(e).some(a => muted.has(a) || host.blocked(a))
export const newerPosition = (a: KeyPosition, b: KeyPosition) => a.block === b.block ? b.log - a.log : a.block > b.block ? -1 : 1
function position(v: any): KeyPosition {
  if (!v || typeof v.block !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(v.block)
    || !Number.isInteger(v.log) || v.log < 0 || v.log > 0xffff_ffff) throw Error('invalid key activity position')
  const block = integer(v.block)
  if (block > 0xffff_ffff_ffff_ffffn) throw Error('invalid key activity position')
  return { block, log: v.log }
}
function address(v: unknown): Address {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw Error('invalid key activity account')
  return getAddress(v)
}
export async function readKeyActivity(chain: ChainInfo, market: Address, before: KeyPosition | null = null, limit = 100) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before) { params.set('before_block', String(before.block)); params.set('before_log', String(before.log)) }
  const r = await request<any>(chain, `keyring/activity?${params}`)
  if (!r || typeof r.market !== 'string' || !sameAddress(r.market, market)
    || !Array.isArray(r.items) || r.items.length > limit) throw Error('invalid key activity response')
  const checkpoint = position({ block: r.checkpoint?.block, log: 0 })
  let previous = before
  const items = r.items.map((n: any): KeyActivity => {
    const p = position(n.position), e = n.event
    if (!e || !Number.isInteger(e.amount) || e.amount < 1 || e.amount > 0xffff_ffff
      || !Number.isInteger(n.timestamp) || n.timestamp < 0 || n.timestamp > 0xffff_ffff
      || typeof n.transaction !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(n.transaction)
      || p.block > checkpoint.block || (previous && newerPosition(p, previous) <= 0)) throw Error('invalid key activity event')
    previous = p
    const shared = { ...p, creator: address(e.creator), amount: e.amount, timestamp: n.timestamp, transaction: n.transaction as Hex }
    if (e.kind === 'trade' && e.buy === true) return { ...shared, kind: 'purchase', buyer: address(e.holder) }
    if (e.kind === 'transfer') {
      const from = address(e.from), to = address(e.to)
      if (sameAddress(from, to)) throw Error('invalid key activity transfer')
      return { ...shared, kind: 'transfer', from, to }
    }
    throw Error('invalid key activity event')
  })
  const next = r.next === null ? null : position(r.next)
  // Filtering can advance past hidden events and can return an empty page.
  if (next && (next.block > checkpoint.block || (before && newerPosition(next, before) <= 0)
    || (previous && newerPosition(next, previous) < 0))) throw Error('invalid key activity cursor')
  return { items: items as KeyActivity[], next }
}

/** Paging keeps its head. Only refresh replaces the snapshot; failed reads keep it. */
export class KeyActivityFeed {
  private items: KeyActivity[] = []
  private next: KeyPosition | null = null
  private loaded = false
  private version = 0
  constructor(readonly chain: ChainInfo, readonly market: Address) {}
  visible() { return this.items.filter(visibleKeyActivity) }
  frontier() { return this.next }
  get revision() { return this.version }
  async load(limit: number, refresh: boolean) {
    const reset = refresh || !this.loaded
    let items = reset ? [] : [...this.items], next = reset ? null : this.next
    const oldest = reset ? this.items.at(-1) : undefined
    // Walk back toward the old range on refresh, within the per-load bound.
    // A bounded walk leaves a continuation for the next "show more" press.
    for (let round = 0; round < 8 && (reset && round === 0 || next !== null); round++) {
      if (items.filter(visibleKeyActivity).length >= limit && (!oldest || !next || newerPosition(next, oldest) >= 0)) break
      const page = await readKeyActivity(this.chain, this.market, next)
      items.push(...page.items); next = page.next
    }
    if (reset) this.version++
    this.items = items; this.next = next; this.loaded = true
    return { items: this.visible(), complete: next === null }
  }
  async peek() {
    if (!this.loaded) return null
    const version = this.version
    let before: KeyPosition | null = null
    for (let round = 0; round < 8; round++) {
      const page = await readKeyActivity(this.chain, this.market, before)
      const newest = page.items.find(visibleKeyActivity)
      if (newest || !page.next) return { version, head: newest ? keyActivityId(newest) : null }
      before = page.next
    }
    return null
  }
  changed(value: Awaited<ReturnType<KeyActivityFeed['peek']>>) {
    const head = this.visible()[0]
    return value !== null && value.version === this.version && value.head !== (head ? keyActivityId(head) : null)
  }
}

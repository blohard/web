import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { integer, request } from '../../lib/api'
import { sameAddress } from '../../lib/format'
import { muted } from '../../lib/muted.svelte'
import type { ChainInfo } from '../../lib/types'

type KeyNotice = { chain: ChainInfo; amount: number; timestamp: number; transaction: Hex; block: bigint; log: number }
/** An account's key inbox: someone trading its keys, or someone sending it keys (to `creator`). */
export type KeyNotification =
  | KeyNotice & { kind: 'key-trade'; trader: Address; buy: boolean }
  | KeyNotice & { kind: 'key-received'; creator: Address; from: Address }
type Cursor = { block: bigint; log: number }
type Page = { items: KeyNotification[]; next: Cursor | null; truncated: boolean }
export const keyNoticeId = (n: KeyNotification) => `${n.kind === 'key-trade' ? 'trade' : 'received'}/${n.chain.id}/${n.block}/${n.log}`
/** The other account in a notice, the trader or the sender: mutes apply to it. */
export const keyNoticeParty = (n: KeyNotification): Address => n.kind === 'key-trade' ? n.trader : n.from
const positionBefore = (a: Cursor, b: Cursor) => a.block < b.block || (a.block === b.block && a.log < b.log)
function cursor(value: unknown): Cursor {
  const v = value as { block?: unknown; log?: unknown }
  if (!v || typeof v.block !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(v.block)
    || typeof v.log !== 'number' || !Number.isInteger(v.log) || v.log < 0 || v.log > 0xffff_ffff) throw Error('invalid key trade position')
  const block = integer(v.block)
  if (block > 0xffff_ffff_ffff_ffffn) throw Error('invalid key trade position')
  return { block, log: v.log }
}
/** `account`'s key inbox. Only an account with active keys has trades; any account can receive keys. */
export async function readKeyNotifications(chain: ChainInfo, market: Address, account: Address,
  before: Cursor | null = null, limit = 100): Promise<Page> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before) { params.set('before_block', String(before.block)); params.set('before_log', String(before.log)) }
  const r = await request<any>(chain, `keyring/${account}/trades?${params}`)
  if (!r || typeof r.market !== 'string' || !sameAddress(r.market, market) || typeof r.active !== 'boolean'
    || typeof r.truncated !== 'boolean' || !Array.isArray(r.items) || r.items.length > limit) throw Error('invalid key trade response')
  const checkpoint = cursor({ block: r.checkpoint?.block, log: 0 })
  let previous = before
  const items: KeyNotification[] = r.items.map((n: any): KeyNotification => {
    const p = cursor(n.position)
    if (!Number.isInteger(n.amount) || n.amount < 1 || n.amount > 0xffff_ffff
      || !Number.isInteger(n.timestamp) || n.timestamp < 0 || n.timestamp > 0xffff_ffff
      || typeof n.transaction !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(n.transaction)
      || p.block > checkpoint.block || (previous && !positionBefore(p, previous))) throw Error('invalid key trade notification')
    previous = p
    const shared = { chain, amount: n.amount, timestamp: n.timestamp, transaction: n.transaction as Hex, ...p }
    if (n.kind === 'received') {
      if (!isAddress(n.creator, { strict: false }) || !isAddress(n.from, { strict: false }) || sameAddress(n.from, account)) {
        throw Error('invalid received keys notification')
      }
      return { kind: 'key-received', creator: getAddress(n.creator), from: getAddress(n.from), ...shared }
    }
    // Only a market that is active can have been traded.
    if (n.kind !== 'trade' || !r.active || !isAddress(n.trader, { strict: false }) || sameAddress(n.trader, account)
      || typeof n.buy !== 'boolean') throw Error('invalid key trade notification')
    return { kind: 'key-trade', trader: getAddress(n.trader), buy: n.buy, ...shared }
  })
  const next = r.next === null ? null : cursor(r.next)
  if (next && (items.length !== limit || !previous || next.block !== previous.block || next.log !== previous.log)) throw Error('invalid key trade cursor')
  return { items, next, truncated: r.truncated }
}

/** A mounted notification view owns its cursor. Paging never fetches a new head. */
export class KeyNotifications {
  private items = $state.raw<KeyNotification[]>([])
  private polled = $state<{ version: number; head: string | null } | null>(null)
  private version = 0
  private next: Cursor | null = null
  private loaded = false
  private truncated = false
  private refresh: unknown
  constructor(readonly chain: ChainInfo, readonly market: Address, readonly creator: Address) {}
  visible() { return this.items.filter(n => !muted.has(keyNoticeParty(n))) }
  async load(limit: number, refresh: unknown) {
    const reset = !this.loaded || refresh !== this.refresh
    let items = reset ? [] : [...this.items], next = reset ? null : this.next
    let truncated = reset ? false : this.truncated
    // One 100-row page covers the host's retained inbox, including muted rows.
    if ((reset || next !== null) && items.filter(n => !muted.has(keyNoticeParty(n))).length < limit) {
      const page = await readKeyNotifications(this.chain, this.market, this.creator, next)
      items.push(...page.items); next = page.next; truncated = page.truncated
    }
    // Commit only a successful read, retaining the old list if any page failed.
    if (reset) this.version++
    this.items = items; this.next = next; this.truncated = truncated; this.loaded = true; this.refresh = refresh
    return { items: this.visible(), complete: next === null, truncated }
  }
  get changed() {
    return this.polled !== null && this.polled.version === this.version
      && this.polled.head !== (this.items[0] ? keyNoticeId(this.items[0]) : null)
  }
  async peek() {
    // Keys can arrive whether or not this account activated its own.
    if (!this.loaded) return null
    const version = this.version
    const page = await readKeyNotifications(this.chain, this.market, this.creator, null, 1)
    return { version, head: page.items[0] ? keyNoticeId(page.items[0]) : null }
  }
  observe(value: { version: number; head: string | null } | null) { this.polled = value }
}

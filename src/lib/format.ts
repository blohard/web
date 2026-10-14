import { formatEther, type Address, type Hex } from 'viem'

/**
 * An ETH amount for reading, without the unit: three significant digits with
 * trailing zeros trimmed and leading decimal zeros written out. A bound rounds
 * up for a payment or "up to", down for "at least" or an amount received;
 * a price rounds to nearest. The exact amount goes beside it (Eth.svelte).
 */
export function ethAmount(wei: bigint, round: 'up' | 'down' | 'nearest' = 'nearest'): string {
  if (wei < 0n) throw new RangeError('ETH amounts must be nonnegative')
  const unit = 10n ** BigInt(Math.max(0, wei.toString().length - 3))
  const rest = wei % unit
  const carry = round === 'up' ? rest !== 0n : round === 'nearest' ? rest * 2n >= unit : false
  return formatEther((wei / unit + (carry ? 1n : 0n)) * unit)
}

export function shortAddress(a: Address | string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function shortHex(h: Hex | string, n = 10): string {
  return h.length > n + 2 ? `${h.slice(0, n)}…` : h
}

/** The same account, whatever the casing (checksummed or not). */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Whether `list` holds `a`, whatever the case of either. */
export const hasAddress = (list: readonly string[], a: string): boolean => list.some((x) => sameAddress(x, a))

/** A bounded literal excerpt for context blocks; formatting is for the full body. */
export function excerpt(body: string, max = 140): string {
  const text = body.slice(0, max * 2)
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`
}

/** Compact relative time as timelines show it: 12s, 5m, 3h, then a date. */
export function timeAgo(unixSeconds: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor(now / 1000) - unixSeconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return shortDate(new Date(unixSeconds * 1000), now)
}

/** A date as a card shows an old one: "Sep 2", or "Sep 2, 2025" outside the current year. */
export function shortDate(d: Date, now = Date.now()): string {
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** The full timestamp shown under a focused post: "10:42 PM · Sep 2, 2026". */
export function fullTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return `${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
}

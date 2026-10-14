// Keep the display curve in sync with AccountKeys.sol. Payments use RPC quotes.
import { formatEther } from 'viem'

export const MAX_KEY_SUPPLY = 0xffff_ffffn
const BASE_KEY_PRICE = 10_000_000_000_000n
const RESERVE_SCALE = 160_000_000_000_000_000_000_000n

export function keyReserve(supply: bigint): bigint {
  if (supply < 0n || supply > MAX_KEY_SUPPLY) throw new Error('invalid key supply')
  const radicand = RESERVE_SCALE * supply ** 5n
  if (radicand === 0n) return 0n
  // Start above the square root and converge to its integer floor.
  let root = 1n << BigInt(Math.ceil(radicand.toString(2).length / 2))
  for (;;) {
    const next = (root + radicand / root) >> 1n
    if (next >= root) return BASE_KEY_PRICE * supply + root
    root = next
  }
}

export function keyPrice(n: bigint): bigint {
  if (n < 1n || n > MAX_KEY_SUPPLY) throw new Error('invalid key number')
  return keyReserve(n) - keyReserve(n - 1n)
}

/**
 * The market page's illustrative price curve, in its 600 by 176 drawing:
 * where supply is now and where the chosen trade would take it. Transaction
 * amounts never come from here; they use the contract's quote.
 */
export function keyCurveChart(supplyNow: bigint, side: 'buy' | 'sell' | 'transfer', amount: number) {
  const price = (n: number) => n === 0 ? 0 : Number(formatEther(keyPrice(BigInt(n))))
  const supply = Number(supplyNow)
  const after = Math.max(0, Math.min(Number(MAX_KEY_SUPPLY), supply + (side === 'buy' ? amount : side === 'sell' ? -amount : 0)))
  const max = Math.min(Number(MAX_KEY_SUPPLY), Math.max(20, Math.ceil(Math.max(supply, after) * 1.5)))
  const maxPrice = price(max)
  const x = (n: number) => 24 + n / max * 552
  const y = (n: number) => 148 - price(n) / maxPrice * 124
  const path = Array.from({ length: 61 }, (_, i) => {
    const n = Math.round(max * i / 60)
    return `${i ? 'L' : 'M'}${x(n)},${y(n)}`
  }).join(' ')
  return { supply, after, max, path, x: x(supply), y: y(supply), endX: x(after), endY: y(after) }
}

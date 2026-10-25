import type { Address, Hex } from 'viem'

// Validate wire primitives without choosing a display representation or an endpoint's error.
export const wireAddress = (value: unknown): value is Address =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
export const wireHash = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
export const uint32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
/** Canonical decimal, length bounded before bigint conversion. */
export const uint64 = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn

import { integer } from '../../lib/api'

export type KeyPosition = { block: bigint; log: number }
/** Chain positions, newest first. */
export const newerPosition = (a: KeyPosition, b: KeyPosition) => a.block === b.block ? b.log - a.log : a.block > b.block ? -1 : 1

/** Both key endpoints encode a uint64 block and uint32 log index. */
export function keyPosition(value: unknown, subject: 'activity' | 'trade'): KeyPosition {
  const v = value as { block?: unknown; log?: unknown }
  if (!v || typeof v.block !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(v.block)
    || typeof v.log !== 'number' || !Number.isInteger(v.log) || v.log < 0 || v.log > 0xffff_ffff) throw Error(`invalid key ${subject} position`)
  const block = integer(v.block)
  if (block > 0xffff_ffff_ffff_ffffn) throw Error(`invalid key ${subject} position`)
  return { block, log: v.log }
}

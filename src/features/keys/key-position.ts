import { uint32, uint64 } from '../../shared/wire-values'

export type KeyPosition = { block: bigint; log: number }
/** Chain positions, newest first. */
export const newerPosition = (a: KeyPosition, b: KeyPosition) => a.block === b.block ? b.log - a.log : a.block > b.block ? -1 : 1

/** Both key endpoints encode a uint64 block and uint32 log index. */
export function keyPosition(value: unknown, subject: 'activity' | 'trade'): KeyPosition {
  const v = value as { block?: unknown; log?: unknown }
  if (!v || !uint64(v.block) || !uint32(v.log)) throw Error(`invalid key ${subject} position`)
  return { block: BigInt(v.block), log: v.log }
}

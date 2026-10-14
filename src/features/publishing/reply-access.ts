import type { Address } from 'viem'
import { message, record } from '../../lib/api'
import { endingOf, hasResponseRight } from '../../lib/board'
import { isBlocked } from '../account/blocking'
import { sameAddress } from '../../lib/format'
import { replyGateKind } from './reply-rules'
import { keyReplyDeployment } from '../keys/account-keys-config'
import type { ChainInfo, KeyringInfo } from '../../lib/types'

export type ReplyAccess = { kind: 'closed' | 'blocked' | 'inactive' | 'keys' | null; creator: Address; blocked?: true } | null

/** A non-null kind restricts submission; blocked alone warns about folding. Posting still checks live admission. */
export async function replyAccess(chain: ChainInfo, parentId: bigint, replier: Address, indexed: KeyringInfo | null | undefined): Promise<ReplyAccess> {
  const parent = record((await message(chain, parentId)).message)
  if (parent.id !== parentId) throw new Error('invalid parent answer')
  const creator = parent.author, kind = replyGateKind(chain, parent.effectiveGate)
  if (endingOf(parent.gate)) return { kind: 'closed', creator }
  if (hasResponseRight(parent, replier)) return null
  if (endingOf(parent.effectiveGate) || kind === 'closed') return { kind: 'closed', creator }
  if (sameAddress(creator, replier)) return null
  const blocked = await isBlocked(chain, creator, replier)
  if (blocked && (kind === 'blocklist' || kind === 'keys-blocklist')) return { kind: 'blocked', creator }
  // A block is only a folding warning when the gate does not enforce the blocklist.
  const warning: ReplyAccess = blocked ? { kind: null, creator, blocked: true } : null
  if (kind !== 'keys' && kind !== 'keys-blocklist') return warning
  const deployment = keyReplyDeployment(chain, indexed)
  if (!deployment || !chain.blocklist) return warning
  const { keyMarket } = await import('../keys/account-keys')
  const account = await keyMarket(chain, deployment).replyAccess(creator, replier)
  if (!account.active) return { ...warning, kind: 'inactive', creator }
  return account.holdings > 0n ? warning : { ...warning, kind: 'keys', creator }
}

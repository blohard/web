import { zeroAddress, type Address } from 'viem'
import { REMOVED, TOMBSTONE } from '../../lib/board'
import { sameAddress } from '../../lib/format'
import type { ChainInfo } from '../../lib/types'

/** Classify only host-published, known gate implementations. */
export function replyGateKind(chain: ChainInfo, gate: Address) {
  if (sameAddress(gate, zeroAddress)) return null
  if (chain.blocking && sameAddress(gate, chain.blocking.gate)) return 'blocklist'
  if (chain.key_gates?.holders_blocklist && sameAddress(gate, chain.key_gates.holders_blocklist)) return 'keys-blocklist'
  if (chain.key_gates?.holders && sameAddress(gate, chain.key_gates.holders)) return 'keys'
  if (chain.closed_gate && sameAddress(gate, chain.closed_gate)) return 'closed'
  return null
}

export type AuthorGateChoice = 'all' | 'keys' | 'deactivated'

/** No gate a reply rule may name: unset, or one of the Board's endings. */
const isSentinel = (gate: Address) => [zeroAddress, TOMBSTONE, REMOVED].some(sentinel => sameAddress(gate, sentinel))

/** Both reply policies enforce the same blocklist. Never substitute a plain key gate. */
export function gateForChoice(chain: ChainInfo, choice: AuthorGateChoice): Address {
  if (choice === 'deactivated') return TOMBSTONE
  const gate = choice === 'all' ? chain.blocking?.gate : choice === 'keys' ? chain.key_gates?.holders_blocklist : null
  if (!chain.blocking || !gate || isSentinel(gate)) {
    throw new Error('this reply rule is not available on this chain')
  }
  return gate
}

/** Unset and plain key gates match the simple labels only when no accounts are blocked. */
export function authorGateChoice(chain: ChainInfo, gate: Address, blocklistEmpty = false): AuthorGateChoice | 'other' {
  if (sameAddress(gate, TOMBSTONE)) return 'deactivated'
  const kind = replyGateKind(chain, gate)
  if (kind === 'blocklist') return 'all'
  if (kind === 'keys-blocklist') return 'keys'
  if (blocklistEmpty && sameAddress(gate, zeroAddress)) return 'all'
  if (blocklistEmpty && kind === 'keys') return 'keys'
  return 'other'
}

export function otherGateLabel(chain: ChainInfo, gate: Address): string {
  if (replyGateKind(chain, gate) === 'closed') return 'no new replies'
  if (sameAddress(gate, zeroAddress)) return 'all without block enforcement'
  if (replyGateKind(chain, gate) === 'keys') return 'key holders without block enforcement'
  return 'custom gate'
}

export function replyRuleLabel(choice: 'all' | 'keys' | 'closed', blocklistEmpty: boolean): string {
  if (choice === 'closed') return 'no new replies'
  const label = choice === 'all' ? 'all' : 'key holders'
  return blocklistEmpty ? label : `${label} except blocked`
}

export function accountReplyLabel(chain: ChainInfo, gate: Address | undefined, empty: boolean): string {
  if (gate === undefined) return 'loading…'
  const choice = authorGateChoice(chain, gate, empty)
  if (choice === 'deactivated') return 'account deactivated'
  if (choice === 'all' || choice === 'keys') return replyRuleLabel(choice, empty)
  return otherGateLabel(chain, gate)
}

type PostReplyChoice = 'default' | 'all' | 'keys' | 'closed'
/** Explicit rules always enforce blocks; an existing custom gate remains visibly distinct. */
export function postReplyChoice(chain: ChainInfo, gate: Address): PostReplyChoice | 'other' {
  if (replyGateKind(chain, gate) === 'closed') return 'closed'
  if (sameAddress(gate, zeroAddress)) return 'default'
  const choice = chain.blocking ? authorGateChoice(chain, gate) : 'other'
  return choice === 'all' || choice === 'keys' ? choice : 'other'
}

export function postGateForChoice(chain: ChainInfo, choice: PostReplyChoice): Address {
  if (choice === 'default') return zeroAddress
  if (choice !== 'closed') return gateForChoice(chain, choice)
  const gate = chain.closed_gate
  if (!gate || isSentinel(gate)) throw new Error('this reply rule is not available on this chain')
  return gate
}

export function isClosedReplyRule(chain: ChainInfo, own: Address | undefined, author: Address | undefined): boolean {
  const gate = own === zeroAddress ? author : own
  return gate !== undefined && replyGateKind(chain, gate) === 'closed'
}

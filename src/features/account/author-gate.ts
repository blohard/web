import type { Address } from 'viem'
import { setAuthorGate } from '../../lib/board'
import { notificationList } from './blocking'
import { sameAddress } from '../../lib/format'
import { gates } from '../../lib/gates.svelte'
import { gateForChoice, type AuthorGateChoice } from '../publishing/reply-rules'
import { hasMembers } from '../../lib/registry'
import type { TransactionProgress } from '../../lib/transactions'
import type { ChainInfo } from '../../lib/types'
import { captureWallet, type ActionWallet } from '../../lib/wallet-action'
import { accountActions } from './account-actions.svelte'

export async function readAuthorGate(chain: ChainInfo, owner: Address) {
  await gates.ensureAuthor(chain, owner)
  await gates.advanceToHead(chain)
}

export function hasBlockedAccounts(chain: ChainInfo, owner: Address): Promise<boolean> {
  const list = notificationList(chain, owner)
  return list ? hasMembers(chain, { registry: list.registry, id: list.list, owner }) : Promise.resolve(false)
}

/** Capture the profile owner before awaiting the wallet, and apply only a confirmed receipt. */
export async function saveAuthorGate(wallet: ActionWallet, chain: ChainInfo, owner: Address, choice: AuthorGateChoice, onProgress?: TransactionProgress) {
  const gate = gateForChoice(chain, choice)
  const pressed = captureWallet(wallet)
  if (!pressed || !sameAddress(pressed.account, owner)) throw new Error('connect the wallet for this profile')
  return accountActions.run(chain, pressed.account, async (sent) => {
    await wallet.ensureChain(chain)
    if (!pressed.current()) {
      throw new Error('the wallet changed accounts. nothing was sent')
    }
    const landed = await setAuthorGate(pressed.provider, pressed.account, chain, gate, onProgress, sent)
    gates.settleAuthor(chain, owner, gate, landed)
    return gate
  })
}

import type { Address } from 'viem'
import * as api from '../../lib/api'
import { gates } from '../../lib/gates.svelte'
import { sameAddress } from '../../lib/format'
import { trackedChanges } from '../../lib/tracked-changes.svelte'
import type { ChainInfo } from '../../lib/types'

const key = (chain: ChainInfo, account: Address) => `${chain.id}/${chain.contract.toLowerCase()}/${account.toLowerCase()}`
const changes = trackedChanges<Address>('account-change', key, (chain, account, receipt) => {
  const event = receipt.events.find((e) => e.kind === 'author_gate' && sameAddress(e.author, account))
  if (event?.kind === 'author_gate') gates.settleAuthor(chain, account, event.new, { block: api.integer(receipt.block), index: event.position.log })
})

/**
 * An account's own writes: its author gate, its blocklist and the lists it
 * edits. One at a time; one whose receipt never came is kept, and no other is
 * sent for the account until a check finds its outcome or the reader clears it.
 */
export const accountActions = {
  busy: changes.busy,
  unsettled: changes.unsettled,
  saved: changes.saved,
  check: changes.check,
  clear: changes.clear,
  run<T>(chain: ChainInfo, account: Address, work: Parameters<typeof changes.run<T>>[2]): Promise<T> {
    return changes.run(chain, account, work, 'a change to your account is still pending',
      'an earlier change to your account may still land. check it before making another')
  },
}

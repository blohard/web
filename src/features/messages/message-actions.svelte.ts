import * as api from '../../lib/api'
import { gates } from '../../lib/gates.svelte'
import { trackedChanges } from '../../lib/tracked-changes.svelte'
import type { ChainInfo } from '../../lib/types'

const key = (chain: ChainInfo, id: bigint) => `${chain.id}/${chain.contract.toLowerCase()}/${id}`
const changes = trackedChanges<bigint>('post-change', key, (chain, id, receipt) => {
  const event = receipt.events.find((e) => e.kind === 'reply_gate' && api.integer(e.id) === id)
  if (event?.kind === 'reply_gate') gates.settleMessage(chain, id, event.new, { block: api.integer(receipt.block), index: event.position.log })
})

/**
 * Rule edits and deletion, serialized across every mounted copy of a post. A
 * change whose receipt never came is kept, and no other change to the post is
 * sent until a check finds its outcome or the reader clears it.
 */
export const messageActions = {
  busy: changes.busy,
  unsettled: changes.unsettled,
  saved: changes.saved,
  check: changes.check,
  clear: changes.clear,
  run<T>(chain: ChainInfo, id: bigint, work: Parameters<typeof changes.run<T>>[2]): Promise<T> {
    return changes.run(chain, id, work, 'a change to this post is still pending',
      'an earlier change to this post may still land. check it before making another')
  },
}

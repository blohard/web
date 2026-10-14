import type { ChainInfo } from '../../lib/types'
import { router } from '../navigation/router.svelte'

const keyOf = (chain: ChainInfo, id: bigint) => `${chain.id}/${chain.contract.toLowerCase()}/${id}`

/** A visual marker for the latest submission in this visit. Never moves focus or scroll. */
class MessageSelection {
  key = $state<string | null>(null)

  constructor(key: string | null = null) { this.key = key }

  select(chain: ChainInfo, id: bigint): void { this.key = keyOf(chain, id) }
  has(chain: ChainInfo, id: bigint): boolean { return this.key === keyOf(chain, id) }
}

/** Capture at mount so a confirmation cannot change another page's selection. */
export const messageSelection = () => router.visit.state('message-selection',
  () => new MessageSelection(), selection => new MessageSelection(selection.key))

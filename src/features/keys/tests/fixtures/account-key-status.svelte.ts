import { flushSync } from 'svelte'
import { accountKeyStatus } from '../../account-key-status.svelte'
import type { ChainInfo } from '../../../../lib/types'
import type { Address } from 'viem'

export { flushSync }

/** `walletless` reads as a reader without a wallet does: from the host's index of `indexed`, when it is the market. */
export function profileStatus(chain: ChainInfo, address: Address, walletless?: { indexed: Address | null }) {
  let input = $state({ chain, address, reloadRevision: 0, ...(walletless ? { enabled: false, indexed: walletless.indexed } : {}) })
  let status!: ReturnType<typeof accountKeyStatus>
  const stop = $effect.root(() => { status = accountKeyStatus(() => input) })
  return {
    get state() { return status.state },
    get active() { return status.active },
    retry() { status.retry() },
    refresh() { input = { ...input, reloadRevision: input.reloadRevision + 1 } },
    visit(chain: ChainInfo, address: Address) { input = { ...input, chain, address, reloadRevision: 0 } },
    stop,
  }
}

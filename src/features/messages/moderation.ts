// Deletion and removal use the reader's wallet, independently of browser storage.
import { messageActions } from './message-actions.svelte'
import { tombstone, removeReply } from '../../lib/board'
import type { Landed, TransactionProgress } from '../../lib/transactions'
import type { ChainInfo } from '../../lib/types'
import { captureWallet, type ActionWallet } from '../../lib/wallet-action'

/** Capture the wallet before switching chains so another account cannot inherit the action. */
export async function moderate(
  wallet: ActionWallet,
  chain: ChainInfo,
  id: bigint,
  action: 'delete' | 'remove',
  onProgress?: TransactionProgress,
): Promise<Landed> {
  return messageActions.run(chain, id, async (sent) => {
    const pressed = captureWallet(wallet)
    if (!pressed) throw new Error('connect a wallet first')
    await wallet.ensureChain(chain)
    if (!pressed.current()) throw new Error('the wallet account changed. try the action again')
    return (action === 'delete' ? tombstone : removeReply)(pressed.provider, pressed.account, chain, id, onProgress, sent)
  })
}

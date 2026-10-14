import { zeroAddress, type Address } from 'viem'
import { postReplyChoice } from '../publishing/reply-rules'
import { endingOf, setReplyGate } from '../../lib/board'
import { sameAddress } from '../../lib/format'
import { gates } from '../../lib/gates.svelte'
import { getStatus } from '../../lib/store'
import { keyReplyDeployment } from '../keys/account-keys-config'
import { messageActions } from '../messages/message-actions.svelte'
import type { TransactionProgress } from '../../lib/transactions'
import type { ChainInfo, Posted } from '../../lib/types'
import { captureWallet, type ActionWallet } from '../../lib/wallet-action'

/** Recheck a draft's selected address immediately before signing, without changing the visible page. */
export async function currentPostReplyGate(chain: ChainInfo, owner: Address, gate: Address): Promise<Address> {
  if (sameAddress(gate, zeroAddress)) return zeroAddress
  const status = await getStatus()
  const current = status.chains.find(c => c.id === chain.id && sameAddress(c.contract, chain.contract))
  if (!current) throw new Error('this board is no longer served by the host')
  const choice = postReplyChoice(current, gate)
  if (choice === 'all' || choice === 'closed') return gate
  const deployment = keyReplyDeployment(current, status.keyrings?.find(k => k.chain === chain.id))
  if (choice !== 'keys' || !deployment) return zeroAddress
  const [{ keyMarket }, { publicClient }] = await Promise.all([import('../keys/account-keys'), import('../keys/key-rpc')])
  // Sponsored posts never depend on the wallet's RPC, and this read has no reason to use it.
  return await keyMarket(current, deployment).isActive(owner, publicClient(current, deployment.rpcUrl)) ? gate : zeroAddress
}

/** Wallet-paid changes are offered only on live posts belonging to this account. */
export async function savePostReplyGate(
  wallet: ActionWallet,
  chain: ChainInfo,
  post: Pick<Posted, 'id' | 'author' | 'parentId'>,
  gate: Address,
  onProgress?: TransactionProgress,
) {
  const { id, author } = post
  return messageActions.run(chain, id, async (sent) => {
    const pressed = captureWallet(wallet)
    if (!pressed || !sameAddress(pressed.account, author)) throw new Error('connect the wallet that wrote this post')
    if (postReplyChoice(chain, gate) === 'other') throw new Error('this reply rule is not available on this chain')
    if (endingOf(await gates.ensureMessage(chain, id))) throw new Error('a deleted post cannot change its reply rule')
    await wallet.ensureChain(chain)
    if (!pressed.current()) throw new Error('the wallet changed accounts. nothing was sent')
    const landed = await setReplyGate(pressed.provider, pressed.account, chain, id, gate, onProgress, sent)
    gates.settleMessage(chain, id, gate, landed)
  })
}

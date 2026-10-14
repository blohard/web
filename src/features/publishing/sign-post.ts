import { zeroAddress, type Address, type Hex } from 'viem'
import { signerFor } from '../../lib/signer'
import { boardDomain, POST_TYPES } from '../../lib/signing.js'
import type { ChainInfo, Eip1193Provider } from '../../lib/types'
import { allocateNonce } from './nonces'
import type { SignedPost } from './relay'

/**
 * Sign a post instead of sending it, for a relayer to submit as `postBySig`.
 * Reserve a nonce in a shared bitmap word; the signature is good for an hour.
 */
export async function signPost(
  provider: Eip1193Provider,
  account: Address,
  chain: ChainInfo,
  args: { contentHash: Hex; parentId: bigint; replyGate?: Address },
): Promise<SignedPost> {
  const wallet = await signerFor(provider, account, chain)
  const nonce = await allocateNonce(chain, account)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const message = {
    author: account,
    contentHash: args.contentHash,
    parentId: args.parentId,
    replyGate: args.replyGate ?? zeroAddress,
    nonce,
    deadline,
  }
  const sig = await wallet.signTypedData({ domain: boardDomain(chain), types: POST_TYPES, primaryType: 'Post', message })
  return {
    author: account,
    contentHash: args.contentHash,
    parentId: args.parentId.toString(),
    replyGate: args.replyGate ?? zeroAddress,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    sig,
    gateData: '0x',
  }
}

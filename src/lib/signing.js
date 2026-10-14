// Shared by the client and sponsored-e2e.mjs. Field order is part of the EIP-712
// signature; contract-derived test vectors check this definition independently.
export const POST_TYPES = /** @type {const} */ ({
  Post: [
    { name: 'author', type: 'address' },
    { name: 'contentHash', type: 'bytes32' },
    { name: 'parentId', type: 'uint64' },
    { name: 'replyGate', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
})

/** @param {{ id: number, contract: import('viem').Address }} chain */
export function boardDomain(chain) {
  return { name: 'Board', version: '1', chainId: chain.id, verifyingContract: chain.contract }
}

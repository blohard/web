// Fill the Board's 256-bit nonce words instead of paying for a new word per
// signature. Each browser origin keeps its own randomly chosen words.
import { toHex, type Address } from 'viem'
import { STORES, tx } from '../../lib/db'
import type { ChainInfo } from '../../lib/types'

/** Reserve before signing. Cancelled requests leave gaps; resends keep their original nonce. */
export async function allocateNonce(chain: Pick<ChainInfo, 'id' | 'contract'>, author: Address): Promise<bigint> {
  // A 128-bit random word number avoids coordination with other devices;
  // the low eight bits select a nonce within it. Unused high bits stay zero.
  const fresh = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16)))) << 8n
  const key = [chain.id, chain.contract.toLowerCase(), author.toLowerCase()]
  let nonce = fresh
  try {
    await tx(STORES.nonces, 'readwrite', (store) => {
      const req = store.get(key)
      req.onsuccess = () => {
        const next: bigint | undefined = req.result
        // A zero low byte means all 256 positions in the previous word were reserved.
        if (next !== undefined && (next & 255n) !== 0n) nonce = next
        store.put(nonce + 1n, key)
      }
    }, { durability: 'strict' }) // Persist the reservation before handing it to the wallet.
    return nonce
  } catch {
    // Never return a stored nonce whose reservation failed: another tab could
    // take it. A fresh random word lets posting continue without local storage.
    return fresh
  }
}

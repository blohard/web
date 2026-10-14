// The ListRegistry contract (contracts/lib/protocol/src/ListRegistry.sol): reads of one
// list through the host index, and the owner's add / remove through a wallet.
import type { Address, Hex } from 'viem'
import { request, snapshots, type At, type List } from './api'
import { awaitIndexed, awaitSuccess } from './transactions'
import { signerFor } from './signer'
import type { ChainInfo, Eip1193Provider, ListInfo } from './types'
import { registryAbi } from './abi/registry'
export { registryAbi } from './abi/registry'

export type ListRef = Pick<ListInfo, 'registry' | 'id' | 'owner'>
const listKey = (list: ListRef): List => ({ registry: list.registry, owner: list.owner, list: list.id })

/** A membership question is a point lookup, never a walk of the owner's list. */
export async function contains(chain: ChainInfo, list: ListRef, member: Address): Promise<boolean> {
  const answer = await snapshots(chain, [], [], [{ list: listKey(list), member }])
  const result = answer.memberships[0]
  if (typeof result !== 'boolean') throw new Error('invalid membership answer')
  return result
}

/** An empty-list check needs only the first indexed member, even for a large list. */
export async function hasMembers(chain: ChainInfo, list: ListRef): Promise<boolean> {
  const page = await request<{ items: Address[]; next: Address | null }>(chain, 'list', { list: listKey(list), limit: 1 })
  if (!Array.isArray(page.items) || page.items.length > 1 || page.items.some(member => !/^0x[0-9a-f]{40}$/.test(member))
    || (page.next !== null && (page.items.length !== 1 || page.next !== page.items[0]))) throw new Error('invalid list page')
  return page.items.length > 0
}

/** Explicit list views page through the host's ordered membership index. */
export async function listMembers(chain: ChainInfo, list: ListRef): Promise<Address[]> {
  const members: Address[] = []
  let generation: Hex | undefined, after: Address | null = null
  do {
    const page: { at: At; items: Address[]; next: Address | null } = await request(chain, 'list', { list: listKey(list), generation, after, limit: 50 })
    if (page.items.length > 50 || (generation && page.at.generation !== generation)) throw new Error('invalid list page')
    for (const member of page.items) {
      if (!/^0x[0-9a-f]{40}$/.test(member) || (members.length > 0 && member <= members[members.length - 1]!)) throw new Error('host list is out of order')
      members.push(member)
    }
    if (page.next !== null && (page.items.length === 0 || page.next !== page.items.at(-1))) throw new Error('host list cursor made no progress')
    generation = page.at.generation
    after = page.next
  } while (after !== null)
  return members
}

/** Add or remove members of `list`, which the connected wallet must own; resolves once mined. `onSent` hears the hash first. */
export async function writeList(
  provider: Eip1193Provider,
  account: Address,
  chain: ChainInfo,
  list: Pick<ListInfo, 'registry' | 'owner' | 'id'>,
  fn: 'add' | 'remove',
  members: Address[],
  onSent?: (hash: Hex) => void,
): Promise<{ hash: Hex; indexed: boolean }> {
  const wallet = await signerFor(provider, account, chain)
  const hash = await wallet.writeContract({ address: list.registry, abi: registryAbi, functionName: fn, args: [list.owner, list.id, members] })
  onSent?.(hash)
  const receipt = await awaitSuccess(chain, hash)
  // The receipt already proves success. A slow/unavailable index does not
  // make this a failed write or justify another transaction.
  const indexed = await awaitIndexed(chain, BigInt(receipt.block)).then(() => true, () => false)
  return { hash, indexed }
}

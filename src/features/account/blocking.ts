// The default block action a client offers (CLIENT.md): put the
// address on the reader's own list, and, the first time, point the reader's
// author gate at the shared gate that reads that list. Nothing here is a
// protocol concept; it is one use of lists and gates.
import { keccak256, stringToBytes, zeroAddress, type Address, type Hex } from 'viem'
import type { List } from '../../lib/api'
import { authorGate, setAuthorGate, TOMBSTONE } from '../../lib/board'
import { replyGateKind } from '../publishing/reply-rules'
import { gates as ledger } from '../../lib/gates.svelte'
import { contains, writeList } from '../../lib/registry'
import type { ChainInfo, Eip1193Provider } from '../../lib/types'
import { captureWallet, type ActionWallet } from '../../lib/wallet-action'
import { accountActions } from './account-actions.svelte'

type BlockSetup = { gate: Address; registry: Address; list: string; id: `0x${string}` }

export function blockSetup(chain: ChainInfo): BlockSetup | null {
  const b = chain.blocking
  if (!b) return null
  return { gate: b.gate, registry: b.registry, list: b.list, id: keccak256(stringToBytes(b.list)) }
}

/** Feed and notification queries exclude this list on the source chain, regardless of
 * whether the reader currently uses the suggested reply gate. */
export function readerBlocklist(chain: Pick<ChainInfo, 'blocklist'>, owner: Address): List | undefined {
  const setup = chain.blocklist
  return setup ? { registry: setup.registry, list: keccak256(stringToBytes(setup.list)), owner } : undefined
}

/** Is `address` on the reader's block list? */
export async function isBlocked(chain: ChainInfo, me: Address, address: Address): Promise<boolean> {
  const list = readerBlocklist(chain, me)
  if (!list) return false
  return contains(chain, { registry: list.registry, id: list.list, owner: me }, address)
}

type BlockOutcome = { indexed: boolean; gateSet: 'already' | 'set' | 'custom' | 'keys-only' | 'deactivated' }

/**
 * Block `address`: add it to the reader's list, then make sure the reader's
 * author gate enforces the list. An author gate already pointing elsewhere is
 * left alone (the reader chose it) and reported.
 */
export async function block(provider: Eip1193Provider, me: Address, chain: ChainInfo, address: Address, onSent?: (hash: Hex) => void): Promise<BlockOutcome> {
  const setup = blockSetup(chain)
  if (!setup) throw new Error('this host suggests no blocking setup for this chain')
  const { indexed } = await writeList(provider, me, chain, { registry: setup.registry, owner: me, id: setup.id }, 'add', [address], onSent)
  const current = await authorGate(chain, me)
  if (current === TOMBSTONE) return { indexed, gateSet: 'deactivated' }
  const kind = replyGateKind(chain, current)
  if (kind === 'blocklist' || kind === 'keys-blocklist') return { indexed, gateSet: 'already' }
  if (kind === 'keys') return { indexed, gateSet: 'keys-only' }
  if (current !== zeroAddress) return { indexed, gateSet: 'custom' }
  const landed = await setAuthorGate(provider, me, chain, setup.gate, undefined, onSent)
  ledger.settleAuthor(chain, me, setup.gate, landed)
  return { indexed, gateSet: 'set' }
}

export async function unblock(provider: Eip1193Provider, me: Address, chain: ChainInfo, address: Address, onSent?: (hash: Hex) => void): Promise<{ indexed: boolean }> {
  const setup = blockSetup(chain)
  if (!setup) throw new Error('this host suggests no blocking setup for this chain')
  return writeList(provider, me, chain, { registry: setup.registry, owner: me, id: setup.id }, 'remove', [address], onSent)
}

/**
 * The second step of a block that stopped after its list write: point the
 * reader's unset author gate at the shared gate that reads the list. Asked for
 * by the reader, never sent by a check. A rule the reader chose is left alone.
 */
export async function enforceBlocks(wallet: ActionWallet, chain: ChainInfo): Promise<'set' | 'switched'> {
  const setup = blockSetup(chain)
  if (!setup) throw new Error('this host suggests no blocking setup for this chain')
  const pressed = captureWallet(wallet)
  if (!pressed) return 'switched'
  return accountActions.run(chain, pressed.account, async (sent): Promise<'set' | 'switched'> => {
    await wallet.ensureChain(chain)
    if (!pressed.current()) return 'switched'
    if (await authorGate(chain, pressed.account) !== zeroAddress) throw new Error('your account rule is set already. change it in settings')
    const landed = await setAuthorGate(pressed.provider, pressed.account, chain, setup.gate, undefined, sent)
    ledger.settleAuthor(chain, pressed.account, setup.gate, landed)
    return 'set'
  })
}

/** What a press of the block control did: nothing, when the wallet moved to another account or provider while the chain was checked. */
type BlockPress = { kind: 'blocked'; gateSet: BlockOutcome['gateSet']; indexed: boolean } | { kind: 'unblocked'; indexed: boolean } | { kind: 'switched' }

/**
 * One press of the block control. `wanted` is the state the reader asked
 * for, decided before anything was awaited, and the account and provider are
 * taken at the press too. The chain is checked first; if the wallet has moved
 * to another account or provider by then, nothing is sent and the reader is
 * told, so a press never acts for one account on the state shown for another.
 */
export async function pressBlock(wallet: ActionWallet, chain: ChainInfo, address: Address, wanted: boolean): Promise<BlockPress> {
  const pressed = captureWallet(wallet)
  if (!pressed) return { kind: 'switched' }
  const { provider, account } = pressed
  // Blocking may send twice (the list, then the gate): the latest hash is the one kept.
  return accountActions.run(chain, account, async (sent): Promise<BlockPress> => {
    await wallet.ensureChain(chain)
    if (!pressed.current()) return { kind: 'switched' }
    if (!wanted) {
      const { indexed } = await unblock(provider, account, chain, address, sent)
      return { kind: 'unblocked', indexed }
    }
    const r = await block(provider, account, chain, address, sent)
    return { kind: 'blocked', gateSet: r.gateSet, indexed: r.indexed }
  })
}

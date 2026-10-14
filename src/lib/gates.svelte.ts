// Gates are host snapshots followed by its ordered change stream. The host
// owns chain ordering; the client compares sequence numbers, never RPC heads.
// A local receipt can briefly lead the accepted index. Its overlay disappears
// when an indexed snapshot covers that block.
//
// A ledger that can no longer follow (the host no longer keeps its position,
// or catching up would take more pages than a refresh may spend) forgets what
// it knew, since any of it may have changed in the stretch it skips, keeps
// this browser's own receipts, and starts again from the host's head. Only
// that head read, asked for after the position was lost, may move the ledger
// to another history: any other answer carrying another generation may come
// from a request that started before or after a rebuild, and is refused.
import { sharedRead } from '../shared/shared-read'
import { SvelteMap } from 'svelte/reactivity'
import type { Address } from 'viem'
import { ApiError, afterChanges, changePages, checkChanges, integer, positionLost, record, snapshots, type At, type Changes, type RecordImage } from './api'
import type { ChainInfo } from './types'

type Known = { gate: Address; sequence: bigint; block: bigint }
type Landed = { block: bigint; index: number | null }
type Receipt = Landed & { gate: Address }
class Ledger {
  messages = new SvelteMap<bigint, Known>()
  authors = new SvelteMap<string, Known>()
  messageReceipts = new SvelteMap<bigint, Receipt>()
  authorReceipts = new SvelteMap<string, Receipt>()
  at: At | null = null
  /** The history followed, kept while the position is lost. */
  generation: At['generation'] | null = null
  /** The position was lost: the next advance reads the host's head, until one read succeeds. */
  lost = false
  through = 0n
  baseline = 0n
  reading = new Map<string, Promise<void>>()
  advancing: Promise<void> | null = null
}
// Readers observe ledger creation as well as later changes, without creating
// reactive state inside the derived value that needs to observe it.
const ledgers = new SvelteMap<string, Ledger>()
const chainKey = (chain: ChainInfo) => `${chain.id}:${chain.contract.toLowerCase()}`
const ledgerOf = (chain: ChainInfo) => {
  const key = chainKey(chain)
  let ledger = ledgers.get(key)
  if (!ledger) { ledger = new Ledger(); ledgers.set(key, ledger) }
  return ledger
}
const authorKey = (address: Address) => address.toLowerCase()
const blockOf = (at: At) => at.checkpoint ? integer(at.checkpoint.block) : 0n

function check(l: Ledger, at: At, head = false) {
  if (!/^0x[0-9a-f]{64}$/.test(at.generation)) throw new ApiError(409, 'reset_required')
  integer(at.sequence)
  if (l.generation !== null && l.generation !== at.generation) {
    if (!head) throw new ApiError(409, 'reset_required')
    forget(l)
  }
  l.generation = at.generation
  if (!l.at) { l.at = at; l.through = blockOf(at); l.baseline = integer(at.sequence); l.lost = false }
  return integer(at.sequence) >= l.baseline
}
/** Known gates no longer hold: another history, or a skipped stretch of this one. Receipts stay. */
function forget(l: Ledger) {
  l.messages.clear()
  l.authors.clear()
  l.at = null
}
function learn<K>(map: SvelteMap<K, Known>, key: K, gate: Address, sequence: bigint, block: bigint) {
  if ((map.get(key)?.sequence ?? -1n) <= sequence) map.set(key, { gate, sequence, block })
}
/**
 * A read fills in what the ledger does not know. A known gate moves only by the
 * change log, which refreshes follow, or by this reader's own receipt, which a
 * read covering its block confirms: a read never changes a card already shown.
 */
function fill<K>(map: SvelteMap<K, Known>, receipts: SvelteMap<K, Receipt>, key: K, gate: Address, sequence: bigint, block: bigint) {
  const confirms = (receipts.get(key)?.block ?? (block + 1n)) <= block
  if (!map.has(key) || confirms) learn(map, key, gate, sequence, block)
  expire(receipts, key, block)
}
function current<K>(map: SvelteMap<K, Known>, receipts: SvelteMap<K, Receipt>, key: K): Address | undefined {
  return receipts.get(key)?.gate ?? map.get(key)?.gate
}
function expire<K>(receipts: SvelteMap<K, Receipt>, key: K, block: bigint) {
  if ((receipts.get(key)?.block ?? (block + 1n)) <= block) receipts.delete(key)
}
function settle<K>(l: Ledger, map: SvelteMap<K, Known>, receipts: SvelteMap<K, Receipt>, key: K, gate: Address, landed: Landed) {
  if (landed.block <= l.through || landed.block <= (map.get(key)?.block ?? -1n)) return
  const old = receipts.get(key)
  if (!old || landed.block > old.block || (landed.block === old.block && (landed.index ?? -1) >= (old.index ?? -1))) receipts.set(key, { ...landed, gate })
}

class Gates {
  message(chain: ChainInfo, id: bigint): Address | undefined {
    const l = ledgers.get(chainKey(chain))
    return l ? current(l.messages, l.messageReceipts, id) : undefined
  }
  author(chain: ChainInfo, author: Address): Address | undefined {
    const l = ledgers.get(chainKey(chain))
    return l ? current(l.authors, l.authorReceipts, authorKey(author)) : undefined
  }
  /** The history this chain's ledger follows, once it has seen one. */
  generation(chain: ChainInfo): At['generation'] | null {
    return ledgers.get(chainKey(chain))?.generation ?? null
  }

  /** Every page already carries its records' gates; no per-card reads follow. */
  observe(chain: ChainInfo, at: At, records: RecordImage[]) {
    const l = ledgerOf(chain)
    if (!check(l, at)) return false
    const sequence = integer(at.sequence), block = blockOf(at)
    for (const r of records) {
      fill(l.messages, l.messageReceipts, r.id, r.gate, sequence, block)
      fill(l.authors, l.authorReceipts, authorKey(r.author), r.authorGate, sequence, block)
    }
    return true
  }

  ensureMessage(chain: ChainInfo, id: bigint): Promise<Address> {
    const l = ledgerOf(chain)
    if (this.message(chain, id) !== undefined) return Promise.resolve(this.message(chain, id)!)
    return sharedRead(l.reading, `m:${id}`, async () => {
      const answer = await this.snapshot(l, chain, [id])
      if (answer.items.length !== 1 || answer.items[0] === null) throw new ApiError(404, 'message_not_found')
      const found = record(answer.items[0]!)
      if (found.id !== id) throw new Error('host returned the wrong message')
      this.observe(chain, answer.at, [found])
    }).then(() => this.message(chain, id)!)
  }
  ensureAuthor(chain: ChainInfo, author: Address): Promise<Address> {
    const l = ledgerOf(chain), key = authorKey(author)
    if (this.author(chain, author) !== undefined) return Promise.resolve(this.author(chain, author)!)
    return sharedRead(l.reading, `a:${key}`, async () => {
      const answer = await this.snapshot(l, chain, [], [author])
      const found = answer.accounts[0]
      if (answer.accounts.length !== 1 || !found || authorKey(found.address) !== key) throw new Error('host returned the wrong account')
      fill(l.authors, l.authorReceipts, key, found.gate, integer(answer.at.sequence), blockOf(answer.at))
    }).then(() => this.author(chain, author)!)
  }
  private async snapshot(l: Ledger, chain: ChainInfo, ids: bigint[] = [], accounts: Address[] = []) {
    // A request started before this ledger's first snapshot may arrive after
    // it. Ask again rather than skipping changes before the ledger's baseline.
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await snapshots(chain, ids, accounts)
      if (check(l, answer.at)) return answer
    }
    throw new Error('the host snapshot is behind this view')
  }

  /** Apply a complete page of changes. A failed request never reaches here. */
  private apply(l: Ledger, answer: Changes) {
    check(l, answer.at)
    if (!answer.gates) throw new Error('the refresh did not include gate changes')
    checkChanges(l.at!, answer)
    for (const change of answer.changes) {
      if (change.event.kind !== 'chain') continue
      const event = change.event.event, sequence = integer(change.sequence)
      if (event.kind === 'reply_gate') {
        learn(l.messages, integer(event.id), event.new, sequence, integer(event.position.block))
      } else if (event.kind === 'author_gate') {
        learn(l.authors, authorKey(event.author), event.new, sequence, integer(event.position.block))
      }
    }
    l.at = afterChanges(l.at!, answer)
    if (!answer.more) {
      l.through = blockOf(answer.until)
      for (const key of l.messageReceipts.keys()) expire(l.messageReceipts, key, l.through)
      for (const key of l.authorReceipts.keys()) expire(l.authorReceipts, key, l.through)
    }
  }

  /** A page can deliver the changes it already fetched instead of asking twice. */
  follow(chain: ChainInfo, from: At, answer: Changes): boolean {
    if (!answer.gates) return false
    const l = ledgerOf(chain)
    check(l, from)
    const cursor = integer(l.at!.sequence)
    if (cursor < integer(from.sequence)) return false
    if (cursor > integer(answer.through)) return true
    this.apply(l, { ...answer, changes: answer.changes.filter((c) => integer(c.sequence) > cursor) })
    return true
  }

  /** Only explicit refreshes call this; quiet polls inspect without applying. */
  advanceToHead(chain: ChainInfo): Promise<void> {
    const l = ledgerOf(chain)
    if (!l.at && !l.lost) return Promise.resolve()
    if (!l.advancing) {
      l.advancing = (async () => {
        if (l.at) {
          try {
            for await (const { from, answer } of changePages(chain, l.at!)) this.follow(chain, from, answer)
            return
          } catch (error) {
            if (!positionLost(error)) throw error
            forget(l)
            l.lost = true
          }
        }
        // Asked for after the position was lost, the head is the one answer
        // that may move this ledger to a rebuilt history.
        check(l, (await snapshots(chain)).at, true)
      })().finally(() => { l.advancing = null })
    }
    return l.advancing
  }
  settleMessage(chain: ChainInfo, id: bigint, gate: Address, landed: Landed) {
    const l = ledgerOf(chain)
    settle(l, l.messages, l.messageReceipts, id, gate, landed)
  }
  settleAuthor(chain: ChainInfo, author: Address, gate: Address, landed: Landed) {
    const l = ledgerOf(chain)
    settle(l, l.authors, l.authorReceipts, authorKey(author), gate, landed)
  }
}
export const gates = new Gates()

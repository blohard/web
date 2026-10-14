// Display reads use host indexes. Each card keeps its result until explicit refresh.
import { hasResponseRight } from '../../lib/board'
import { getMessage } from '../../lib/messages'
import type { Address } from 'viem'
import { gates as ledger } from '../../lib/gates.svelte'
import { sharedRead } from '../../shared/shared-read'
import { isBlocked } from '../account/blocking'
import { sameAddress } from '../../lib/format'
import { integer, request, type At } from '../../lib/api'
import { replyGateKind } from '../publishing/reply-rules'
import type { ChainInfo, Posted } from '../../lib/types'

export type Verdict = 'shown' | 'folded'
type Ask = { creator: Address; holder: Address; block: bigint; resolve: (held: boolean | null) => void; reject: (error: unknown) => void }
const queued = new Map<string, Ask[]>()
function holds(chain: ChainInfo, gate: Address, creator: Address, holder: Address, block: bigint): Promise<boolean | null> {
  const key = `${chain.id}:${chain.contract}:${gate}`.toLowerCase()
  let asks = queued.get(key)
  if (!asks) {
    asks = []; queued.set(key, asks)
    const pending = asks
    queueMicrotask(() => {
      queued.delete(key)
      for (let start = 0; start < pending.length; start += 50) void send(chain, gate, pending.slice(start, start + 50))
    })
  }
  return new Promise((resolve, reject) => asks.push({ creator, holder, block, resolve, reject }))
}
async function send(chain: ChainInfo, gate: Address, asks: Ask[]) {
  try {
    const result = await request<{ checkpoint: At['checkpoint']; held: boolean[] }>(chain, 'key-holdings', {
      gate, pairs: asks.map(({ creator, holder }) => ({ creator, holder })),
    })
    if (!Array.isArray(result.held) || result.held.length !== asks.length || result.held.some(v => typeof v !== 'boolean')) throw new Error('invalid holdings answer')
    const block = integer(result.checkpoint?.block ?? '')
    // The key index can lag the Board even while both are healthy.
    asks.forEach((ask, i) => ask.resolve(block >= ask.block ? result.held[i] : null))
  } catch (error) { asks.forEach(ask => ask.reject(error)) }
}
class Gating {
  // Only in-flight reads are shared. Mounted cards own the lasting verdicts.
  private blocks = new Map<string, Promise<boolean>>()
  private checks = new Map<string, Promise<Verdict>>()
  async check(chain: ChainInfo, reply: Pick<Posted, 'parentId' | 'author' | 'blockNumber'>, parentAuthor: Address): Promise<Verdict> {
    if (reply.parentId === 0n) return 'shown'
    if (hasResponseRight(await getMessage(chain, reply.parentId), reply.author)) return 'shown'
    // The author's list controls display regardless of which gate admitted the reply.
    const blockKey = `${chain.id}:${chain.contract.toLowerCase()}:${chain.blocklist?.registry.toLowerCase()}:${chain.blocklist?.list}:${parentAuthor.toLowerCase()}:${reply.author.toLowerCase()}`
    // Start the remaining checks together. A blocked, unprotected reply folds
    // even if key holdings fail; an unreadable blocklist is the failure reported.
    const blocked = sharedRead(this.blocks, blockKey, () => isBlocked(chain, parentAuthor, reply.author))
    const byGate = this.byGate(chain, reply, parentAuthor)
    byGate.catch(() => {})
    if (await blocked) return 'folded'
    return await byGate
  }
  private async byGate(chain: ChainInfo, reply: Pick<Posted, 'parentId' | 'author' | 'blockNumber'>, parentAuthor: Address): Promise<Verdict> {
    // Per-post gates govern new replies only. Account rules govern historical display.
    const gate = await ledger.ensureAuthor(chain, parentAuthor)
    const kind = replyGateKind(chain, gate)
    if (kind !== 'keys' && kind !== 'keys-blocklist') return 'shown'
    if (sameAddress(parentAuthor, reply.author)) return 'shown'
    const key = `${chain.id}:${chain.contract}:${gate}:${parentAuthor}:${reply.author}:${reply.blockNumber}`.toLowerCase()
    return await sharedRead(this.checks, key, async (): Promise<Verdict> => {
      const held = await holds(chain, gate, parentAuthor, reply.author, reply.blockNumber)
      if (held === null) throw new Error('key holdings have not caught up to this reply')
      return held ? 'shown' : 'folded'
    })
  }
}
export const gating = new Gating()

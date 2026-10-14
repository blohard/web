import { flushSync } from 'svelte'
import type { Address } from 'viem'
import { postReplyRuleView } from '../../post-reply-rule-view.svelte'
import { wallet } from '../../../../lib/wallet.svelte'

export { flushSync }
const address = (byte: string) => `0x${byte.repeat(20)}` as Address
export const gates = { zero: address('00'), block: address('b1'), keys: address('b2'), closed: address('b3') }
const alice = address('a1'), bob = address('b0')

/** The picker for alice's draft, or her post when given its id, with its network reads replaced by counters and switches. */
export function picker(save: (gate: Address) => void | Promise<void>, postId: bigint | null = null) {
  wallet.account = alice
  const chain = {
    id: 1, contract: address('c1'), name: 'test', rpc_url: 'https://rpc.example.test',
    blocking: { gate: gates.block, registry: address('d1'), list: 'blocked' },
    closed_gate: gates.closed, key_gates: { holders_blocklist: gates.keys },
  } as never
  let owner = $state(alice), gate = $state(gates.zero), disabled = $state(false)
  let status = $state('active'), matching = $state(true), blocked = $state(false)
  let reads = 0, keyReads = 0
  let failReads = false
  const fakes = {
    authorGate: async () => { reads++; if (failReads) throw Error("network unavailable"); return gates.block },
    hasBlockedAccounts: async () => blocked,
    keyReplyDeployment: () => (matching ? {} : null),
    accountKeyStatus: (input: () => { enabled?: boolean }) => {
      $effect(() => { if (input().enabled) keyReads++ })
      return { get state() { return input().enabled ? status : 'unavailable' } }
    },
  } as never
  let view!: ReturnType<typeof postReplyRuleView>
  const stop = $effect.root(() => {
    view = postReplyRuleView(() => ({ chain, address: owner, gate, postId, disabled, onsave: save }), fakes)
  })
  return {
    failReads() { failReads = true },
    get readFailed() { return view.readFailed },
    setGate(next: Address) { gate = next },
    setDisabled(next: boolean) { disabled = next },
    open() { view.toggle() },
    choose: (choice: string) => view.choose(choice),
    /** Another author's picker in the same place: alice may not use it. */
    change() { owner = bob },
    setStatus(next: string) { status = next },
    mismatch() { matching = false },
    label(next: Address, isBlocked: boolean) { gate = next; blocked = isBlocked; view.refresh() },
    get summary() { return view.summary },
    get detail() { return view.detail },
    get state() { return { reads, keyReads, selected: view.selected, note: view.note, busy: view.busy, available: view.keysAvailable } },
    stop,
  }
}

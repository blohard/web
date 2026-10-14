import { flushSync } from 'svelte'
import type { Address } from 'viem'
import { accountActivationView, authorGateView } from '../../author-gate-view.svelte'

export { flushSync }
const address = (byte: string) => `0x${byte.repeat(20)}` as Address
const alice = address('a1'), bob = address('b0'), blocklist = address('b1'), keys = address('b2')
const chainFor = (id: number) => ({
  id, contract: address('c1'), name: 'test', rpc_url: 'https://rpc.example.test',
  blocking: { gate: blocklist, registry: address('d1'), list: 'blocked' }, key_gates: { holders_blocklist: keys },
}) as never

/** Both settings controllers with their reads stubbed; `save` stands in for the wallet transaction. */
function controls(save: () => Promise<void>) {
  let owner = $state(alice), chainId = $state(1)
  const chain = $derived(chainFor(chainId))
  const deps = {
    readAuthorGate: async () => blocklist,
    hasBlockedAccounts: async () => false,
    saveAuthorGate: save,
    keyReplyDeployment: () => ({}),
    gate: () => blocklist,
    confirm: () => true,
  } as never
  return {
    deps, change(next: Address, id: number) { owner = next; chainId = id },
    get chain() { return chain }, get owner() { return owner },
  }
}

const people = { alice, bob }
export function Settings(save: () => Promise<void>) {
  const c = controls(save)
  let view!: ReturnType<typeof accountActivationView>
  const stop = $effect.root(() => { view = accountActivationView(() => ({ chain: c.chain, address: c.owner, refreshRevision: 0 }), c.deps) })
  return {
    act: () => view.changeActivation(),
    change: (who: 'alice' | 'bob', id: number) => c.change(people[who], id),
    get note() { return view.note }, get selected() { return view.deactivated }, stop,
  }
}
export function AuthorGate(save: () => Promise<void>) {
  const c = controls(save)
  let view!: ReturnType<typeof authorGateView>
  const stop = $effect.root(() => {
    view = authorGateView(() => ({ chain: c.chain, address: c.owner, keyStatus: 'active', blocklistEmpty: false, loading: false, failed: false }), c.deps)
  })
  return {
    act: () => view.choose('keys'),
    change: (who: 'alice' | 'bob', id: number) => c.change(people[who], id),
    get note() { return view.note }, get selected() { return view.selected }, stop,
  }
}

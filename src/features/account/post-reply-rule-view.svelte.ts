// The state behind a post's reply-rule picker (features/account/PostReplyRule.svelte):
// what the closed button says, which choices are open, and the save in flight.
// Reads wait until the picker is opened; answers, pending choices and notes
// belong to one chain, author and post, so none carries over to another.
import { untrack } from 'svelte'
import type { Address } from 'viem'
import { accountKeyStatus } from '../keys/account-key-status.svelte'
import { keyReplyDeployment } from '../keys/account-keys-config'
import { hasBlockedAccounts } from './author-gate'
import { authorGate } from '../../lib/board'
import { host } from '../../lib/host.svelte'
import { accountReplyLabel, postGateForChoice, postReplyChoice, replyRuleLabel } from '../publishing/reply-rules'
import { Resource } from '../../shared/resource.svelte'
import { ScopedAction } from '../../lib/scoped-action.svelte'
import type { ChainInfo } from '../../lib/types'
import { wallet } from '../../lib/wallet.svelte'

export type PostReplyRuleInput = {
  chain: ChainInfo
  address: Address
  gate: Address
  postId: bigint | null
  disabled: boolean
  onsave: (gate: Address, onProgress?: (note: string) => void) => void | Promise<void>
}

/** The reads the picker makes; tests pass their own. */
export const postReplyRuleReads = { authorGate, hasBlockedAccounts, keyReplyDeployment, accountKeyStatus }

export function postReplyRuleView(input: () => PostReplyRuleInput, reads = postReplyRuleReads) {
  const props = $derived(input())
  const chain = $derived(props.chain)
  const address = $derived(props.address)
  const visible = $derived(wallet.is(props.address))
  const identity = $derived(`${props.chain.id}:${props.chain.contract}:${props.address}:${props.postId ?? 'draft'}`.toLowerCase())
  let openFor = $state<string | null>(null)
  const opened = $derived(openFor === identity)
  let retry = $state(0)
  const read = new Resource<{ gate: Address; blocked: boolean | null }>()
  const query = $derived.by(() => {
    const c = chain, owner = address
    void retry
    return visible && opened ? untrack(() => Promise.all([
      reads.authorGate(c, owner), reads.hasBlockedAccounts(c, owner).catch(() => null),
    ]).then(([gate, blocked]) => ({ gate, blocked }))) : null
  })
  $effect(() => { if (query) return read.watch(query, identity) })
  const keyRuleAvailable = $derived(reads.keyReplyDeployment(props.chain, host.keyring(props.chain.id)) !== null)
  const keys = reads.accountKeyStatus(() => ({ chain, address, reloadRevision: retry,
    enabled: visible && opened && keyRuleAvailable }))
  const keysAvailable = $derived(keyRuleAvailable && keys.state === 'active')
  const empty = $derived(read.value(identity)?.blocked === false)
  const current = $derived(postReplyChoice(props.chain, props.gate))
  const inherited = $derived(accountReplyLabel(props.chain, read.value(identity)?.gate, empty))
  const action = new ScopedAction<string>(() => identity)
  const selected = $derived(action.pending ?? current)
  /** What follows "reply rule" on the closed picker, once it is known. */
  const detail = $derived.by(() => {
    const known = read.value(identity)
    if (current === 'default') return known ? inherited : null
    if (current === 'other') return 'custom'
    return replyRuleLabel(current, known?.blocked !== true)
  })
  const summary = $derived(detail === null ? 'reply rule' : `reply rule · ${detail}`)

  async function choose(choice: string) {
    const { chain, disabled, onsave, postId } = props
    if (action.busy || disabled || read.pending || read.failure(identity) || choice === current) return
    if (choice !== 'default' && choice !== 'all' && choice !== 'keys' && choice !== 'closed') return
    if ((choice === 'keys' && !keysAvailable) || (choice === 'all' && !chain.blocking) || (choice === 'closed' && !chain.closed_gate)) return
    // A draft's choice shows in the picker at once. A post's change is a transaction, so its landing is confirmed.
    await action.run(choice, progress => onsave(postGateForChoice(chain, choice), progress),
      postId === null ? null : 'reply rule saved')
  }

  return {
    get visible() { return visible },
    get opened() { return opened },
    toggle() { openFor = opened ? null : identity },
    get summary() { return summary },
    get detail() { return detail },
    get current() { return current },
    get selected() { return selected },
    get inherited() { return inherited },
    get empty() { return empty },
    get keyRuleAvailable() { return keyRuleAvailable },
    get keysAvailable() { return keysAvailable },
    get keysFailed() { return keyRuleAvailable && keys.state === 'failed' },
    get loading() { return read.pending },
    get readFailed() { return read.failure(identity) !== null },
    get busy() { return action.busy },
    /** A save for this picker is running: what it is waiting on is told by `note` or the wallet. */
    get saving() { return action.running },
    get note() { return action.note },
    choose,
    refresh() { retry++ },
  }
}

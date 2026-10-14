// The state behind the account-wide reply rule in settings: one read of the
// rule and the blocklist that both cards share (features/account/Settings.svelte),
// deactivation (the same card), and the rule choice
// (features/account/AuthorGate.svelte). Pending choices and notes belong to one
// chain and account, so a late answer never annotates another.
import { untrack } from 'svelte'
import type { Address } from 'viem'
import { keyReplyDeployment } from '../keys/account-keys-config'
import type { KeyStatus } from '../keys/account-key-status.svelte'
import { hasBlockedAccounts, readAuthorGate, saveAuthorGate } from './author-gate'
import { TOMBSTONE } from '../../lib/board'
import { chainLabel } from '../../lib/chains'
import { sameAddress } from '../../lib/format'
import { gates } from '../../lib/gates.svelte'
import { host } from '../../lib/host.svelte'
import { authorGateChoice } from '../publishing/reply-rules'
import { Resource } from '../../shared/resource.svelte'
import { ScopedAction } from '../../lib/scoped-action.svelte'
import type { ChainInfo } from '../../lib/types'
import { wallet } from '../../lib/wallet.svelte'

/** What the cards read and write; tests pass their own. */
export const authorGateDeps = {
  readAuthorGate, hasBlockedAccounts, saveAuthorGate, keyReplyDeployment,
  gate: (chain: ChainInfo, address: Address) => gates.author(chain, address),
  confirm: (message: string) => window.confirm(message),
}

/** Settings' read, shared with the rule card, and the account's activation. */
export function accountActivationView(input: () => { chain: ChainInfo; address: Address | null; refreshRevision: number }, deps = authorGateDeps) {
  const props = $derived(input())
  const identity = $derived(`${props.chain.id}:${props.chain.contract}:${props.address}`.toLowerCase())
  // One read serves both cards: the account rule, and whether the blocklist has
  // entries, which only words the reply choices.
  const read = new Resource<boolean | null>()
  let retry = $state(0)
  const query = $derived.by(() => {
    const { chain, address: owner, refreshRevision } = props
    void refreshRevision
    void retry
    return untrack(() => owner ? Promise.all([
      deps.readAuthorGate(chain, owner),
      deps.hasBlockedAccounts(chain, owner).catch(() => null),
    ]).then(([, blocked]) => blocked) : Promise.resolve(null))
  })
  $effect(() => read.watch(query, identity))
  const failed = $derived(!!read.failure(identity))
  const current = $derived(props.address ? deps.gate(props.chain, props.address) : undefined)
  const deactivated = $derived(current !== undefined && sameAddress(current, TOMBSTONE))
  const action = new ScopedAction(() => identity)

  async function changeActivation() {
    const { chain, address } = props
    if (action.busy || !address || !current || read.pending || failed) return
    const reactivate = deactivated
    if (!reactivate && !deps.confirm(`deactivate your account on ${chainLabel(chain)}?\n\nposts that use your account rule will show as deactivated and close to ordinary replies. the author you replied to can still respond. posts with their own gate keep that rule. deactivation is reversible in settings.`)) return
    await action.run(undefined, progress => deps.saveAuthorGate(wallet, chain, address, reactivate ? 'all' : 'deactivated', progress),
      reactivate ? 'account reactivated' : 'account deactivated', 'check your wallet…')
  }

  return {
    get loading() { return read.pending },
    get failed() { return failed },
    /** The blocklist is known to have no entries, so choices need not say "except blocked". */
    get blocklistEmpty() { return read.value(identity) === false },
    get current() { return current },
    get deactivated() { return deactivated },
    get busy() { return action.busy },
    get note() { return action.note },
    changeActivation,
    retry() { retry++ },
  }
}

/** The account-wide rule choice, given the shared read's state. */
export function authorGateView(input: () => {
  chain: ChainInfo; address: Address; keyStatus: KeyStatus; blocklistEmpty: boolean; loading: boolean; failed: boolean
}, deps = authorGateDeps) {
  const props = $derived(input())
  const identity = $derived(`${props.chain.id}:${props.chain.contract}:${props.address}`.toLowerCase())
  const current = $derived(deps.gate(props.chain, props.address))
  const currentChoice = $derived(current ? authorGateChoice(props.chain, current, props.blocklistEmpty) : 'other')
  // The pending selection belongs to this account, chain and original gate.
  const action = new ScopedAction<{ from: Address; choice: 'all' | 'keys' }>(() => identity)
  const selected = $derived(action.pending && action.pending.from === current ? action.pending.choice : currentChoice)
  const keyRuleAvailable = $derived(deps.keyReplyDeployment(props.chain, host.keyring(props.chain.id)) !== null)
  const keysAvailable = $derived(keyRuleAvailable && props.keyStatus === 'active')

  async function choose(choice: string) {
    const { chain, address, loading, failed } = props
    if (action.busy || !current || loading || failed) return
    if ((choice !== 'all' && choice !== 'keys') || choice === currentChoice) return
    if ((choice === 'keys' && !keysAvailable) || (choice === 'all' && !chain.blocking)) return
    await action.run({ from: current, choice }, progress => deps.saveAuthorGate(wallet, chain, address, choice, progress), 'reply rule saved')
  }

  return {
    get current() { return current },
    get currentChoice() { return currentChoice },
    get selected() { return selected },
    get keyRuleAvailable() { return keyRuleAvailable },
    get keysAvailable() { return keysAvailable },
    get busy() { return action.busy },
    /** A save for this account and chain is running. */
    get saving() { return action.running },
    get note() { return action.note },
    choose,
  }
}

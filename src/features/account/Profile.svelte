<script lang="ts">
  import { sameAddress } from '../../lib/format'
  import Loading from '../../shared/Loading.svelte'
  import { loadingDelay } from '../../shared/loading-delay.svelte'
  // A profile: who someone is by address and name, the follow, mute and block
  // controls, and their posts and replies as two tabs of the feed.
  import { untrack } from 'svelte'
  import type { Address } from 'viem'
  import { accountKeyStatus } from '../keys/account-key-status.svelte'
  import { keyDeployment } from '../keys/account-keys-config'
  import { blockSetup, enforceBlocks, isBlocked, pressBlock } from './blocking'
  import { gates as ledger } from '../../lib/gates.svelte'
  import { accountActions } from './account-actions.svelte'
  import UnsettledChange from '../../components/UnsettledChange.svelte'
  import { explain } from '../../lib/errors'
  import type { Filter } from '../streams/feed-policy'
  import { follows } from '../../lib/follows.svelte'
  import { muted } from '../../lib/muted.svelte'
  import type { ChainInfo } from '../../lib/types'
  import { wallet } from '../../lib/wallet.svelte'
  import AccountKeyBadge from '../keys/AccountKeyBadge.svelte'
  import AccountIdentity from '../../components/AccountIdentity.svelte'
  import { Resource } from '../../shared/resource.svelte'
  import { router, href } from '../navigation/router.svelte'
  import Feed from '../streams/Feed.svelte'
  import { host } from '../../lib/host.svelte'
  import { saveHostList } from '../../lib/host-policy'

  let { chain, address, refreshRevision = 0 }: { chain: ChainInfo; address: Address; refreshRevision?: number } = $props()

  // Without a wallet the host's keyring index says whether the account has keys, with no chain read.
  const keys = accountKeyStatus(() => ({ chain, address, reloadRevision: refreshRevision, enabled: wallet.account !== null, indexed: host.keyringMarket(chain.id) }))
  // Holding another account's keys does not require activating your own market.
  let deployment = $derived(keyDeployment(chain))
  let keysAvailable = $derived(keys.active || (!!deployment && host.keyringMarket(chain.id)?.toLowerCase() === deployment.address.toLowerCase()))
  let keysSelected = $derived(router.route.kind === 'user' && router.route.keys === true)
  const keysSpinner = loadingDelay(() => keysSelected ? `${chain.id}/${chain.contract}/${address}/${wallet.account}` : null)
  let tab = $derived(router.route.kind === 'user' && router.route.replies ? 'replies' : 'posts')

  let mine = $derived(wallet.is(address))
  let hostBlocked = $derived(host.blocked(address))
  let setup = $derived(blockSetup(chain))
  /** Whether the reader has blocked this account, read from indexed membership on refresh; a block or unblock made here is known at once. */
  const blocked = new Resource<boolean>()
  let blockKey = $derived(`${chain.id}/${wallet.account}/${address}`)
  let blockRetry = $state(0)
  let blockQuery = $derived.by(() => {
    void refreshRevision
    void blockRetry
    return setup && wallet.account && !mine ? isBlocked(chain, wallet.account, address) : null
  })
  $effect(() => {
    if (blockQuery) return blocked.watch(blockQuery, blockKey)
  })
  let blockedState = $derived(blockQuery ? blocked.value(blockKey) : null)
  let blockReadFailed = $derived(blockQuery !== null && blocked.failure(blockKey) !== null)
  let blockBusy = $state(false)
  /** The reader's own account change whose receipt never came: blocking waits for it. */
  let accountChange = $derived(wallet.account ? accountActions.unsettled(chain, wallet.account) : null)
  /** The reader's own account rule, from the shared gate ledger. */
  let myGate = $derived(setup && wallet.account ? ledger.author(chain, wallet.account) : undefined)
  $effect(() => {
    const me = wallet.account
    if (setup && me && blockedState) untrack(() => { void ledger.ensureAuthor(chain, me).catch(() => {}) })
  })
  /**
   * Blocked on the list, but no rule enforces it: a block that stopped after
   * its list write. Finishing it is the reader's press, never a check's.
   */
  let unenforced = $derived(blockedState === true && myGate !== undefined && myGate.toLowerCase() === '0x0000000000000000000000000000000000000000')
  let enforcing = $state(false)
  async function enforce() {
    enforcing = true
    blockNote = null
    try {
      const done = await enforceBlocks(wallet, chain)
      blockNote = done === 'switched'
        ? { ok: false, text: 'the wallet changed accounts while the chain was checked. nothing was sent' }
        : { ok: true, text: 'blocked. your author gate now enforces your list' }
    } catch (e) {
      blockNote = { ok: false, text: explain(e) }
    } finally {
      enforcing = false
    }
  }
  let blockNote = $state<{ ok: boolean; text: string } | null>(null)
  // The host admin can label an account a bot from its profile (design/BOT_LABELS.md).
  let hostAdmin = $derived(!!host.status?.host_policy && wallet.is(host.status.host_policy.admin))
  let labelledBot = $derived(host.status?.host_policy?.bots?.some(a => sameAddress(a, address)) ?? false)
  let botLabelBusy = $state(false)
  let botLabelNote = $state<{ ok: boolean; text: string } | null>(null)
  async function toggleBotLabel() {
    if (botLabelBusy) return
    botLabelBusy = true
    const add = !labelledBot
    botLabelNote = { ok: true, text: 'approve the list change in your wallet…' }
    try {
      await saveHostList(wallet, 'bots', add ? 'add' : 'remove', [address])
      botLabelNote = { ok: true, text: add ? 'labelled as a bot' : 'bot label removed' }
    } catch (e) { botLabelNote = { ok: false, text: explain(e) } }
    finally { botLabelBusy = false }
  }
  /** A blocked account's posts stay behind a line until asked for, as X does. */
  let revealed = $state(false)
  async function toggleBlock() {
    // What the reader asked for, and for whom, is fixed at the press
    // (features/account/blocking.ts pressBlock). The outcome settles and is reported only
    // while the page still shows that account: `key` names both.
    const key = blockKey
    const wanted = blockedState !== true
    if (wanted && !confirm(`block ${address}?\n\nthey can no longer reply to your posts, their earlier replies fold away, and they are muted here.`)) return
    blockBusy = true
    blockNote = null
    try {
      const done = await pressBlock(wallet, chain, address, wanted)
      if (done.kind === 'switched') {
        blockNote = { ok: false, text: 'the wallet changed accounts while the chain was checked. nothing was sent' }
        return
      }
      blocked.settle(key, done.kind === 'blocked')
      // Blocking implies not wanting to see them: mute locally too (unblocking leaves the mute to you).
      if (done.kind === 'blocked' && !muted.has(address)) muted.toggle(address)
      if (blockKey !== key) return
      blockNote = done.kind === 'unblocked'
        ? { ok: true, text: 'unblocked' }
        : {
            ok: done.gateSet !== 'custom' && done.gateSet !== 'keys-only',
            text: done.gateSet === 'deactivated' ? 'added to your blocklist. your account is deactivated' : done.gateSet === 'keys-only' ? 'on your list, but your key gate does not enforce blocks. use the combined key and blocklist gate to enforce both' : done.gateSet === 'custom' ? 'on your list, but your author gate points elsewhere, so the chain will not enforce it' : done.gateSet === 'set' ? 'blocked. your author gate now enforces your list' : 'blocked',
          }
      if (!done.indexed && blockNote) blockNote.text += '. confirmed on chain. some views may take longer to update'
    } catch (e) {
      if (blockKey === key) blockNote = { ok: false, text: explain(e) }
    } finally {
      blockBusy = false
    }
  }
  /** The reader's own replies show here too, under what they answer, so what they said on this profile is never hidden from them; on their own profile they are the author's already. */
  let viewer = $derived(wallet.account && !mine ? wallet.account : undefined)
  let filter = $derived<Filter>(tab === 'posts' ? { kind: 'author', address, viewer } : { kind: 'author-replies', address, viewer })
</script>

{#snippet loadingKeys()}
  {#if keysSpinner()}
    <div class="keys-loading"><Loading label="loading account keys…" overlay /></div>
  {/if}
{/snippet}

<section class="profile">
  <AccountIdentity {address}>
    <AccountKeyBadge {chain} {address} active={keys.active} />
    {#if chain.curated && host.curated(address)}<span class="badge" title="selected by this host">✓ curated</span>{/if}
    {#if mine}
      <span class="dim small">· you</span>
    {:else if blockedState}
      <span class="dim small">· blocked</span>
    {:else if muted.has(address)}
      <span class="dim small">· muted</span>
    {:else if follows.has(address)}
      <span class="dim small">· following</span>
    {/if}
  </AccountIdentity>
  {#if !mine}
    <div class="actions-col">
      <button disabled={!follows.has(address) && follows.full} onclick={() => follows.toggle(address)} title="adds their posts and replies to your following tab. stored in this browser only, and private to you">
        {follows.has(address) ? 'unfollow' : follows.full ? 'following limit reached (256)' : 'follow'}
      </button>
      <button class:danger={!muted.has(address)} onclick={() => muted.toggle(address)} title="stored in this browser only, and private to you">
        {muted.has(address) ? 'unmute' : 'mute'}
      </button>
      {#if setup && wallet.account}
        <button class:danger={!blockedState} onclick={toggleBlock} disabled={blockBusy || blockedState === null || accountChange !== null} title="on-chain. they can no longer reply to your posts, and their earlier replies fold">
          {blockBusy ? 'working…' : blockedState ? 'unblock' : 'block'}
        </button>
      {/if}
      {#if hostAdmin}
        <button onclick={toggleBotLabel} disabled={botLabelBusy} title="this host's own label, shown as a muted robot. the account's own statement is separate">
          {botLabelBusy ? 'working…' : labelledBot ? 'remove bot label' : 'label as bot'}
        </button>
      {/if}
    </div>
  {/if}
</section>
{#if hostBlocked}
  <p class="host-blocked dim">account blocked by host</p>
{/if}
{#if keys.state === 'failed'}
  <p class="small err">could not check account keys. <button onclick={keys.retry}>try again</button></p>
{/if}
{#if mine && keys.state === 'inactive'}
  <a class="activate-keys" href={href.keys(chain.id)}>[ activate keys ]</a>
{/if}
{#if blockReadFailed}
  <p class="small err">could not read your block list from the chain. <button onclick={() => blockRetry++}>try again</button></p>
{/if}
{#if blockNote}
  <p class="small" class:err={!blockNote.ok}>{blockNote.text}</p>
{/if}
{#if botLabelNote}
  <p class="small" role="status" class:err={!botLabelNote.ok}>{botLabelNote.text}</p>
{/if}
{#if unenforced && !accountChange && !mine}
  <p class="small">they are on your blocklist, but your account rule does not enforce it yet
    <button class="small" disabled={enforcing || blockBusy} onclick={enforce}>{enforcing ? 'working…' : 'enforce my blocklist'}</button></p>
{/if}
{#if accountChange && wallet.account && !mine}
  <UnsettledChange block what="your account" hash={accountChange} saved={accountActions.saved(chain, wallet.account!)} busy={accountActions.busy(chain, wallet.account)}
    check={() => accountActions.check(chain, wallet.account!)} clear={() => accountActions.clear(chain, wallet.account!)} onlanded={() => blockRetry++} />
{/if}

{#if !hostBlocked && blockedState && !revealed && !keysSelected}
  <p class="dim">
    you blocked this account.
    <button class="small" onclick={() => (revealed = true)}>show posts</button>
  </p>
{:else}
  {#if !hostBlocked || keysAvailable}
    <nav class="tabs page-tabs profile-tabs small" data-tab-row aria-label="profile sections">
      {#if !hostBlocked}
        <a data-page-tab class:active={!keysSelected && tab === 'posts'} aria-current={!keysSelected && tab === 'posts' ? 'page' : undefined} href={href.user(chain.id, address)}>posts</a>
        <a data-page-tab class:active={!keysSelected && tab === 'replies'} aria-current={!keysSelected && tab === 'replies' ? 'page' : undefined} href={href.userReplies(chain.id, address)}>replies</a>
      {/if}
      {#if keysAvailable}<a data-page-tab class:active={keysSelected} aria-current={keysSelected ? 'page' : undefined} href={href.userKeys(chain.id, address)}>keys</a>{/if}
    </nav>
  {/if}

  {#if keysSelected}
    <div class="keys-panel">
    {#await import('../keys/KeyMarket.svelte')}
      {@render loadingKeys()}
    {:then page}
      {#key `${chain.id}/${chain.contract}/${address}/${wallet.account}`}<page.default {chain} creator={address} {refreshRevision} loading={loadingKeys} />{/key}
    {:catch}
      <p class="err">could not load account keys. reload the page to try again.</p>
    {/await}
    </div>
  {:else if !hostBlocked}
    {#key `${chain.id}/${address}/${tab}/${viewer ?? ''}`}
      <Feed {chain} {filter} reloadRevision={refreshRevision} {refreshRevision} />
    {/key}
  {/if}
{/if}

<style>
  .keys-panel { position: relative; min-height: 6rem; }
  .keys-loading { position: absolute; top: 2rem; left: 0; width: 100%; }
  .host-blocked { text-align: center; }
  .activate-keys {
    display: flex; align-items: center; justify-content: center; min-height: 48px;
    margin: 0 0 1rem; padding: .7rem 1rem; border: 1px solid #95620b; border-radius: 3px;
    background: #f5bf35; color: #302000; font-weight: 600; text-decoration: none;
  }
  .activate-keys:hover { background: #ffd360; }
  .activate-keys:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  @media (max-width: 600px) {
    nav.profile-tabs a { padding-inline: .3rem; }
  }
</style>

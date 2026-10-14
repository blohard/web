<script lang="ts">
  import { keyControls } from '../keys/key-controls.svelte'
  import type { Address } from 'viem'
  import { keyDeployment } from '../keys/account-keys-config'
  import { accountKeyStatus } from '../keys/account-key-status.svelte'
  import { chainLabel } from '../../lib/chains'
  import { host } from '../../lib/host.svelte'
  import { href } from '../navigation/router.svelte'
  import { theme, type Theme } from '../../lib/theme.svelte'
  import type { ChainInfo } from '../../lib/types'
  import { accountActivationView } from './author-gate-view.svelte'
  import { accountActions } from './account-actions.svelte'
  import AuthorGate from './AuthorGate.svelte'
  import UnsettledChange from '../../components/UnsettledChange.svelte'
  import { ApiError } from '../../lib/api'
  import { explain } from '../../lib/errors'
  import { declareBot } from '../../lib/host-policy'
  import { wallet } from '../../lib/wallet.svelte'

  let { chain, address, refreshRevision = 0, onselect }: { chain: ChainInfo; address: Address | null; refreshRevision?: number; onselect: (id: number) => void } = $props()
  let chains = $derived(host.status?.chains ?? [chain])
  const account = accountActivationView(() => ({ chain, address, refreshRevision }))
  let deployment = $derived(keyDeployment(chain))
  const keys = accountKeyStatus(() => ({ chain, address, reloadRevision: refreshRevision }))
  /** An account change this device sent whose receipt never came: the account's other changes wait for it. */
  let unsettled = $derived(address ? accountActions.unsettled(chain, address) : null)

  // The account's own bot label (design/BOT_LABELS.md): a signed statement, no gas.
  let declared = $derived(!!address && host.bot(address) === 'declared')
  /** The choice being saved, shown until the host answers. */
  let pendingBot = $state<boolean | null>(null)
  let botNote = $state<{ error: boolean; text: string } | null>(null)
  const BOT_REFUSALS: Record<string, string> = {
    not_an_author: 'post once before marking this account as a bot',
    stale_declaration: 'check your device’s clock and try again',
    wrong_signer: 'your wallet could not prove this account. try again',
    declarations_full: 'this host cannot take more bot labels right now',
  }
  async function setBot(bot: boolean) {
    if (pendingBot !== null) return
    pendingBot = bot
    botNote = { error: false, text: 'sign the statement in your wallet…' }
    try {
      await declareBot(wallet, bot)
      botNote = { error: false, text: bot ? 'marked as a bot' : 'no longer marked as a bot' }
    } catch (e) {
      botNote = { error: true, text: e instanceof ApiError && BOT_REFUSALS[e.code] ? BOT_REFUSALS[e.code] : explain(e) }
    } finally { pendingBot = null }
  }
</script>

{#if address && (deployment || host.keyringMarket(chain.id))}
  <section aria-label="account key settings">
    <h2>account keys</h2>
    {#if deployment}<p><a href={href.keys(chain.id)}>account key activation</a></p>{/if}
    {#if keyControls.available(chain, address)}<p><a href={href.keyring(chain.id, address)}>manage keyring</a></p>{/if}
  </section>
{/if}

{#if address}
  <!-- One notice for the account's changes, shown whether or not it is deactivated. -->
  <UnsettledChange block what="your account" hash={unsettled} saved={accountActions.saved(chain, address)} busy={accountActions.busy(chain, address)}
    check={() => accountActions.check(chain, address)} clear={() => accountActions.clear(chain, address)} />
{/if}

{#if address && !account.deactivated}
  <section aria-label="reply settings">
    <h2>replies</h2>
    <AuthorGate {chain} {address} keyStatus={keys.state} blocklistEmpty={account.blocklistEmpty} loading={account.loading} failed={account.failed} held={unsettled !== null} />
    {#if account.failed}{@render readError()}{/if}
    {#if keys.state === 'failed'}<p class="small err">could not check your account keys. <button onclick={keys.retry}>try again</button></p>{/if}
  </section>
{/if}

<section aria-label="network settings">
  <h2>network</h2>
  <label class="settings-picker" for="settings-chain">chain
    <select id="settings-chain" value={chain.id} onchange={(e) => onselect(Number(e.currentTarget.value))} disabled={chains.length < 2}>
      {#each chains as c (c.id)}
        <option value={c.id}>{chainLabel(c)}</option>
      {/each}
    </select>
  </label>
</section>

<section aria-label="appearance settings">
  <h2>appearance</h2>
  <label class="settings-picker" for="settings-theme">theme
    <select id="settings-theme" value={theme.current} onchange={(e) => theme.set(e.currentTarget.value as Theme)}>
      <option value="auto">system</option>
      <option value="light">light</option>
      <option value="dark">dark</option>
    </select>
  </label>
  <p class="small dim">remembered in this browser</p>
</section>

<section aria-label="account settings">
  <h2>account</h2>
  {#if !address}
    <p class="dim">connect your wallet to manage your account</p>
  {:else}
    <p class="small mono-break dim">{address}</p>
    {#if account.deactivated}
      <p>your account is deactivated on this chain. reactivation restores replies using your blocklist.</p>
      <p class="small dim">you can then change who can reply</p>
    {:else}
      <p>deactivation marks posts that use your account rule as deactivated and closes ordinary replies. the author you replied to can still answer your live replies. posts with their own reply rule are unaffected. this applies only on this chain and is reversible.</p>
    {/if}
    <button class="small" class:danger={!account.deactivated} onclick={account.changeActivation} disabled={account.busy || account.loading || !account.current || account.failed || unsettled !== null || (account.deactivated && !chain.blocking)}>
      {account.busy ? 'saving…' : account.loading ? 'loading…' : account.deactivated ? 'reactivate account' : 'deactivate account…'}
    </button>
    {#if account.deactivated && !chain.blocking}<p class="small dim">this host has no blocklist gate configured for reactivation</p>{/if}
    <!-- The replies card carries the one error line while it is shown. -->
    {#if account.failed && account.deactivated}{@render readError()}{/if}
    <p class="small operation-status transaction-status" class:working={account.busy && !!account.note} role="status" class:err={account.note && !account.note.ok}>{account.note?.text ?? ''}</p>
    {#if host.status?.host_policy}
      <div class="bot-switch">
        <label><input type="checkbox" checked={pendingBot ?? declared} disabled={pendingBot !== null} onchange={(e) => setBot(e.currentTarget.checked)} /> this account is a bot</label>
        <p class="small dim">shows a robot next to its name on this host. your wallet signs a statement, with no gas</p>
        <p class="small operation-status" role="status" class:err={botNote?.error}>{botNote?.text ?? ''}</p>
      </div>
    {/if}
  {/if}
</section>

{#snippet readError()}
  <p class="small err">could not read your account from the chain. <button onclick={account.retry} disabled={account.busy}>try again</button></p>
{/snippet}

<style>
  .settings-picker { display: flex; align-items: center; gap: .75rem; }
  section {
    margin: 1rem;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--tint);
  }
  section > :last-child { margin-bottom: 0; }
  h2 { font-size: 1.1rem; margin: 0 0 .65rem; }
  .bot-switch { margin-top: 1rem; padding-top: .75rem; border-top: 1px solid var(--border); }
  .bot-switch label { display: flex; align-items: center; gap: .5rem; }
</style>

<script lang="ts">
  import Loading from '../../shared/Loading.svelte'
  import { onDestroy, untrack } from 'svelte'
  import { zeroAddress } from 'viem'
  import { ACCOUNT_KEYS_CHAINS, initialKeyAmount, keyDeployment, keyMarket } from './account-keys'
  import { KeyPage, keyQuote } from './key-page.svelte'
  import whaleKeys from '../../assets/whale-keys.jpg'
  import { href } from '../navigation/router.svelte'
  import Eth from '../../shared/Eth.svelte'
  import KeyTransactionStatus from './KeyTransactionStatus.svelte'
  import { wallet } from '../../lib/wallet.svelte'
  import { captureWallet } from '../../lib/wallet-action'
  import { explain } from '../../lib/errors'
  import { burstKeys } from './key-burst'
  import type { ChainInfo } from '../../lib/types'

  let { chain, refreshRevision = 0 }: { chain: ChainInfo; refreshRevision?: number } = $props()
  // The parent remounts this view when its chain, mode or wallet account changes.
  const deployment = untrack(() => keyDeployment(chain))
  const market = untrack(() => wallet.account && deployment ? keyMarket(chain, deployment) : null)
  const page = untrack(() => new KeyPage(market, wallet.account ?? zeroAddress, wallet.account ?? zeroAddress,
    `blohard.account-keys.activation/${chain.id}/${deployment?.address}/${wallet.account}`, 'activation'))
  const tracking = page.tracking
  onDestroy(() => page.dispose())
  $effect(() => { void refreshRevision; void page.readRevision; return untrack(() => page.watch()) })
  let initial = $state('0')
  const account = $derived(page.account.value())
  const loading = $derived(page.account.pending)
  const pending = $derived(tracking.hash)
  const busy = $derived(tracking.busy)
  const inputError = $derived.by(() => { try { initialKeyAmount(initial); return null } catch (e) { return explain(e) } })
  const quotes = keyQuote(() => {
    void page.revision
    const amount = inputError ? null : initialKeyAmount(initial)
    return market && account && !account.active && amount !== null
      ? async () => ({ amount, ...await market.quote(amount) }) : null
  })
  const quoted = $derived(quotes.value)
  const error = $derived(page.error || quotes.error || (page.account.failure() ? explain(page.account.failure()!.cause) : ''))
  async function activate() {
    const pressed = captureWallet(wallet), reviewed = quoted
    if (!market || !pressed || !reviewed || account?.active || inputError) return
    const { account: author, provider } = pressed
    if (reviewed.amount !== initialKeyAmount(initial)) return
    await page.send(async guard => {
      await wallet.ensureChain(chain)
      const ready = () => {
        guard()
        if (!pressed.current()) throw new Error('the wallet changed. review activation again')
      }
      ready()
      return market.activate(provider, author, reviewed.amount, reviewed.quote, ready)
    }, () => {
      // An activation that bought keys is a purchase too.
      if (reviewed.amount > 0n && activateButton?.isConnected) burstKeys(activateButton, reviewed.amount)
    })
  }
  let activateButton = $state<HTMLButtonElement>()
</script>

<section class="keys-page">
  <img class="keys-banner" src={whaleKeys} alt="the blohard whale holding a big golden key in its fin" width="1200" height="654" />
  <p>let people buy and sell keys to your account. <a href={href.keysAbout(chain.id)}>about account keys</a></p>
  {#if !ACCOUNT_KEYS_CHAINS.some(id => id === chain.id)}
    <p>account keys are available on Base and Base Sepolia. choose one in the chain selector.</p>
  {:else if !deployment}
    <p>the account-key market is not configured yet.</p>
  {:else if !wallet.account}
    <p>connect your wallet to view or activate your account keys.</p>
  {:else}
    {#if loading && !account}<Loading label="checking your account keys…" />{/if}
    {#if account?.active}
      <h3>account keys active</h3>
      <dl>
        <dt>keys in circulation</dt><dd>{account.supply.toString()}</dd>
        <dt>your own keys</dt><dd>{account.holdings.toString()}</dd>
        <dt>unclaimed fees</dt><dd><Eth wei={account.fees} round="down" /></dd>
      </dl>
      <p><a href={href.userKeys(chain.id, wallet.account)}>buy, sell, and claim fees</a></p>
    {:else if account}
      <!-- The activation form sits on a card of its own, apart from the page's introduction. -->
      <div class="activation-card">
      <label for="initial-keys">initial keys to buy (optional)</label>
      <input id="initial-keys" type="text" inputmode="numeric" bind:value={initial} disabled={busy || !!pending} aria-invalid={!!inputError} />
      <p class="small dim">choose a whole number of keys. zero activates your market without purchasing keys.</p>
      {#if inputError}<p class="err" role="alert">{inputError}</p>{/if}
      <dl class="payment" aria-live="polite">
        <dt>total payment</dt><dd><strong>{#if inputError}enter a valid quantity{:else if quoted}<Eth wei={quoted.quote.total} round="up" />{:else}loading quote…{/if}</strong></dd>
      </dl>
      <p class="small">activation is permanent. your initial purchase happens in the same transaction, before anyone else can buy. you pay network gas.</p>
      <button class="activate" bind:this={activateButton} onclick={activate} disabled={busy || wallet.busy || !!pending || !quoted || !!inputError}>
        {busy ? 'check transaction status below…' : !inputError && initialKeyAmount(initial) > 0n ? `activate and buy ${initialKeyAmount(initial)} keys` : 'activate keys'}
      </button>
      </div>
    {/if}
    <KeyTransactionStatus {chain} {page} {error} />
  {/if}
</section>

<style>
  .keys-page { padding: 1rem; }
  .keys-banner { display: block; width: 100%; height: auto; border-radius: 3px; margin-bottom: 1rem; }
  .activation-card { margin: 1rem 0; padding: 1rem; border: 1px solid var(--border); border-radius: 4px; background: var(--tint); }
  .activation-card > :last-child { margin-bottom: 0; }
  .activate { display: block; width: 100%; min-height: 48px; padding: .7rem 1rem; border: 1px solid var(--accent);
    border-radius: 3px; background: var(--bg); color: var(--accent); font-weight: 600; }
  .activate:hover:not(:disabled) { background: var(--accent); color: var(--bg); }
  .activate::before, .activate::after { color: inherit; }
  .activate:disabled { color: var(--dim); border-color: var(--border); cursor: default; }
  input { display: block; width: 8rem; margin-top: .5rem; }
  dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: .6rem 1rem; }
  dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
  .payment dd { min-height: 2lh; }
  @media (max-width: 600px) { .activate { min-height: calc(2lh + 1.4rem + 2px); } }
  @media (max-width: 480px) { dl { grid-template-columns: 1fr; } dd { text-align: left; margin-bottom: .4rem; } }
</style>

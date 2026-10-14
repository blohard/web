<script lang="ts">
  // Test ether only: eligibility, the request and its receipt belong here,
  // separate from wallet connection and chain selection.
  import { onDestroy } from 'svelte'
  import { explain } from '../lib/errors'
  import { awaitSuccess } from '../lib/transactions'
  import { chainLabel } from '../lib/chains'
  import { shortHex } from '../lib/format'
  import { host } from '../lib/host.svelte'
  import { faucetStatus, requestFaucet } from '../features/publishing/relay'
  import type { ChainInfo } from '../lib/types'
  import { wallet } from '../lib/wallet.svelte'

  let { chain }: { chain: ChainInfo | null } = $props()
  let error = $state<string | null>(null)

  // The faucet, on a test chain: offered while the connected account holds
  // less than a drip and the relayer can fund one above its reserve. Asked
  // of the relayer, which knows the balances and limits; reloads after an attempt.
  let faucet = $derived(chain ? (host.relay?.chains.find((c) => c.id === chain.id)?.faucet ?? null) : null)
  let dripped = $state(0)
  /** Bumped to ask again after a status read failed: the relayer may be restarting. */
  let asked = $state(0)
  let offer = $derived.by(() => {
    void dripped
    void asked
    const account = wallet.account
    return faucet && chain && account ? faucetStatus(chain.id, account).catch(() => null) : null
  })
  // A failed read is no answer: ask again, 30 seconds apart, three times for each account and chain.
  let retries = 0
  $effect(() => {
    void chain?.id
    void wallet.account
    retries = 0
  })
  $effect(() => {
    const read = offer
    if (!read) return
    let timer: ReturnType<typeof setTimeout> | undefined, live = true
    void read.then((f) => {
      if (live && f === null && retries < 3) timer = setTimeout(() => { retries++; asked++ }, 30_000)
    })
    return () => { live = false; clearTimeout(timer) }
  })
  let dripping = $state<string | null>(null)
  /** Said for a few seconds once the drip has landed, where the button was, so the success is seen. */
  let landed = $state<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  onDestroy(() => clearTimeout(timer))

  async function drip() {
    // The chain and account as they were when asked: switching either while
    // the drip is in flight must not send the receipt lookup elsewhere.
    const target = chain
    const account = wallet.account
    if (!target || !account) return
    error = null
    dripping = 'asking the faucet…'
    try {
      const { tx_hash, amount_eth } = await requestFaucet(target.id, account)
      dripping = 'sent, waiting for it to land…'
      await awaitSuccess(target, tx_hash)
      dripping = null
      // Said of the account that received it, which may no longer be the connected one.
      const whose = wallet.account === account ? 'your wallet' : shortHex(account)
      landed = `${amount_eth} test ether landed in ${whose} on ${chainLabel(target)}. you can post now`
      clearTimeout(timer)
      timer = setTimeout(() => (landed = null), 10_000)
    } catch (e) {
      dripping = null
      error = explain(e)
    } finally {
      // Another send may have used the remaining funds after eligibility
      // was read. Refresh the offer after refusals as well as successful drips.
      dripped++
    }
  }

</script>

{#if landed}
  <p class="small wallet-faucet ok">✓ {landed}</p>
{:else if offer}
  {#await offer then f}
    {#if f?.eligible}
      <p class="small wallet-faucet">
        {#if dripping}
          <span class="dim">{dripping}</span>
        {:else}
          <button class="small" onclick={drip} title="this is a test chain. its ether is free, and the host hands it out">get {f.amount_eth} test ether</button>
        {/if}
      </p>
    {/if}
  {/await}
{/if}
{#if error}
  <div class="wallet-error small err">{error}</div>
{/if}

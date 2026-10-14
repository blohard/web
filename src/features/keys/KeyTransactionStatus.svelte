<script lang="ts">
  import { transactionUrl } from '../../lib/chains'
  import type { ChainInfo } from '../../lib/types'
  import type { KeyPage } from './key-page.svelte'
  let { chain, page, error }: { chain: ChainInfo; page: KeyPage; error: string } = $props()
  const pending = $derived(page.tracking.hash)
  const transaction = $derived(pending ? transactionUrl(chain, pending) : null)
  const busy = $derived(page.tracking.busy)
  const activation = $derived(page.action === 'activation')
</script>

<p class="operation-status transaction-status" class:working={busy} role="status">{page.phase || (busy ? 'transaction in progress…' : '')}</p>
{#if pending}
  {#if !page.tracking.saved}<p class="err">transaction tracking could not be saved. do not reload or close this tab until it confirms</p>{/if}
  <p class="small" class:mono-break={activation}>
    {#if activation}activation transaction · {/if}{#if transaction}<a href={transaction} target="_blank" rel="noopener noreferrer">{activation ? pending : 'view transaction'}</a>{:else}{pending}{/if}
  </p>
  <button class:small={activation} onclick={() => page.check()} disabled={busy}>check transaction</button>
  {#if !busy}
    <details class="small">
      <summary>cancelled or replaced this transaction?</summary>
      <p>check its status in your wallet first. clearing the saved transaction does not cancel it.
        {#if activation}an earlier activation that later confirms can make another attempt revert and cost gas.
        {:else}if an earlier trade later confirms, trading again could move keys twice.{/if}</p>
      <button onclick={() => page.clear()}>clear saved transaction</button>
    </details>
  {/if}
{/if}
{#if error}
  <p class="err" role="alert">{error}
    {#if page.account.failure() && !busy && !pending}<button onclick={() => page.retryRead()}>try again</button>{/if}
  </p>
{/if}

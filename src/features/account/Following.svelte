<script lang="ts">
  // The people this browser follows, with a way to stop. Local only: nothing
  // here is written anywhere else.
  import { follows } from '../../lib/follows.svelte'
  import { rememberPage } from '../navigation/visit-position'
  import type { ChainInfo } from '../../lib/types'
  import AddressRow from '../../components/AddressRow.svelte'
  import Empty from '../../shared/Empty.svelte'

  let { chain }: { chain: ChainInfo } = $props()
</script>

<div use:rememberPage={'data-person'}>
<p class="dim small">accounts whose posts and replies show in your following stream. your following list is stored only in this browser, not on the server.</p>
{#if follows.addresses.length === 0}
  <Empty>you follow nobody yet. the follow control is on each user's profile.</Empty>
{:else}
  {#each follows.addresses as a (a)}
    <AddressRow {chain} address={a}>
      <button onclick={() => follows.toggle(a)}>unfollow</button>
    </AddressRow>
  {/each}
{/if}
</div>

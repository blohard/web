<script lang="ts">
  // One key notice: someone traded your keys, or someone sent you keys.
  import type { Address } from 'viem'
  import { keyNoticeParty, type KeyNotification } from './key-notifications.svelte'
  import { href } from '../navigation/router.svelte'
  import { fullTime, sameAddress, timeAgo } from '../../lib/format'
  import { chainLabel, transactionUrl } from '../../lib/chains'
  import Avatar from '../../components/Avatar.svelte'
  import Name from '../../components/Name.svelte'
  /** `creator` is the reader: the account whose inbox this is. */
  let { notice, creator, showChain = false }: { notice: KeyNotification; creator: Address; showChain?: boolean } = $props()
  const transaction = $derived(transactionUrl(notice.chain, notice.transaction))
  const party = $derived(keyNoticeParty(notice))
  const count = $derived(notice.amount.toLocaleString())
  /** Whose market the notice links to: yours for a trade, the keys' creator for a gift. */
  const market = $derived(notice.kind === 'key-trade' ? creator : notice.creator)
</script>
<div class="key-notification">
  <Avatar address={party} size={32} />
  <div>
    <p><a href={href.user(notice.chain.id, party)}><Name address={party} /></a>
      {#if notice.kind === 'key-trade'}{notice.buy ? 'bought' : 'sold'} {count} of your keys
      {:else if sameAddress(notice.creator, notice.from)}sent you {count} of their keys
      {:else if sameAddress(notice.creator, creator)}sent you {count} of your own keys
      {:else}sent you {count} {notice.amount === 1 ? 'key' : 'keys'} to <a href={href.user(notice.chain.id, notice.creator)}><Name address={notice.creator} /></a>
      {/if}</p>
    <p class="small"><time datetime={new Date(notice.timestamp * 1000).toISOString()} title={fullTime(notice.timestamp)}>{timeAgo(notice.timestamp)}</time>
      {#if showChain} · {chainLabel(notice.chain)}{/if}
      · <a href={href.userKeys(notice.chain.id, market)}>{sameAddress(market, creator) ? 'your key market' : 'their key market'}</a>
      {#if transaction} · <a href={transaction} target="_blank" rel="noopener noreferrer">transaction</a>{/if}</p>
  </div>
</div>
<style>
  .key-notification { display: flex; gap: .75rem; padding: 1rem; border-bottom: 1px dashed var(--border); }
  p { margin: 0; }
  .small { color: var(--dim); margin-top: .3rem; }
</style>

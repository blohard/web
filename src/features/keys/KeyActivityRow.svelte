<script lang="ts">
  import type { ChainInfo } from '../../lib/types'
  import type { KeyActivity } from './key-activity'
  import { href } from '../navigation/router.svelte'
  import { fullTime, timeAgo } from '../../lib/format'
  import { transactionUrl } from '../../lib/chains'
  import Avatar from '../../components/Avatar.svelte'
  import Name from '../../components/Name.svelte'
  let { event, chain }: { event: KeyActivity; chain: ChainInfo } = $props()
  const actor = $derived(event.kind === 'purchase' ? event.buyer : event.from)
  const transaction = $derived(transactionUrl(chain, event.transaction))
</script>
<div class="key-activity">
  <Avatar address={actor} size={32} />
  <div>
    <a class="activity-link" href={href.userKeys(chain.id, event.creator)}>
      <Name address={actor} /> just {event.kind === 'purchase' ? 'bought' : 'transferred'} {event.amount.toLocaleString()} of <Name address={event.creator} />'s keys{#if event.kind === 'transfer'} to <Name address={event.to} />{/if}!
    </a>
    <p class="small dim"><time datetime={new Date(event.timestamp * 1000).toISOString()} title={fullTime(event.timestamp)}>{timeAgo(event.timestamp)}</time>
      {#if transaction} · <a class="transaction" href={transaction} target="_blank" rel="noopener noreferrer">transaction</a>{/if}
    </p>
  </div>
</div>
<style>
  .key-activity { position: relative; display: flex; gap: .75rem; padding: 1rem; border-bottom: 1px dashed var(--border); }
  .activity-link { color: inherit; }
  .activity-link::after { content: ''; position: absolute; inset: 0; }
  .activity-link:focus-visible::after { outline: 2px solid var(--accent); outline-offset: -2px; }
  .transaction { position: relative; z-index: 1; }
  .small { margin: .3rem 0 0; }
</style>

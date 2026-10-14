<script lang="ts">
  import type { Address } from 'viem'
  import { byQuantity, type KeyringPage, type KeyringSide } from './keyring-balances'
  import { href } from '../navigation/router.svelte'
  import type { ChainInfo } from '../../lib/types'
  import { shortAddress } from '../../lib/format'
  import Avatar from '../../components/Avatar.svelte'
  import Name from '../../components/Name.svelte'
  let { chain, account, page, side, own = true }: { chain: ChainInfo; account: Address; page: KeyringPage; side: KeyringSide; own?: boolean } = $props()
  const entries = $derived(byQuantity(page.entries))
</script>

{#if page.ownBalance > 0}
  <div class="own-keys">
    <strong>{own ? 'your own keys' : 'their own keys'}</strong>
    <strong class="quantity">{page.ownBalance.toLocaleString()} {page.ownBalance === 1 ? 'key' : 'keys'}</strong>
    <div class="own-links small"><a href={href.userKeys(chain.id, account)}>{own ? 'manage your keys' : 'view market'}</a> · <a href={href.keysAbout(chain.id)}>about account keys</a></div>
  </div>
{/if}
{#each entries as entry (entry.address)}
  <div class="row key-row" data-person={entry.address}>
    <Avatar address={entry.address} size={28} />
    <a class="identity" href={href.user(chain.id, entry.address)} title={entry.address}>
      <Name address={entry.address} /><span class="small dim">{shortAddress(entry.address)}</span>
    </a>
    <div class="holding">
      <strong class="quantity">{entry.balance.toLocaleString()} {entry.balance === 1 ? 'key' : 'keys'}</strong>
      {#if side === 'holding'}<a class="small" href={href.userKeys(chain.id, entry.address)}>{own ? 'manage your keys' : 'view market'}</a>{/if}
    </div>
  </div>
{/each}

<style>
  .own-keys { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: .6rem; padding: 1rem; margin: 1rem 0; background: var(--key-page-bg); border: 1px solid var(--border); border-radius: .4rem; }
  .own-links { grid-column: 1 / -1; }
  .key-row { align-items: center; gap: .75rem; padding: .75rem 0; border-top: 1px dashed var(--border); }
  .identity { flex: 1; min-width: 0; }
  .identity :global(.name) { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .identity > span { display: block; }
  .quantity { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .holding { display: grid; gap: .25rem; text-align: right; flex-shrink: 0; }
</style>

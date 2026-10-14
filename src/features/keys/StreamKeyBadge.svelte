<script lang="ts">
  import type { Address } from 'viem'
  import { host } from '../../lib/host.svelte'
  import { keyBadges } from './key-badges'
  import { Resource } from '../../shared/resource.svelte'
  import type { ChainInfo } from '../../lib/types'
  import AccountKeyBadge from './AccountKeyBadge.svelte'

  let { chain, address, reloadKey }: { chain: ChainInfo; address: Address; reloadKey?: unknown } = $props()
  const read = new Resource<boolean>()
  const market = $derived(host.keyringMarket(chain.id))
  const identity = $derived(`${chain.id}/${chain.contract}/${market}/${address}`.toLowerCase())
  const query = $derived.by(() => {
    void reloadKey
    return market ? keyBadges.read(chain, market, address) : null
  })
  $effect(() => { if (query) return read.watch(query, identity) })
</script>

{#if market}
  <AccountKeyBadge {chain} {address} active={read.value(identity) === true} compact />
{/if}

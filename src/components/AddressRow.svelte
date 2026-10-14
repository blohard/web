<script lang="ts">
  // One person in a list: avatar, name, shortened address, and whatever control
  // the list offers after them.
  import type { Snippet } from 'svelte'
  import type { Address } from 'viem'
  import { href } from '../features/navigation/router.svelte'
  import type { ChainInfo } from '../lib/types'
  import { shortAddress } from '../lib/format'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'

  let { chain, address, children }: { chain: ChainInfo; address: Address; children?: Snippet } = $props()
</script>

<div class="row person-row" data-person={address}>
  <Avatar {address} size={28} />
  <a class="grow mono-break" href={href.user(chain.id, address)}><Name {address} /> <span class="dim small" title={address}>{shortAddress(address)}</span></a>
  {@render children?.()}
</div>

<script lang="ts">
  import type { ChainInfo } from '../lib/types'
  import { wallet } from '../lib/wallet.svelte'
  import { revealWhen } from '../features/navigation/scroll'
  import ConnectWallet from './ConnectWallet.svelte'
  import WalletHint from './WalletHint.svelte'

  let { toDo, chain, focusRequest = null }: { toDo: string; chain?: ChainInfo; focusRequest?: unknown } = $props()
</script>

<p class="dim small connect-prompt" tabindex="-1" use:revealWhen={{ key: focusRequest, focus: 'button', anchor: 'above' }}>
  {#if wallet.canConnect}
    <ConnectWallet {chain} {toDo} label="connect a wallet" />
  {:else}
    <WalletHint {toDo} />
  {/if}
</p>

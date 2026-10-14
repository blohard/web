<script lang="ts">
  // The wallet, top right like everywhere else: connect, or who you are, plus
  // the one-click fixes when the wallet is on the wrong chain or its RPC is
  // not answering. Test-chain funding is a separate control.
  import { host } from '../lib/host.svelte'
  import { explain } from '../lib/errors'
  import { chainLabel } from '../lib/chains'
  import { href, router } from '../features/navigation/router.svelte'
  import type { ChainInfo } from '../lib/types'
  import { wallet } from '../lib/wallet.svelte'
  import Avatar from './Avatar.svelte'
  import FaucetControl from './FaucetControl.svelte'
  import Name from './Name.svelte'
  import ConnectWallet from './ConnectWallet.svelte'
  import WalletHint from './WalletHint.svelte'

  let { chain }: { chain: ChainInfo | null } = $props()

  let error = $state<string | null>(null)

  // When the wallet sits on the selected chain, check that its RPC answers so
  // a stale saved URL is flagged before the user tries to post.
  $effect(() => {
    if (wallet.account && chain && wallet.chainId === chain.id && wallet.rpcHealthy === null) {
      void wallet.checkRpc()
    }
  })

  async function switchChain() {
    if (!chain) return
    error = null
    try {
      await wallet.ensureChain(chain)
    } catch (e) {
      error = explain(e)
    }
  }
</script>

<div class="wallet small">
  {#if !wallet.canConnect && wallet.restoring}
    <span class="dim">connecting…</span>
  {:else if !wallet.canConnect}
    <span class="dim">no wallet</span>
  {:else if !wallet.account}
    <ConnectWallet chain={chain ?? undefined} />
  {:else}
    <!-- Who is connected on a line of its own; what they can do about it on the line below. -->
    <a class="account" href={chain ? href.user(chain.id, wallet.account) : '#/'} title={wallet.account}>
      <Avatar address={wallet.account} size={22} />
      <Name address={wallet.account} />
    </a>
    <div class="wallet-actions">
      {#if chain && wallet.chainId !== chain.id}
        <button onclick={switchChain} disabled={wallet.busy} title="your wallet is on another network">
          {wallet.busy ? 'check your wallet…' : `switch wallet to ${chainLabel(chain)}`}
        </button>
      {:else if chain && wallet.rpcHealthy === false}
        <button class="danger" onclick={switchChain} disabled={wallet.busy} title="the RPC URL your wallet has saved for this chain is not answering ({wallet.rpcProblem ?? 'no answer'}). sponsored posts still work, paying your own gas will not until it does">
          {wallet.busy ? 'check your wallet…' : 'wallet RPC not responding, fix it'}
        </button>
      {/if}
      <button class="small dim wallet-disconnect" onclick={() => wallet.disconnect()} disabled={wallet.busy} title="sign out. forget this connection until you connect again">disconnect</button>
    </div>
  {/if}
</div>
{#if host.blocked(wallet.account)}
  <p class="dim small">blocked by host</p>
{:else}<FaucetControl {chain} />{/if}
<!-- Home's feed already carries this hint in its connect prompt; say it once. -->
{#if !wallet.canConnect && router.route.kind !== 'home'}
  <p class="dim small wallet-error">
    <WalletHint />
  </p>
{/if}
{#if error}
  <div class="wallet-error small err">{error}</div>
{/if}

<script lang="ts">
  import { explain } from '../lib/errors'
  import type { ChainInfo } from '../lib/types'
  import type { WalletChoice } from '../lib/remote-wallet'
  import { wallet } from '../lib/wallet.svelte'
  import { modal } from '../shared/modal'

  let { chain, label = 'connect wallet', toDo }: { chain?: ChainInfo; label?: string; toDo?: string } = $props()
  let choosing = $state(false)
  let error = $state<string | null>(null)
  const title = $props.id()

  async function connect(choice: WalletChoice) {
    choosing = false
    error = null
    try {
      await wallet.connect(chain, choice)
    } catch (e) {
      error = explain(e)
    }
  }

  function open() {
    error = null
    const choices = wallet.choices
    if (choices.length === 1 && choices[0] === 'browser') void connect(choices[0])
    else choosing = true
  }
</script>

<button onclick={open} disabled={wallet.busy || wallet.restoring}>{wallet.busy ? 'check your wallet…' : wallet.restoring ? 'connecting…' : label}</button>{#if toDo} {toDo}.{/if}
{#if error}<span class="err connection-error">{error}</span>{/if}
{#if choosing}
  <dialog use:modal={() => { choosing = false }} onclose={() => { choosing = false }} aria-labelledby={title}>
    <header>
      <h2 id={title}>connect wallet</h2>
      <button class="close" aria-label="close wallet choices" onclick={() => { choosing = false }}>×</button>
    </header>
    <div class="choices">
      {#each wallet.choices as choice}
        <button onclick={() => connect(choice)}>{wallet.choiceName(choice)}</button>
      {/each}
    </div>
  </dialog>
{/if}

<style>
  .connection-error { display: inline-block; max-width: 32ch; }
  dialog { width: min(40ch, calc(100% - 2rem)); max-width: none; max-height: calc(100dvh - 2rem); margin: auto; padding: 0; color: var(--fg); background: var(--bg); border: 1px solid var(--border); box-shadow: 0 1rem 4rem #0006; overflow: auto; }
  dialog::backdrop { background: #0009; }
  header { display: flex; align-items: center; justify-content: space-between; padding: .3rem 1rem; border-bottom: 1px dashed var(--border); }
  h2 { font-size: 1em; margin: 0; }
  .close { min-width: 44px; min-height: 44px; font-size: 1.5rem; padding: 0; }
  .close::before, .close::after { content: none; }
  .choices { display: flex; flex-direction: column; align-items: stretch; gap: .5rem; padding: 1rem; }
  .choices button { min-height: 44px; overflow-wrap: anywhere; }
</style>

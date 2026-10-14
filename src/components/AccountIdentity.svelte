<script lang="ts">
  import type { Snippet } from 'svelte'
  import Avatar from './Avatar.svelte'
  import Name from './Name.svelte'
  import BotMark from './BotMark.svelte'
  import { names, profileUrl } from '../lib/names.svelte'

  let { address, children }: { address: string; children?: Snippet } = $props()
  const entry = $derived(names.lookup(address))
  let copied = $state(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      copied = true
      setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard unavailable: the address is on screen anyway.
    }
  }
</script>

<Avatar {address} size={56} />
<div class="grow">
  <div class="name">
    <Name {address} /><BotMark {address} />
    {#if entry?.source}
      <span class="dim small">
        · via
        {#if profileUrl(entry)}
          <a href={profileUrl(entry)} target="_blank" rel="noopener noreferrer" title="open this name's profile">{entry.source === 'ens' ? 'ENS' : 'Basenames'}</a>
        {:else}{entry.source === 'ens' ? 'ENS' : 'Basenames'}{/if}
      </span>
    {/if}
    {@render children?.()}
  </div>
  <div class="small dim mono-break">
    {address}
    <button class="small" onclick={copy}>{copied ? 'copied' : 'copy'}</button>
  </div>
</div>

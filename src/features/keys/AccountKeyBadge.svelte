<script lang="ts">
  import type { Address } from 'viem'
  import type { ChainInfo } from '../../lib/types'
  import { href } from '../navigation/router.svelte'

  let { chain, address, active, compact = false }: { chain: ChainInfo; address: Address; active: boolean; compact?: boolean } = $props()
</script>

<span class="key-slot" class:compact>
{#if active}
  <a class="key-badge" href={href.userKeys(chain.id, address)} title="account keys active · view keys" aria-label="account keys active · view keys">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 13.5a6 6 0 1 1 4.5-4.5L22 17.5V21h-4v-3h-3v-3l-1.5-1.5Z" fill="#f5bf35" stroke="#95620b" stroke-width="1.5" stroke-linejoin="round" />
      <circle cx="7.5" cy="7.5" r="2" fill="var(--bg)" stroke="#95620b" stroke-width="1.5" />
    </svg>
  </a>
{/if}
</span>

<style>
  .key-slot { display: inline-block; position: relative; width: 28px; height: 1em; vertical-align: middle; }
  .key-badge { position: absolute; top: 50%; left: 0; transform: translateY(-50%); display: inline-flex; vertical-align: middle; align-items: center; justify-content: center; padding: 3px; border-radius: 3px; }
  .key-slot.compact { width: 22px; flex-shrink: 0; }
  .compact svg { width: 16px; height: 16px; }
  .key-badge:hover { background: var(--tint); }
  .key-badge:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>

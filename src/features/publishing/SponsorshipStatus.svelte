<script lang="ts">
  import { loadingDelay } from '../../shared/loading-delay.svelte'
  import type { SponsorshipEntry } from './sponsorship.svelte'

  let { entry, offered, payMyself, automatic = false, namesEnabled = false, disabled = false, onToggle, onRefresh }: {
    entry?: SponsorshipEntry
    offered: boolean
    payMyself: boolean
    automatic?: boolean
    namesEnabled?: boolean
    disabled?: boolean
    onToggle: () => void
    onRefresh: () => void
  } = $props()
  let active = $derived(offered && entry?.eligible === true && entry.posting_available === true && !payMyself)
  let paused = $derived(entry?.eligible === true && entry.posting_available === false)
  const unchecked = $derived(offered && entry?.eligible == null)
  const slowCheck = loadingDelay(() => unchecked && !entry?.error && !payMyself ? true : null)
  const checking = $derived(slowCheck() || (unchecked && !!entry?.error))
  let via = $derived(entry?.reason === 'ens' ? 'your ENS name' : entry?.reason === 'basename' ? 'your Basename' : 'the curated list')
  // Explain an automatic paid fallback; an explicit paid choice needs no reminder.
  let inPlay = $derived(automatic || (!payMyself && (active || paused || checking || (offered && entry?.eligible === true))))
</script>

<div class="status small dim" aria-live="polite" role="status">
  {#if inPlay}
    {#if active}
      free via {via}
    {:else if paused}
      <strong>free posting paused</strong> · {entry?.posting_paused_reason ?? 'temporarily unavailable'}{#if automatic} · you pay gas{/if}
    {:else if checking}
      <span class="dim">{entry?.error ? 'free posting check failed' : 'checking free posting…'}</span>
    {:else}
      <strong>eligible for free posting</strong> · availability checked when you post <span class="dim">· via {via}</span>
    {/if}
  {/if}
  {#if offered}
    {#if checking && entry?.error && !payMyself}
      · <button onclick={onRefresh} {disabled}>retry</button>
      or <button onclick={onToggle} {disabled}>pay my own gas</button>
    {:else if payMyself && entry?.eligible && !paused}
      <button onclick={onToggle} {disabled}>use free posting</button>
    {:else if !payMyself && (checking || entry?.eligible)}
      · <button onclick={onToggle} {disabled}>pay my own gas</button>
    {/if}
    {#if paused && (!payMyself || automatic)}
      · <button class="dim" onclick={onRefresh} {disabled}>retry</button>
    {/if}
  {/if}
  {#if namesEnabled && entry?.eligible === false}
    <span class="dim">get an <a href="https://app.ens.domains/" target="_blank" rel="noopener noreferrer">ENS</a> or <a href="https://www.base.org/names" target="_blank" rel="noopener noreferrer">Basename</a> for free posting</span>
  {/if}
</div>

<style>
  /* Reserve a payment line, including its button padding, before the relay answers.
     Narrow composers wrap the payment choice onto a second line. */
  .status { min-height: calc(1lh + .2rem); }
  @container (width < 20rem) {
    .status { min-height: calc(2lh + .2rem); }
  }
</style>

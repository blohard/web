<script lang="ts">
  import type { Snippet } from 'svelte'
  import { bodyPreview } from './body-preview'
  import { router } from '../navigation/router.svelte'

  let { href = null, lines = 12, expandable = false, children }: { href?: string | null; lines?: number; expandable?: boolean; children: Snippet } = $props()
  let clipped = $state(false)
  let expanded = $state(false)
</script>

{#if href || expandable}
  <div class="preview" class:expanded class:clipped style={`--preview-lines: ${lines}`} use:bodyPreview={(value) => { clipped = value }}>
    <div class="preview-content">{@render children()}</div>
  </div>
  {#if clipped && !expanded}
    {#if expandable}
      <button class="read-full small" type="button" onclick={() => { expanded = true }}>read full post</button>
    {:else}
      <a class="read-full small" {href} target={router.embed ? '_blank' : undefined} rel={router.embed ? 'noopener noreferrer' : undefined}>read full post</a>
    {/if}
  {/if}
{:else}
  {@render children()}
{/if}

<style>
  .preview { max-height: calc(var(--preview-lines) * 1lh); overflow: clip; }
  .preview-content { display: flow-root; }
  .clipped { mask-image: linear-gradient(#000 calc(100% - 1lh), transparent); }
  .clipped:focus-within { mask-image: none; }
  /* A deliberate picture press lifts its containing body preview.
     Hiding the picture restores the cap. */
  .preview:has(:global([data-opened-picture="true"])) { max-height: none; mask-image: none; }
  .preview.expanded { max-height: none; mask-image: none; }
  button.read-full { color: var(--accent); padding: 0; }
  button.read-full::before, button.read-full::after { content: none; }
  .read-full { display: inline-block; margin-top: 0.25rem; }
</style>

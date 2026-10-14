<script lang="ts">
  /** `inline` sits in a line of text, such as a card body still loading, and keeps that line's height. */
  let { label, overlay = false, inline = false }: { label: string; overlay?: boolean; inline?: boolean } = $props()
</script>

{#if inline}
  <span class="loading working inline" role="status"><span class="spinner" aria-hidden="true"></span><span class="visually-hidden">{label}</span></span>
{:else}
  <p class="loading working" class:overlay role="status"><span class="spinner" aria-hidden="true"></span><span class="visually-hidden">{label}</span></p>
{/if}

<style>
  .loading { margin: 1rem 0; width: 100%; text-align: center; color: var(--accent); }
  .loading .spinner { width: 1rem; height: 1rem; margin: 0; border-radius: 0; }
  .overlay { position: absolute; top: 1rem; left: 0; margin: 0; }
  .inline { display: inline-block; margin: 0; width: auto; text-align: left; }
</style>

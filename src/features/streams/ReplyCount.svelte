<script lang="ts">
  import { resetScrollAnchor } from '../navigation/scroll'
  let { count, more = false, expanded = false, loading = false, onclick, onhide, href }: {
    count: number | null
    more?: boolean
    expanded?: boolean
    loading?: boolean
    onclick?: (() => void) | null
    onhide?: (() => void) | null
    href?: string
  } = $props()
  function press(action: () => void) {
    resetScrollAnchor()
    action()
  }
</script>

{#if count === null && !expanded}
  <span class="act dim" role="img" aria-label="counting replies" title="counting replies">…</span>
{:else if count || expanded}
  {@const label = expanded ? 'hide replies' : `${count} ${more ? 'more ' : ''}${count === 1 ? 'reply' : 'replies'}`}
  {#if onclick}
    <button class="act reply-count" class:reply-open={expanded} class:working={loading} onclick={() => press(onclick!)} aria-expanded={expanded} aria-busy={loading}>{label}{#if loading}<span class="spinner" aria-hidden="true"></span>{/if}</button>
  {:else if href}
    <a class="act reply-count" {href}>{label}</a>
  {:else}
    <span class="act dim">{label}</span>
  {/if}
{/if}
{#if onhide}<button class="act reply-count" class:hide-with-more={more && !!count && !expanded} onclick={() => press(onhide!)} aria-expanded="true">hide replies</button>{/if}

<style>
  @media (max-width: 600px) {
    .hide-with-more { display: none; }
  }
</style>

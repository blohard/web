<script lang="ts">
  import { untrack, type Snippet } from 'svelte'
  import { firstDisplayGroup, postList, rowGroup } from './post-list.svelte'
  import Loading from './Loading.svelte'

  let { feedId, pending = false, loading, children }: {
    feedId?: string
    /** A list page still being read occupies its place ahead of later cards. */
    pending?: boolean
    loading?: Snippet
    children?: Snippet
  } = $props()
  const { list, label, waited } = postList()
  const group = rowGroup()
  const displays = firstDisplayGroup()
  let shown = $state(false)
  let element = $state.raw<HTMLElement>()
  const ready = () => !pending && displays()
  function mount(node: HTMLElement) {
    element = node
    return list.register(node, ready, () => { shown = true }, group)
  }
  $effect(() => { if (!shown && ready()) untrack(() => list.changed()) })
</script>

<div data-feed-row={feedId} use:mount class:staged={!shown} inert={!shown}>{@render children?.()}</div>
{#if !shown && element && list.first === element}
  {#if loading}{@render loading()}
  {:else}<div class="stream-opening">{#if waited()}<Loading {label} overlay />{/if}</div>{/if}
{/if}

<style>
  .staged { height: 0; overflow: hidden; visibility: hidden; }
  .stream-opening { position: relative; min-height: 3rem; overflow-anchor: none; }
  [data-feed-row] + .stream-opening { border-top: 1px dashed var(--border); }
</style>

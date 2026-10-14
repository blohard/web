<script lang="ts">
  import type { Snippet } from 'svelte'
  import { firstScreenRow } from './first-screen.svelte'

  let { id, children }: { id: string; children: Snippet } = $props()
  const initialRow = firstScreenRow()
</script>

<div data-feed-row={id} use:initialRow>{@render children()}</div>

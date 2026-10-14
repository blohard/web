<script lang="ts">
  import type { Snippet } from 'svelte'
  let { kind = 'info', children }: { kind?: 'info' | 'err'; children: Snippet } = $props()
</script>

<div class="notice {kind}">{@render children()}</div>

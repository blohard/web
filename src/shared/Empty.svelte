<script lang="ts">
  // An empty page: the whale, small and quiet, and one line saying why.
  import type { Snippet } from 'svelte'
  import whale from '../assets/whale.jpg'
  let { children }: { children: Snippet } = $props()
</script>

<div class="empty">
  <img src={whale} alt="" width="160" />
  <p class="dim">{@render children()}</p>
</div>

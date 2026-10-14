<script lang="ts">
  // A small robot after an account's name when this host shows it as a bot
  // (design/BOT_LABELS.md): in the accent colour for the account's own
  // statement, muted for the admin's label, so readers can tell them apart.
  import { host } from '../lib/host.svelte'

  let { address }: { address: string } = $props()
  let kind = $derived(host.bot(address))
  const LABEL = { declared: 'bot · declared by this account', labelled: 'bot · labelled by this host' } as const
  // Drawn on a pixel grid like the avatars: antenna, head with ears, two eyes, a mouth.
  const PIXELS = ['...##...', '.######.', '##.##.##', '########', '.##..##.', '.######.']
  const RECTS = PIXELS.flatMap((row, y) => [...row].flatMap((cell, x) => cell === '#' ? [{ x, y }] : []))
</script>

{#if kind}
  <span class="bot-mark" class:labelled={kind === 'labelled'} role="img" aria-label={LABEL[kind]} title={LABEL[kind]}>
    <svg width="16" height="12" viewBox="0 0 8 6" shape-rendering="crispEdges" aria-hidden="true">
      {#each RECTS as { x, y } (`${x}/${y}`)}<rect {x} {y} width="1" height="1" />{/each}
    </svg>
  </span>
{/if}

<style>
  .bot-mark { display: inline-flex; align-items: center; margin-left: .25em; vertical-align: middle; color: var(--accent); }
  .bot-mark.labelled { color: var(--dim); }
  .bot-mark svg { display: block; fill: currentColor; }
</style>

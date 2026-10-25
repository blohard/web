<script lang="ts">
  // The picture the address's name record points at, if the address has a
  // verified name with one; otherwise a deterministic 5×5 identicon from the
  // address, so the same author is recognizable at a glance regardless.
  import { keccak256, stringToBytes } from 'viem'
  import { avatars } from '../lib/avatars'
  import { names } from '../lib/names.svelte'

  let { address, size = 36 }: { address: string; size?: number } = $props()

  let entry = $derived(names.lookup(address))
  const avatar = $derived(entry?.avatar)
  const key = $derived(JSON.stringify([address.toLowerCase(), avatar]))
  let picture = $state.raw<{ key: string; src: string | null } | null>(null)
  let src = $derived(picture?.key === key ? picture.src : null)
  $effect(() => {
    const current = key, url = avatar, who = address
    if (!url) return
    let active = true, objectUrl: string | undefined
    void avatars.read(who, url).then(blob => {
      if (!active) return
      if (blob instanceof Blob) objectUrl = URL.createObjectURL(blob)
      // A failed CORS fetch may still work as an img; refused bytes never do.
      picture = { key: current, src: objectUrl ?? (blob === null ? url : null) }
    })
    return () => {
      active = false
      picture = null
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  })
  // Remember only the URL that failed. A replacement gets a fresh chance
  // without effect-driven resets.
  let brokenSrc = $state<string | null>(null)
  let broken = $derived(src !== null && src === brokenSrc)

  let cells = $derived.by(() => {
    const h = stringToBytes(keccak256(stringToBytes(address.toLowerCase())))
    const out: { x: number; y: number; tone: number }[] = []
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 3; x++) {
        const byte = h[y * 3 + x]
        if (byte & 1) {
          const tone = (byte >> 1) & 1
          out.push({ x, y, tone })
          if (x !== 2) out.push({ x: 4 - x, y, tone })
        }
      }
    }
    return out
  })
</script>

{#if src && !broken}
  <img class="avatar" width={size} height={size} {src} alt="" referrerpolicy="no-referrer" onerror={() => (brokenSrc = src)} />
{:else}
  <svg class="avatar" width={size} height={size} viewBox="0 0 5 5" shape-rendering="crispEdges" aria-hidden="true">
    <rect width="5" height="5" class="bg" />
    {#each cells as c (`${c.x},${c.y}`)}
      <rect x={c.x} y={c.y} width="1" height="1" class={c.tone ? 'a' : 'b'} />
    {/each}
  </svg>
{/if}

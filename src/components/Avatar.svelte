<script lang="ts">
  // The picture the address's name record points at, if the address has a
  // verified name with one; otherwise a deterministic 5×5 identicon from the
  // address, so the same author is recognizable at a glance regardless.
  import { keccak256, stringToBytes } from 'viem'
  import { avatars } from '../lib/avatars.svelte'
  import { names } from '../lib/names.svelte'

  let { address, size = 36 }: { address: string; size?: number } = $props()

  let entry = $derived(names.lookup(address))
  let cached = $derived(entry?.avatar ? avatars.get(address, entry.avatar) : undefined)
  /** The cached copy when we have it; the URL itself if the fetch failed (the browser may still load it); nothing when refused. */
  let src = $derived(entry?.avatar ? (cached === undefined || cached === false ? null : (cached ?? entry.avatar)) : null)
  /**
   * The picture URL that failed to load, if any; a different picture gets a
   * fresh chance. Kept as plain state plus a derived on purpose: an `$effect`
   * that reset a flag here (Svelte 5.57) left every card's page frozen — see
   * "Runes" in the README.
   */
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

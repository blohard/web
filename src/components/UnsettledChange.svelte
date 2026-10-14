<script lang="ts">
  // A wallet write this device sent whose receipt never came, said where its
  // controls are: check asks once whether it landed, clear forgets it.
  import { explain } from '../lib/errors'
  import type { Outcome } from '../lib/tracked-changes.svelte'
  import { checkOnce } from '../lib/unsettled-check.svelte'

  let { what, hash, saved = true, busy = false, check, clear, onlanded, block = false }: {
    /** What the change was to, as in "an earlier change to your account". */
    what: string
    /** A paragraph of its own rather than a run inside a row. */
    block?: boolean
    hash: string | null
    /** Whether the hash reached browser storage; a reload forgets one that did not. */
    saved?: boolean
    /** A send or check is running; the notice waits for its outcome. */
    busy?: boolean
    check: () => Promise<Outcome>
    clear: () => void
    onlanded?: () => void
  } = $props()

  let note = $state<string | null>(null)
  let error = $state<string | null>(null)
  /** This notice's own check is running: it stays shown through it. */
  let asking = $state(false)
  const shown = $derived(!!hash && (!busy || asking))

  async function ask() {
    error = null
    note = 'checking…'
    asking = true
    try {
      const outcome = await check()
      note = outcome === 'pending' ? 'not landed yet. check again in a moment' : null
      if (outcome === 'reverted') error = 'the earlier change reverted, so nothing changed'
      if (outcome === 'landed') onlanded?.()
    } catch (e) {
      note = null
      error = explain(e)
    } finally {
      asking = false
    }
  }

  function forget() {
    if (!confirm(`forget the earlier change?\n\nit may still land, and ${what} then changes as it would have. clearing lets you send another change now.`)) return
    try {
      clear()
      note = null
    } catch (e) { error = explain(e) }
  }

  // Shown with a change outstanding, ask once, quietly (lib/unsettled-check.svelte.ts).
  checkOnce(() => ({ hash, busy }), () => check(), () => onlanded?.())
</script>

{#if hash && !saved}
  <svelte:element this={block ? 'p' : 'span'} class="small err">transaction tracking could not be saved. do not reload or close this tab until it confirms</svelte:element>
{/if}
{#if shown || error}
  <svelte:element this={block ? 'p' : 'span'} class="small">
    {#if shown}
      an earlier change to {what} may still land
      <button class="small" disabled={busy} onclick={ask}>check</button>
      <button class="small" disabled={busy} onclick={forget}>clear</button>
      {#if note}<span class="dim">{note}</span>{/if}
    {/if}
    {#if error}<span class="err">{error}</span>{/if}
  </svelte:element>
{/if}

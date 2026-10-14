<script lang="ts">
  import { untrack } from 'svelte'
  import Loading from '../../shared/Loading.svelte'
  import { loadingDelay } from '../../shared/loading-delay.svelte'

  let { onloading, waited }: {
    onloading?: (loading: boolean) => void
    /** A wait already running for the same operation, so a later loading step does not restart it. */
    waited?: () => boolean
  } = $props()
  const report = untrack(() => onloading)
  const visible = untrack(() => waited) ?? loadingDelay(() => true)
  $effect(() => {
    if (!visible() || !report) return
    report(true)
    return () => report(false)
  })
</script>

{#if visible() && !report}<Loading label="loading replies…" />{/if}

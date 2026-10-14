<script lang="ts" generics="T">
  // Refresh changes the snippet's arguments, not its lifetime, so keyed rows,
  // focus, image state and open reply branches survive the new result.
  import type { Snippet } from 'svelte'
  import { firstDisplay } from './first-screen.svelte'
  import { Resource } from './resource.svelte'
  import LoadError from './LoadError.svelte'
  import Loading from './Loading.svelte'

  let { request, identity = null, loading = 'loading…', what, children, onretry, onshown, settleFirstScreen = false }: {
    request: Promise<T>
    identity?: unknown
    loading?: string | Snippet
    /** Include this read in an enclosing stream row's initial reveal. */
    settleFirstScreen?: boolean
    /** What failed to load, for the error line. */
    what?: string
    children: Snippet<[T]>
    onretry?: () => void
    onshown?: (value: T) => void
  } = $props()
  const view = new Resource<T>()
  $effect(() => view.watch(request, identity, onshown))
  let result = $derived(view.result?.key === identity ? view.result : null)
  let error = $derived(view.failure(identity))
  firstDisplay(() => !settleFirstScreen || result !== null || error !== null)
</script>

{#if result}
  {@render children(result.value)}
{:else if !error}
  <!-- A text label is the spinner's name for screen readers. -->
  {#if typeof loading === 'string'}<Loading label={loading} />
  {:else}{@render loading()}{/if}
{/if}
{#if error}<LoadError {error} updating={result !== null} {what} {onretry} />{/if}

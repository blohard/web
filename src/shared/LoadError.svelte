<script lang="ts">
  // A read that failed, with the way to try again. `updating` says a result
  // is still on screen and only its update failed; `what` names it.
  import { explain } from '../lib/errors'

  let { error, updating = false, what = '', onretry }: {
    error: { cause: unknown }
    updating?: boolean
    what?: string
    onretry?: () => void
  } = $props()
</script>

<p class="err small" role="status">
  {#if updating}could not update{what ? ` ${what}` : ''}. {/if}{explain(error.cause)}
  {#if onretry}<button class="small" onclick={onretry}>try again</button>{/if}
</p>

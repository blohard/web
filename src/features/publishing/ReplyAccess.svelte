<script lang="ts">
  import type { ReplyAccess } from './reply-access'
  import { href } from '../navigation/router.svelte'
  import type { ChainInfo } from '../../lib/types'
  import Name from '../../components/Name.svelte'

  let { chain, access, pending, failed, onretry }: {
    chain: ChainInfo; access: ReplyAccess; pending: boolean; failed: boolean; onretry: () => void
  } = $props()
</script>

{#if access || failed}
  <div class="small reply-access" role="status">
    {#if access}
      {#if access.kind === 'closed'}no new replies to this post
      {:else if access.kind === 'blocked'}this author has blocked your account. buying a key will not remove the block
      {:else if access.kind === 'inactive'}this post requires a key, but the author has not activated their keys yet{access.blocked ? '.' : ''}
      {:else if access.kind === 'keys'}you need a key to <Name address={access.creator} /> to reply. {#if !access.blocked}<a href={href.userKeys(chain.id, access.creator)} target="_blank" rel="noopener noreferrer">buy a key</a>{/if}{/if}
      {#if access.blocked}this author has blocked your account, so your reply will be folded for readers. buying a key will not remove the block{/if}
    {/if}
    {#if failed}<span class="dim">could not check the reply rule.</span>{/if}
    {#if failed}<button disabled={pending} onclick={onretry}>try again</button>{/if}
  </div>
{/if}

<style>
  .reply-access { margin: .5rem 0; }
</style>

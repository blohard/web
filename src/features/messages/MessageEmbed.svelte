<script lang="ts">
  import type { Address } from 'viem'
  import type { ChainInfo } from '../../lib/types'
  import { host } from '../../lib/host.svelte'
  import { hostPreviewLink, previewPost } from './link-preview'
  import LinkPreview from './LinkPreview.svelte'
  import QuoteCard from './QuoteCard.svelte'

  let { text, chain, author, id, reloadKey, preview = false }: {
    text: string; chain: ChainInfo; author: Address; id?: bigint; reloadKey?: unknown; preview?: boolean
  } = $props()
  const link = $derived(hostPreviewLink(text))
  const quoted = $derived(previewPost(text, host.status?.store?.attachments?.max_per_message ?? 4))
</script>

{#snippet fallback()}
  {#if quoted}
    {#key `${quoted.chainId}/${quoted.id}/${quoted.commit ?? ''}`}
      <QuoteCard {...quoted} here={chain} {reloadKey} {preview} />
    {/key}
  {/if}
{/snippet}

{#if link}
  {#key link.url}
    <LinkPreview {link} post={id === undefined ? undefined : { chain: chain.id, id }} {author} {fallback} />
  {/key}
{:else}
  {@render fallback()}
{/if}

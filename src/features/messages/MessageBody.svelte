<script lang="ts">
  // Display an already-fetched body. Cards own fetching and moderation; this
  // component owns escaped text, bounded links/references, attachment hydration and notices.
  import { untrack, type Snippet } from 'svelte'
  import type { Address } from 'viem'
  import { notice, type Body } from '../../lib/body'
  import { host } from '../../lib/host.svelte'
  import { messageText, type TextSegment } from './message-text'
  import { names } from '../../lib/names.svelte'
  import { href, router } from '../navigation/router.svelte'
  import { hydrateRecords } from './record-images'
  import { firstDisplay } from '../../shared/first-screen.svelte'
  import type { Quote } from '../../lib/reference-syntax'
  import BodyPreview from './BodyPreview.svelte'

  let { body, chainId, id, author, detail = '', quote, record, linkPreview, previewHref = null, expandable = false }: {
    body: Body
    chainId: number
    id?: bigint
    author: Address
    detail?: string
    /** Omit inside a quote: references remain links, so previews never nest. */
    quote?: Snippet<[Quote]>
    /** One automatic card; the caller suppresses it when an explicit quote takes priority. */
    linkPreview?: Snippet
    previewHref?: string | null
    expandable?: boolean
    /** Drafts may show their local picture bytes before publication. */
    record?: Snippet<[Extract<TextSegment, { kind: 'record' }>]>
  } = $props()

  let pendingPictures = $state(0)
  firstDisplay(() => pendingPictures === 0)
  function pictures(root: HTMLElement) {
    return hydrateRecords(root, () => {
      untrack(() => pendingPictures++)
      return () => { untrack(() => pendingPictures--) }
    })
  }

  const text = $derived(body.kind === 'text' ? body.text : '')
  const quotes = $derived(quote !== undefined)
  const maxAttachments = $derived(host.status?.store?.attachments?.max_per_message ?? 4)
  const segments = $derived(messageText(text, { quotes, maxAttachments }))
  // Quotes own their preview limit; only the text between them is clipped here.
  type Section = Extract<TextSegment, { kind: 'quote' }> | { kind: 'body'; segments: TextSegment[] }
  const sections = $derived.by(() => {
    const result: Section[] = []
    for (const seg of segments) {
      if (seg.kind === 'quote') result.push(seg)
      else {
        const last = result.at(-1)
        if (last?.kind === 'body') last.segments.push(seg)
        else result.push({ kind: 'body', segments: [seg] })
      }
    }
    return result
  })
  const firstQuote = $derived(sections.findIndex(section => section.kind === 'quote'))
</script>

{#snippet part(items: TextSegment[])}
  <div class="message-text" data-chain={chainId} data-message={id} data-author={author} {@attach pictures}>
    {#each items as seg (seg)}
      {#if seg.kind === 'quote' && quote}
        {@render quote(seg)}
      {:else if seg.kind === 'record' && record}
        {@render record(seg)}
      {:else if seg.kind === 'record'}
        <div class="rec placeholder" class:rec-image={seg.image} data-record={seg.hash} data-alt={seg.label}></div>
      {:else}
        <span class="run" class:bold={seg.style === 'bold' || seg.style === 'bold-italic'} class:italic={seg.style === 'italic' || seg.style === 'bold-italic'}>
          {#if seg.kind === 'text'}{seg.text}
          {:else if seg.kind === 'link'}<a href={seg.href} target="_blank" rel="noopener noreferrer">{seg.text}</a>
          {:else if seg.kind === 'mention'}<a class="mention" href={href.user(chainId, seg.address)} target={router.embed ? '_blank' : undefined} rel={router.embed ? 'noopener noreferrer' : undefined}>@{names.display(seg.address)}</a>
          {:else if seg.kind === 'post'}<a class="post-link" href={href.thread(seg.chainId, seg.id, seg.commit)} target={router.embed ? '_blank' : undefined} rel={router.embed ? 'noopener noreferrer' : undefined}>#{seg.id}</a>{/if}
        </span>
      {/if}
    {/each}
  </div>
{/snippet}

{#if body.kind === 'text'}
  {#each sections as section, i}
    {#if section.kind === 'quote'}
      {#if i === firstQuote}{@render linkPreview?.()}{/if}
      {@render part([section])}
    {:else}
      <BodyPreview href={previewHref} {expandable}>
        {@render part(section.segments)}
      </BodyPreview>
    {/if}
  {/each}
  {#if firstQuote < 0}{@render linkPreview?.()}{/if}
{:else}
  {@const n = notice(body, detail)}
  <span class={n.err ? 'err' : 'placeholder'}>{n.text}</span>
{/if}

<style>
  .message-text { overflow-wrap: anywhere; }
  .run { white-space: pre-wrap; }
  .bold { font-weight: bold; }
  .italic { font-style: italic; }
</style>

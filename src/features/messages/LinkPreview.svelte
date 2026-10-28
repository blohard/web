<script lang="ts">
  import type { Snippet } from 'svelte'
  import Loading from '../../shared/Loading.svelte'
  import { Resource } from '../../shared/resource.svelte'
  import { PreviewQueueFull, linkPreviews, type PreviewLink, type PreviewPost } from './link-preview'
  import { opensPictures } from './record-images'

  let { link, post, author, fallback }: { link: PreviewLink; post?: PreviewPost; author: string; fallback?: Snippet } = $props()
  const url = $derived(link.url)
  const metadata = new Resource<Awaited<ReturnType<typeof linkPreviews.read>>>()
  const domain = $derived(new URL(url).hostname)
  let chosen = $state<boolean | null>(null)
  let failedImage = $state(false)
  let loadedImage = $state(false)
  const open = $derived(chosen ?? (!!link.localPath || opensPictures(author)))
  const value = $derived(metadata.value(url))
  let retry = $state(0)
  const busy = $derived(metadata.failure(url)?.cause instanceof PreviewQueueFull)
  $effect(() => { void retry; return metadata.watch(linkPreviews.read(link, post), url) })
</script>

{#if value}
  <aside class="link-preview" aria-label="link preview">
    <a class="text" href={url} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
      <!-- The arrow marks a card that leads off this site; a string keeps its space, which Svelte trims from text. -->
      <span class="domain small">{domain}{#if !link.localPath}<span aria-hidden="true">{' ↗'}</span>{/if}</span>
      <span class="title">{value.title || domain}</span>
      <span class="description small dim">{value.description || 'open link'}</span>
    </a>
    <div class="thumbnail">
      <div class="picture">
        {#if value.image && open}
          {#if failedImage}
            <span class="small dim">image unavailable</span>
          {:else}
            <!-- Under the image, which covers it as it arrives. -->
            {#if !loadedImage}<div class="image-wait"><Loading label="loading image…" /></div>{/if}
            <a href={url} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
              <img src={value.image} alt="" loading="lazy" referrerpolicy="no-referrer" onload={() => { loadedImage = true }} onerror={() => { failedImage = true }} />
            </a>
          {/if}
        {/if}
      </div>
      {#if value.image}
        <!-- One button both shows and hides, so focus stays on it: while the image is hidden it fills the square. -->
        <button class="small" class:reveal={!open} class:media-dismiss={open} aria-label={open ? 'hide image' : 'show image'} type="button" onclick={() => { chosen = !open; if (chosen) failedImage = false }}>{open ? 'hide' : 'show image'}</button>
      {/if}
    </div>
  </aside>
{:else if busy}
  <div class="small dim">
    preview queue is full <button class="small" type="button" onclick={() => retry++}>try preview again</button>
  </div>
{:else if metadata.result?.key === url || metadata.failure(url)}
  {@render fallback?.()}
{/if}

<style>
  /* Like quotes, link cards use a tinted background. On a tinted post,
     such as a thread's focused one, they take the page colour instead (app.css). */
  .link-preview { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) min(30%, 8rem); margin: .6rem 0; border: 1px solid var(--border); border-radius: .4rem; overflow: hidden; background: var(--tint); }
  .text { display: block; padding: .6rem .8rem; color: inherit; text-decoration: none; }
  .domain { display: block; height: 1.5em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent); }
  .title, .description { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; line-height: 1.5; height: 3em; }
  .title { font-weight: bold; }
  /* The reveal button shares the image square; dismissing needs no extra row. */
  .thumbnail { display: grid; place-items: center; padding: .6rem .6rem .6rem 0; align-self: center; min-width: 0; }
  .thumbnail > button { white-space: normal; line-height: 1.2; }
  /* Transparent, so the square kept for an image is no empty box on a card without one. */
  .picture { grid-area: 1 / 1; width: 100%; aspect-ratio: 1; overflow: hidden; display: grid; place-items: center; }
  .picture span { text-align: center; font-size: .7rem; }
  .picture a { grid-area: 1 / 1; width: 100%; height: 100%; min-height: 0; }
  .picture img { display: block; width: 100%; height: 100%; object-fit: contain; }
  /* A loading image's spinner shares its cell, and appears only after a moment, so a quick or cached image never flashes it. */
  .image-wait { grid-area: 1 / 1; animation: image-wait 0s .3s backwards; }
  @keyframes image-wait { from { opacity: 0; } }
  /* While the image is hidden, its button moves up into the square as a dashed box, and pressing anywhere in it shows the image.
     Its dashes are dim, not the border colour, which nearly vanishes on the card's tint. */
  .reveal { grid-area: 1 / 1; place-self: stretch; padding: .3rem; border: 1px dashed var(--dim); border-radius: .3rem; }
  .reveal::before, .reveal::after { content: none; }
  .reveal:hover { border-color: var(--accent); }
</style>

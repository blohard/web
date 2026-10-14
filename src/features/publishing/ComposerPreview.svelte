<script lang="ts">
  import type { Address } from 'viem'
  import type { ChainInfo } from '../../lib/types'
  import type { PostRecord } from './pending'
  import { blockPreviewNavigation } from './composer-preview'
  import { modal } from '../../shared/modal'
  import Avatar from '../../components/Avatar.svelte'
  import Name from '../../components/Name.svelte'
  import MessageBody from '../messages/MessageBody.svelte'
  import QuoteCard from '../messages/QuoteCard.svelte'
  import DraftPicture from './DraftPicture.svelte'
  import MessageEmbed from '../messages/MessageEmbed.svelte'

  let { chain, author, text, records, parentId, onclose }: {
    chain: ChainInfo; author: Address; text: string; records: PostRecord[]; parentId: bigint; onclose: () => void
  } = $props()
  const title = $props.id()
</script>

<dialog use:modal={onclose} aria-labelledby={title} onclose={onclose}>
  <header>
    <h2 id={title}>{parentId ? 'reply preview' : 'post preview'}</h2>
    <button class="close" type="button" aria-label="close preview" onclick={onclose}>×</button>
  </header>
  <!-- Navigation is suppressed in capture phase, before the app router or quote controls see it. -->
  <div class="preview-post" onclickcapture={blockPreviewNavigation} onauxclickcapture={blockPreviewNavigation}
    oncontextmenucapture={blockPreviewNavigation} onkeydowncapture={blockPreviewNavigation}>
    {#if parentId}<div class="context small dim">in reply to #{parentId}</div>{/if}
    <article class="msg">
      <div class="grid">
        <div class="avatar-col"><Avatar address={author} /></div>
        <div class="content">
          <div class="meta"><span class="name"><Name address={author} /></span></div>
          <div class="body">
            {#snippet embed()}
              <MessageEmbed {text} {chain} {author} preview />
            {/snippet}
            <MessageBody body={{ kind: 'text', text }} chainId={chain.id} {author} expandable linkPreview={embed}>
              {#snippet quote(q)}
                <QuoteCard chainId={q.chainId} id={q.id} commit={q.commit} here={chain} preview />
              {/snippet}
              {#snippet record(r)}
                {@const local = records.find(a => a.hash.toLowerCase() === r.hash)}
                {#if local && r.image}
                  <DraftPicture record={local} label={r.label} />
                {:else}
                  <div class="rec placeholder" class:rec-image={r.image} data-record={r.hash} data-alt={r.label}></div>
                {/if}
              {/snippet}
            </MessageBody>
          </div>
        </div>
      </div>
    </article>
  </div>
</dialog>

<style>
  dialog { width: min(64ch, calc(100% - 2rem)); max-width: none; max-height: calc(100dvh - 2rem); margin: auto; padding: 0; color: var(--fg); background: var(--bg); border: 1px solid var(--border); box-shadow: 0 1rem 4rem #0006; overflow: auto; overscroll-behavior: contain; }
  dialog::backdrop { background: #0009; }
  header { display: flex; align-items: center; justify-content: space-between; padding: .3rem 1rem; border-bottom: 1px dashed var(--border); position: sticky; top: 0; background: var(--bg); z-index: 1; }
  .close { min-width: 44px; min-height: 44px; font-size: 1.5rem; padding: 0; }
  .close::before, .close::after { content: none; }
  .context { padding: .5rem 1rem 0; }
  article.msg { border: 0; }
  .preview-post :global(img.zoomable) { pointer-events: none; cursor: default; }
  @media (max-width: 480px) { dialog { width: calc(100% - 1rem); max-height: calc(100dvh - 1rem); } }
</style>

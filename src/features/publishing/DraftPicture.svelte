<script lang="ts">
  import type { PostRecord } from './pending'
  import { decode, isInlineImage } from '../../lib/envelope'
  let { record, label }: { record: PostRecord; label: string } = $props()
  const decoded = $derived(decode(record.bytes))
  let hidden = $state(false)
  let opened = $state(false)
  let failed = $state(false)

  function picture(node: HTMLImageElement) {
    if (!decoded.ok || !isInlineImage(decoded.envelope.mediaType)) return
    const url = URL.createObjectURL(new Blob([decoded.envelope.body.slice()], { type: decoded.envelope.mediaType }))
    node.src = url
    return () => URL.revokeObjectURL(url)
  }
</script>

{#if decoded.ok && isInlineImage(decoded.envelope.mediaType)}
  <div class="rec-image-box" data-opened-picture={opened && !hidden}>
    <div class="rec-image-bar small">
      <span class="name">{label}</span>
      <button type="button" class="small" onclick={() => { hidden = !hidden; opened = !hidden }}>{hidden ? 'show picture' : 'hide picture'}</button>
    </div>
    <div class="rec-image-stage" {hidden}>
      {#if failed}<span class="dim">this picture could not be decoded</span>
      {:else}<img alt={label} {@attach picture} onerror={() => { failed = true }} />{/if}
    </div>
  </div>
{:else}
  <span class="placeholder">{label}, an attachment this client does not open</span>
{/if}

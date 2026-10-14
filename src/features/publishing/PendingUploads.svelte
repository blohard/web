<script lang="ts">
  // Posts whose bytes a host has not stored yet, from any earlier visit: the
  // upload failed, or the host holds them until the chain confirms the
  // message. Signed requests and known transactions stay until stored or
  // explicitly discarded; abandoned unsigned drafts expire after an hour.
  import { explain } from '../../lib/errors'
  import { fmtBytes, shortHex } from '../../lib/format'
  import { publications, type Publication } from './publications.svelte'
  import { href } from '../navigation/router.svelte'
  import { Resource } from '../../shared/resource.svelte'
  import type { ChainInfo } from '../../lib/types'
  import Notice from '../../shared/Notice.svelte'

  let { chain, reloadRevision = 0, onchanged }: { chain: ChainInfo; reloadRevision?: number; onchanged?: () => void } = $props()

  const saved = new Resource<Publication[]>()
  let key = $derived(`${chain.id}:${chain.contract.toLowerCase()}`)
  let request = $derived.by(() => {
    void reloadRevision
    return publications.list(chain.id)
  })
  let groups = $derived((saved.value(key) ?? []).filter((op) => !op.done))
  let loadError = $derived(saved.failure(key))

  $effect(() => {
    const c = chain, read = request
    const stop = saved.watch(read, key)
    let active = true
    // Resource guards the displayed result. Start recovery only while this
    // subscription is current; operations already started survive navigation.
    void read.then((operations) => {
      if (active) for (const op of operations) op.start(c)
    }, () => {})
    return () => { active = false; stop() }
  })

  async function finish(c: ChainInfo, op: Publication) {
    try { await op.retry(c) } catch { /* The operation retains the error and its backoff. */ }
  }

  async function discard(op: Publication) {
    const c = chain
    try {
      await op.discard(c, () => confirm(op.reverted
        ? 'discard these words?\n\nthe transaction reverted, so nothing was posted. this is the only copy left.'
        : 'discard these saved bytes?\n\nif the post was sent, it could be left without its content forever. this does not cancel a transaction. discard only once you are sure the bytes are not needed.'))
    } catch { /* The operation shows the error and keeps the bytes. */ }
  }

  $effect(() => publications.watch((post) => {
    if (post.chainId === chain.id) onchanged?.()
  }))
</script>

{#if loadError}
  <Notice>could not read saved uploads. {explain(loadError.cause)}</Notice>
{/if}
{#if groups.length}
  <Notice>
    <div class="small dim">
      uploads not yet stored by the host. they are kept here until a host confirms them, and held ones are stored once the chain confirms the post
    </div>
    {#each groups as g (g.post.key)}
      {@const held = g.post.records.some((r) => r.status === 'held')}
      {@const attachments = g.post.records.filter((r) => r.kind === 'attachment').length}
      <div class="row small" style="margin-top: 0.4rem">
        <span class="grow mono-break">
          {#if g.post.messageId !== null}<a href={href.thread(chain.id, g.post.messageId)}>#{g.post.messageId}</a>{:else if g.post.txHash}<span class="dim">tx {shortHex(g.post.txHash)}</span>{:else}<span class="dim">unknown id</span>{/if}
          · body {shortHex(g.post.bodyHash)}
          {#if attachments}· {attachments} attachment{attachments > 1 ? 's' : ''}{/if}
          · {fmtBytes(g.post.records.reduce((n, r) => n + r.bytes.length, 0))}
          {#if held}· <span class="ok">held</span>{/if}
          {#if g.outcome}<span class:err={g.outcome.kind === 'err'}>, {g.outcome.note}</span>{/if}
          {#if g.warning}<span class="err"> · {g.warning}</span>{/if}
        </span>
        {#if !g.reverted}
          <button onclick={() => finish(chain, g)} disabled={g.busy}>{g.busy ? 'uploading…' : 'retry'}</button>
        {/if}
        <button class="danger" onclick={() => discard(g)} disabled={g.busy}>discard</button>
      </div>
      {#if g.reverted && g.text}
        <details class="small">
          <summary>show the words</summary>
          <p class="mono-break" style="white-space: pre-wrap; margin: 0.3rem 0 0">{g.text}</p>
        </details>
      {/if}
    {/each}
  </Notice>
{/if}

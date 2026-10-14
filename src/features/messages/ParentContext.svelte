<script lang="ts">
  // "In reply to …": the parent's author, id and first line, so a reply is
  // never shown without what it answers (CLIENT.md).
  import { host } from '../../lib/host.svelte'
  import { ENDING_LABEL, endingOf, type Ending } from '../../lib/board'
  import { explain } from '../../lib/errors'
  import { getMessage } from '../../lib/messages'
  import { loadBody } from '../../lib/content'
  import { gates as ledger } from '../../lib/gates.svelte'
  import { excerpt } from '../../lib/format'
  import { href } from '../navigation/router.svelte'
  import type { ChainInfo } from '../../lib/types'
  import Name from '../../components/Name.svelte'
  import BotMark from '../../components/BotMark.svelte'
  import { Resource } from '../../shared/resource.svelte'
  import { firstDisplay } from '../../shared/first-screen.svelte'

  let { chain, parentId, reloadKey }: { chain: ChainInfo; parentId: bigint; reloadKey?: unknown } = $props()

  type Parent = { author: `0x${string}`; ending: Ending; line: string | null }

  async function load(id: bigint, _reloadKey: unknown): Promise<Parent> {
    const [m, gate] = await Promise.all([getMessage(chain, id), ledger.ensureMessage(chain, id)])
    const ending = endingOf(gate)
    let line: string | null = null
    if (!ending && !host.blocked(m.author)) {
      const body = await loadBody(m.contentHash, { chainId: chain.id, messageId: id })
      if (body.kind === 'text') line = excerpt(body.text)
    }
    return { author: m.author, ending, line }
  }

  let parent = $derived(load(parentId, reloadKey))
  let identity = $derived(`${chain.id}/${chain.contract}/${parentId}`)
  const view = new Resource<Parent>()
  $effect(() => view.watch(parent, identity))
  let p = $derived(view.value(identity))
  let error = $derived(view.failure(identity))
  firstDisplay(() => p !== null || error !== null)
</script>

<a class="context" href={href.thread(chain.id, parentId)}>
  {#if p && host.blocked(p.author)}
    <span class="dim">in reply to #{parentId} · post blocked by host</span>
  {:else if p}
    <span class="dim">in reply to</span>
    <span class="who"><Name address={p.author} /><BotMark address={p.author} /></span>
    <span class="dim">#{parentId}</span>
    {#if p.ending}
      <span class="dim">· {ENDING_LABEL[p.ending]}</span>
    {:else if p.line}
      <span class="line">· {p.line}</span>
    {/if}
  {:else}
    <span class="dim">in reply to #{parentId}{error ? '' : '…'}</span>
  {/if}
  {#if error}<span class="err small">({explain(error.cause)})</span>{/if}
</a>

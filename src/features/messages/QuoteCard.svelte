<script lang="ts">
  // A message quoted inside another: the pinned reference of the protocol
  // spec (§7), or a pasted post URL, resolved when viewed. Who wrote it and when, then the
  // first lines of its body; the whole card opens the original's thread. A
  // reference inside the quoted message stays a link (MessageBody), so a chain
  // of quotes is never a chain of cards.
  import { untrack } from 'svelte'
  import type { Address, Hex } from 'viem'
  import { endingOf, type Ending } from '../../lib/board'
  import { resolveQuote } from '../../lib/messages'
  import type { Body } from '../../lib/body'
  import { loadBody } from '../../lib/content'
  import { gates as ledger } from '../../lib/gates.svelte'
  import { chainLabel } from '../../lib/chains'
  import { timeAgo } from '../../lib/format'
  import { host } from '../../lib/host.svelte'
  import Loading from '../../shared/Loading.svelte'
  import { muted } from '../../lib/muted.svelte'
  import { href, router } from '../navigation/router.svelte'
  import type { ChainInfo } from '../../lib/types'
  import Avatar from '../../components/Avatar.svelte'
  import BodyPreview from './BodyPreview.svelte'
  import Name from '../../components/Name.svelte'
  import BotMark from '../../components/BotMark.svelte'
  import MessageBody from './MessageBody.svelte'
  import Retained from '../../shared/Retained.svelte'

  /** `here` is the chain of the post doing the quoting; a quote from elsewhere says so. */
  let { chainId, id, commit, here, reloadKey, preview = false }: { chainId: number; id: bigint; commit?: Hex; here: ChainInfo; reloadKey?: unknown; preview?: boolean } = $props()

  let chain = $derived(host.chain(chainId) ?? null)
  let thread = $derived(href.thread(chainId, id, commit))

  type Quoted = { author: Address; timestamp: number; ending: Ending; body: Body | null }

  /** The key this card mounted with: loads under it are first loads, and a later one reloads the reference. */
  const mounted = untrack(() => reloadKey)
  async function load(c: ChainInfo, id: bigint, pin: Hex | undefined, key: unknown, _attempt: number): Promise<Quoted | null> {
    // A stopped index or failed pin check replaces any retained preview.
    const record = await resolveQuote(c, id, pin, key !== mounted)
    if (!record) return null
    const ending = endingOf(await ledger.ensureMessage(c, id))
    const body = ending || host.blocked(record.author) ? null : await loadBody(record.contentHash, { chainId: c.id, messageId: id })
    return { author: record.author, timestamp: record.timestamp, ending, body }
  }
  /** Bumped by the error line's retry: asks again without changing the load key. */
  let attempt = $state(0)
  let quoted = $derived(chain ? load(chain, id, commit, reloadKey, attempt) : null)
  let revealed = $state(false)

  /** The card opens the quoted thread; links inside keep their own meaning, and the enclosing row stays put. */
  function open(e: MouseEvent) {
    if (preview) return
    const t = e.target as HTMLElement
    if (t.closest('a, button, img')) return
    if (window.getSelection()?.toString()) return
    e.stopPropagation()
    router.go(thread)
  }
</script>

{#if !chain}
  <div class="quote small dim">quotes post #{id} on {host.label(chainId)}, which this host does not serve</div>
{:else if quoted}
  <!-- Inside a post body, so the small spinner that keeps a line's height. -->
  {#snippet quoteLoading()}<Loading label="loading the quoted post…" inline />{/snippet}
  <Retained request={quoted} identity={`${chain.id}/${chain.contract}/${id}/${commit}`} loading={quoteLoading} what="the quoted post" onretry={() => attempt++}>
    {#snippet children(q)}
    {#if q === null}
      <div class="quote small dim">the quoted post is unavailable or no longer matches this reference.</div>
    {:else if host.blocked(q.author)}
      <div class="quote small dim">quoted post blocked by host</div>
    {:else if q.ending}
      <!-- Deleted and removed posts appear only as thread or reply context. -->
    {:else if muted.has(q.author) && !revealed}
      <div class="quote small dim">
        quotes <a href={href.user(chain.id, q.author)}><Name address={q.author} /></a>, whom you muted
        <button class="small" onclick={() => (revealed = true)}>show</button>
      </div>
    {:else}
      <!-- The post-number link is the keyboard target; other links keep their own roles. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="quote" class:link={!preview} onclick={open}>
        <div class="qhead small">
          <Avatar address={q.author} size={18} />
          <a class="author" href={href.user(chain.id, q.author)}><Name address={q.author} /></a><BotMark address={q.author} />
          <span class="dim">·</span>
          <a class="dim" href={thread} aria-label={`open quoted post #${id}`}>#{id}</a>
          <span class="dim">·</span>
          <span class="dim" title={new Date(q.timestamp * 1000).toISOString()}>{timeAgo(q.timestamp)}</span>
          {#if chain.id !== here.id}
            <span class="dim">·</span>
            <span class="dim" title="quoted from another chain">{chainLabel(chain)}</span>
          {/if}
        </div>
        <div class="qbody">
          {#if q.body}
            <BodyPreview href={thread} lines={7} expandable={preview}>
              <MessageBody body={q.body} chainId={chain.id} {id} author={q.author} />
            </BodyPreview>
          {/if}
        </div>
      </div>
    {/if}
    {/snippet}
  </Retained>
{/if}

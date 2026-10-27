<script lang="ts">
  import { isClosedReplyRule } from '../publishing/reply-rules'
  // A discussion section for another site's page: the direct replies to one
  // post of this host's chain, read-only here, with a link to reply in the
  // app. The page owner writes the post and pastes public/embed.js with its
  // id; the post's author moderates the thread like any other (DESIGN.md §5.6).
  import { endingOf, isDeactivated, type Ending } from '../../lib/board'
  import { getStatus } from '../../lib/store'
  import { embedDiscussion } from './embed-discussion.svelte'
  import { watchHostPolicy } from '../../lib/host-policy'
  import { host } from '../../lib/host.svelte'
  import { gates } from '../../lib/gates.svelte'
  import { readRoot, type ReplyPage, type ReplySessions } from '../streams/replies'
  import { href } from '../navigation/router.svelte'
  import type { ChainInfo } from '../../lib/types'
  import mark from '../../assets/whale-mark.jpg'
  import Replies from '../streams/Replies.svelte'
  import Retained from '../../shared/Retained.svelte'

  const params = new URLSearchParams(location.search)
  const chainId = Number(params.get('chain'))
  const idText = params.get('post') ?? ''
  const id = /^\d+$/.test(idText) ? BigInt(idText) : null

  type Page = { chain: ChainInfo; replies: ReplyPage; ending: Ending; deactivated: boolean; closed: boolean }

  const sessions: ReplySessions = new Map()

  async function load(_v: number): Promise<Page> {
    if (!Number.isInteger(chainId) || id === null) throw new Error('the widget link needs a valid chain and post')
    const status = await getStatus()
    host.status = status
    const chain = status.chains.find((c) => c.id === chainId)
    if (!chain) throw new Error('this host does not serve the requested chain')
    const { record: m, gate, replies } = await readRoot(sessions, chain, id)
    return { chain, replies, ending: endingOf(gate), closed: isClosedReplyRule(chain, gate, gates.author(chain, m.author)), deactivated: isDeactivated(gate, gates.author(chain, m.author)) }
  }
  const discussion = embedDiscussion(load)
  $effect(() => watchHostPolicy())

  // In the frame every in-app link is an absolute app URL (router.svelte.ts) and the
  // page's default target is a new tab (embed.html), so plain links do.
  /** The about page of the site serving this frame. */
  const about = href.about()
  /** Commenting on the page's post happens in the app: its thread with the reply box open. Each comment carries its own reply link. */
  const commentUrl = id === null ? '' : href.reply(chainId, id)

  /**
   * What the frame does that a page does not: it tells the page around it how
   * tall the discussion is, and reloads when the reader comes back to the
   * tab, since they may have replied in the app meanwhile.
   */
  function framed(node: HTMLElement) {
    const back = () => {
      if (document.visibilityState === 'visible') discussion.returned()
    }
    document.addEventListener('visibilitychange', back)
    if (window.parent === window) return () => document.removeEventListener('visibilitychange', back)
    // The content's own height, not the document's: a document is never shorter than its
    // frame, so measuring it would let the frame grow but never shrink back.
    // Several signals can report the same layout; the page hears about a height once.
    let reported = -1
    const send = () => {
      const height = Math.ceil(node.getBoundingClientRect().height)
      if (height === reported) return
      reported = height
      window.parent.postMessage({ type: 'blohard:height', height }, '*')
    }
    // A resize observer is the natural signal, but not every engine delivers it
    // reliably inside a frame (Safari on iOS left the frame at its starting
    // size), so every other way the height can change reports as well: any
    // change to the content, a picture finishing loading, fonts arriving, the
    // window itself resizing, and the page's load.
    const ro = new ResizeObserver(send)
    ro.observe(node)
    const mo = new MutationObserver(() => requestAnimationFrame(send))
    mo.observe(node, { childList: true, subtree: true, attributes: true, characterData: true })
    node.addEventListener('load', send, true)
    window.addEventListener('resize', send)
    window.addEventListener('load', send)
    document.fonts?.ready.then(send)
    send()
    return () => {
      document.removeEventListener('visibilitychange', back)
      ro.disconnect()
      mo.disconnect()
      node.removeEventListener('load', send, true)
      window.removeEventListener('resize', send)
      window.removeEventListener('load', send)
    }
  }
</script>

<div class="embed" {@attach framed}>
  <Retained request={discussion.page} loading="loading the discussion…" onretry={discussion.refresh}>
    {#snippet children(p)}
    {@const count = p.replies.counts.get(id!) ?? 0}
    {@const open = !p.ending && !p.deactivated && !p.closed}
    <div class="embed-bar small">
      <span class="dim">{count === 0 ? 'no comments yet' : `${count} ${count === 1 ? 'comment' : 'comments'}`}</span>
      {#if open}<a class="comment-root" href={commentUrl} rel="noopener" title="write a comment on this page's post, in the app">write a comment</a>{/if}
      <button class="small" onclick={discussion.refresh} title="reload the discussion">↻ refresh</button>
      <span class="grow"></span>
      <span class="powered dim">powered by <a href={about} rel="noopener"><img src={mark} alt="" width="18" height="18" />blohard</a></span>
    </div>
    {#if p.ending === 'deleted'}
      <p class="dim small">the original post was deleted. new comments are closed</p>
    {:else if p.ending === 'removed'}
      <p class="dim small">the original post was removed by the author of the post it replied to. new comments are closed</p>
    {:else if p.closed}
      <p class="dim small">no new comments on this post</p>
    {:else if p.deactivated}
      <p class="dim small">the author's account is deactivated, so new comments are closed</p>
    {/if}
    <Replies gateRefreshReady={discussion.gateRefreshReady} chain={p.chain} parentId={id!} data={p.replies} />
    {#if open && count >= 5}
      <div class="embed-foot small"><a class="comment-root" href={commentUrl} rel="noopener" title="write a comment on this page's post, in the app">write a comment</a></div>
    {/if}
    {/snippet}
  </Retained>
</div>

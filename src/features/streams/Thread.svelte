<script lang="ts">
  // A thread shows the addressed post with its immediate parent above it,
  // then its reply box and replies. Older context is added on request,
  // keeping open replies mounted.
  // An addressed deleted or removed post stays as a compact placeholder;
  // its direct replies remain accessible without exposing its old content.
  import { onDestroy, tick as rendered, untrack } from 'svelte'
  import type { Hex } from 'viem'
  import { gates } from '../../lib/gates.svelte'
  import ReplyCount from './ReplyCount.svelte'
  import { endingOf, hasResponseRight } from '../../lib/board'
  import { explain } from '../../lib/errors'
  import { refreshCue } from '../../shared/refresh-cue.svelte'
  import { notificationDot } from '../notifications/notification-dot.svelte'
  import { peekReplies, readThread, readEarlier, type ReplyPage } from './replies'
  import { hasDraft, replying } from '../publishing/replying.svelte'
  import { plainClick, href, router } from '../navigation/router.svelte'
  import { holdInView, revealWhen } from '../navigation/scroll'
  import { rememberPage, returning as visitReturning } from '../navigation/visit-position'
  import type { RecordImage } from '../../lib/api'
  import type { ChainInfo, MessageRecord } from '../../lib/types'
  import { wallet } from '../../lib/wallet.svelte'
  import InlineReply from '../publishing/InlineReply.svelte'
  import MessageCard from '../messages/MessageCard.svelte'
  import Replies from './Replies.svelte'
  import { threadView } from './thread-view'
  import Retained from '../../shared/Retained.svelte'

  let { chain, id, commit, refreshRevision = 0, focusReply = false, focusReplies = false }: { chain: ChainInfo; id: bigint; commit?: Hex; refreshRevision?: number; focusReply?: boolean; focusReplies?: boolean } = $props()

  const saved = untrack(() => threadView(chain, id))
  const returning = visitReturning()
  const initialRevision = untrack(() => refreshRevision)
  const box = untrack(() => replying.box())

  let repliesLoading = $state(false)
  let localReloadRevision = $state(0)
  let reloadRevision = $derived(refreshRevision + localReloadRevision)
  // The post's own reply box is the page's shared one (features/publishing/replying.svelte.ts),
  // so it survives Back and Forward like every other. A reply link (?reply)
  // presses it on arrival, and so does a reply already begun elsewhere, say
  // in a stream before "read full post": the draft is the post's, so it is
  // here too. A reply-count link reads replies without opening that draft.
  // A return finds the box where it was left.
  untrack(() => { if ((focusReply || (!focusReplies && hasDraft(chain.id, id))) && !returning) replying.open(chain.id, id) })

  let repliesOpen = $state(saved.repliesOpen)
  let ancestors = $state<MessageRecord[]>(saved.ancestors)
  let openAncestors = $state<Record<string, boolean>>(saved.openAncestors)
  let loadingAncestors = $state<Record<string, boolean>>({})
  let readyAncestors = $state<Record<string, boolean>>({})
  const ancestorOpen = (post: MessageRecord) => openAncestors[String(post.id)] === true && !endingOf(gates.message(chain, post.id))
  const ancestorShown = (post: MessageRecord) => ancestorOpen(post) && readyAncestors[String(post.id)] === true
  function toggleAncestor(post: MessageRecord) {
    const key = String(post.id)
    openAncestors[key] = !ancestorOpen(post)
    delete readyAncestors[key]
  }
  let earlierTarget = $state<bigint | null>(null)
  let loadingEarlier = $state(false)
  let earlierError = $state<string | null>(null)
  let alive = true
  onDestroy(() => {
    alive = false
    saved.ancestors = $state.snapshot(ancestors)
    saved.repliesOpen = repliesOpen
    saved.openAncestors = $state.snapshot(openAncestors)
  })

  /** How many earlier posts one press adds: the parent, revealed, then up to three more above it. */
  const EARLIER = 4
  let view = $state<HTMLElement | null>(null)
  /** The immediate parent is already read for moderation; show it until an expanded walk takes its place. */
  function contextFor(page: Page): MessageRecord[] {
    return ancestors.length > 0 ? ancestors : page.parent ? [page.parent] : []
  }
  /**
   * Add earlier posts in place; modified clicks still open the parent's own
   * thread. One ancestor read adds records and reply counts to the thread's
   * session. The parent is revealed once, and the rest land above it
   * while the card being read stays where it is. What was read before a
   * failure stays.
   */
  async function earlier(event: MouseEvent, page: Page) {
    if (!plainClick(event)) return
    event.preventDefault()
    if (loadingEarlier) return
    loadingEarlier = true
    earlierError = null
    try {
      let n = 0
      const from = contextFor(page)[0] ?? page.root
      for (const parent of await readEarlier(chain, page.replies, from.parentId, EARLIER)) {
        if (!alive) return
        const hold = view ? holdInView(view, 'data-thread-card') : () => {}
        ancestors = [parent, ...contextFor(page)]
        if (n++ === 0) earlierTarget = parent.id
        await rendered()
        hold()
      }
    } catch (e) {
      if (alive) earlierError = explain(e)
    } finally {
      if (alive) loadingEarlier = false
    }
  }

  /** The reply just posted here, so the list's first page reaches it. */
  let revealed = $state<bigint | null>(null)
  /** After a reply lands the box closes; ?reply leaves the URL so a reload does not press it again. */
  function posted(replyId: bigint) {
    repliesOpen = true
    revealed = replyId
    localReloadRevision++
    if (focusReply) router.go(href.thread(chain.id, id, commit))
  }

  type Page = { root: RecordImage; parent: RecordImage | null; replies: ReplyPage; closed: boolean }

  async function load(id: bigint, revision: number): Promise<Page> {
    const { record: root, gate, parent, replies } = await readThread(saved.sessions, chain, id, commit, returning && revision === initialRevision)
    const ending = endingOf(gate)
    return { root, parent, replies, closed: ending !== null }
  }

  let page = $derived(load(id, reloadRevision))
  // Sample the new page only on an explicit refresh, not on local reloads or paging.
  let gateRefreshReady = $derived.by(() => {
    void refreshRevision
    return untrack(() => page)
  })

  /** The parents whose replies are on screen: the root and every open branch, kept by the reply lists themselves. */
  const shown = new Set<bigint>()
  // The quiet poll, for a thread: the rows a refresh would add beneath what
  // is on screen (shared/refresh-cue.svelte.ts). Nothing moves until it is pressed.
  $effect(() => {
    const c = chain
    const p = page
    // Its answers also carry the reader's new replies, mentions and quotes to the notifications dot.
    const listener = wallet.account ? notificationDot.listen(c, wallet.account) : undefined
    return refreshCue.poll(async () => {
      const loaded = await p.catch(() => null)
      return loaded ? peekReplies(c, loaded.replies, shown, listener) : null
    })
  })
</script>

<div class="thread-view" bind:this={view} use:rememberPage={'data-thread-card'}>
<Retained request={page} identity={`${chain.id}/${chain.contract}/${id}/${commit ?? ''}`} loading={`loading #${id}…`} onretry={() => localReloadRevision++}>
  {#snippet children(t)}
  {@const ended = endingOf(gates.message(chain, id))}
  {@const count = t.replies.counts.get(id) ?? 0}
  {@const context = contextFor(t)}
  {@const before = (context[0] ?? t.root).parentId}
  {#if before !== 0n}
    <a class="more small dim" href={href.thread(chain.id, before)} aria-disabled={loadingEarlier} onclick={(e) => earlier(e, t)}>
      {loadingEarlier ? 'reading earlier…' : `↑ earlier in this thread · #${before}`}
    </a>
  {/if}
  {#if earlierError}<p class="err small">{earlierError}</p>{/if}
  {#each context as a, i (a.id)}
    {@const child = context[i + 1] ?? t.root}
    {@const drawn = endingOf(gates.message(chain, child.id)) ? 0 : 1}
    {@const expanded = ancestorOpen(a)}
    {@const separated = i > 0 && ancestorShown(context[i - 1])}
    <div data-thread-card={a.id} tabindex="-1" use:revealWhen={{ key: earlierTarget === a.id ? a.id : null }}>
      <MessageCard separator={i === 0 || separated || box.visible(chain, context[i - 1].id)} {gateRefreshReady} reloadKey={t.replies} {chain} msg={a}
        replyCount={Math.max(0, (t.replies.counts.get(a.id) ?? 0) - drawn)} moreReplies {expanded}
        repliesLoading={loadingAncestors[String(a.id)] === true} onexpand={() => toggleAncestor(a)}
        connector={true} continuesAbove={separated || (i === 0 && before !== 0n)} onchanged={() => localReloadRevision++} />
    </div>
    <!-- A reply to an earlier post is a sibling of what this page shows, so its own thread shows it, with the post above. -->
    <InlineReply {chain} id={a.id} />
    {#if expanded}
      <Replies {chain} parentId={a.id} data={t.replies} omit={child.id} depth={1}
        separator={box.visible(chain, a.id)} {gateRefreshReady} {shown} views={saved.branches}
        onloading={loading => loadingAncestors[String(a.id)] = loading}
        onready={() => readyAncestors[String(a.id)] = true} onchanged={() => localReloadRevision++} />
    {/if}
  {/each}
  <div data-thread-card={id} tabindex="-1" use:revealWhen={{ key: !returning && !focusReply && !focusReplies ? id : null, anchor: 'above' }}>
  <MessageCard {gateRefreshReady} reloadKey={t.replies}
    {chain}
    msg={t.root}
    separator={context.length === 0 || ancestorShown(context[context.length - 1]) || box.visible(chain, context[context.length - 1].id)}
    linkToThread={false}
    replyCount={count}
    {repliesLoading}
    expanded={repliesOpen && count > 0}
    onexpand={() => { repliesOpen = !repliesOpen; revealed = null }}
    connector={repliesOpen && count > 0}
    continuesAbove={context.length === 0 ? t.root.parentId !== 0n : ancestorShown(context[context.length - 1])}
    onchanged={() => localReloadRevision++}
  />
  </div>
  {#if !ended && (!t.closed || hasResponseRight(t.root, wallet.account))}
    <InlineReply {chain} id={id} onposted={posted} />
  {/if}
  {#if ended && count > 0}
    <div class="expander small"><ReplyCount count={count} expanded={repliesOpen} onclick={() => { repliesOpen = !repliesOpen; revealed = null }} /></div>
  {/if}
  {#if repliesOpen}
  <div tabindex="-1" use:revealWhen={{ key: !returning && focusReplies ? id : null }}>
  <Replies separator={count === 0 || box.visible(chain, id)} onloading={loading => repliesLoading = loading} {gateRefreshReady} {chain} parentId={id} data={t.replies} reveal={revealed ?? undefined} {shown} views={saved.branches} onchanged={() => localReloadRevision++} />
  </div>
  {/if}
  {/snippet}
</Retained>
</div>

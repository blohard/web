<script lang="ts">
  // Prepared conversation cards and context links (features/streams/conversation.ts).
  // Every count opens direct replies in place. Keep existing preview cards
  // until their own parent's opened list is ready to take them over.
  import { untrack } from 'svelte'
  import Name from '../../components/Name.svelte'
  import { host } from '../../lib/host.svelte'
  import { replying } from '../publishing/replying.svelte'
  import { firstDisplay, firstScreenRow } from '../../shared/first-screen.svelte'
  import { ENDING_LABEL, endingOf } from '../../lib/board'
  import { getMessage } from '../../lib/messages'
  import { gates as ledger } from '../../lib/gates.svelte'
  import { branchOrder, conversationCards, type ConversationRowData } from './conversation'
  import { layoutPreview, replyControls, type PreviewLayout, type PreviewState } from './conversation-layout'
  import type { Page } from './feed'
  import { Resource } from '../../shared/resource.svelte'
  import { href, plainClick, router } from '../navigation/router.svelte'
  import { threadView } from './thread-view'
  import type { ChainInfo, Posted, MessageRecord } from '../../lib/types'
  import type { RowExpansion } from './stream-expansion'
  import InlineReply from '../publishing/InlineReply.svelte'
  import Loading from '../../shared/Loading.svelte'
  import MessageCard from '../messages/MessageCard.svelte'
  import StreamBranch from './StreamBranch.svelte'

  let {
    chain,
    page,
    reloadKey,
    resume = false,
    gateRefreshReady,
    row,
    collapseMuted = true,
    rowx,
    onchanged,
  }: {
    chain: ChainInfo
    /** Indexed counts, including asynchronously fetched missing context. */
    page: Page
    /** The stream's load, which a refresh, a new post or a local change replaces. Showing older posts extends the page without replacing it, so nothing on screen reloads. */
    reloadKey: unknown
    resume?: boolean
    gateRefreshReady?: Promise<unknown> | null
    row: ConversationRowData
    collapseMuted?: boolean
    /** Expansion choices shared by preview cards and cards in loaded reply lists. */
    rowx: RowExpansion
    onchanged?: () => void
  } = $props()
  const initialRow = firstScreenRow()
  const box = untrack(() => replying.box())
  /** The opened list takes over direct preview replies once it is ready. */
  let repliesLoading = $state(false)
  let previewLoading = $state<Record<string, boolean>>({})
  let branchReady = $state(false)
  // Preserve an existing preview during expansion, but never resurrect one
  // the reader hid or flash it while restoring an already-open branch.
  let keepPreview = $state(untrack(() => !rowx.isHidden(row.root.id) && !rowx.isOpen(row.root.id)))
  let expanded = $derived(!endingOf(ledger.message(chain, row.root.id)) && rowx.isOpen(row.root.id))
  let hidden = $derived(rowx.isHidden(row.root.id))

  let cards = $derived(row.cards)
  let rootId = $derived(row.root.id)
  let known = $derived(row.root.post)
  /** The read of a parent the page lacks, kept across refreshes like every other view; no card is rendered under an await (README, "Runes"). */
  const fetched = new Resource<MessageRecord>()
  let missing = $derived.by(() => {
    void reloadKey // A reload retries failed context reads; successful records are cached.
    return known || row.root.omitted ? null : getMessage(chain, rootId)
  })
  $effect(() => { if (missing) return fetched.watch(missing, rootId) })
  let parent = $derived(known ?? fetched.value(rootId))
  let failed = $derived(!known && fetched.failure(rootId) !== null)
  firstDisplay(() => !!row.root.omitted || !!parent || failed)
  /** Missing context counts can arrive after rows; until then show a pending mark. */
  const count = (id: bigint) => page.counts.get(id) ?? null
  // The parent card and an omitted parent's link use the same reply controls.
  let rootPreviewJoins = $derived(rowx.preview(cards.map(card => card.post))[0]?.parentId === rootId)
  let rootControls = $derived(replyControls(count(rootId), rootPreviewJoins ? row.root.drawn : 0, expanded, hidden))
  let hidePreview = $derived(!expanded && !hidden && rootPreviewJoins ? () => {
    keepPreview = false
    rowx.hide(rootId, true)
  } : null)
  const toggleRoot = () => {
    keepPreview = !hidden && !expanded
    rowx.press(rootId, true)
  }
  function togglePreview(id: bigint, posts: Posted[]) {
    if (!rowx.isOpen(id)) rowx.retain(posts)
    rowx.press(id)
  }
  let rootConnector = $derived(!hidden && (expanded ? (count(rootId) ?? 0) > 0 : rootPreviewJoins))
  let replySeparator = $derived(!row.root.omitted && (!rootConnector || box.visible(chain, rootId)))

  function displayPreview(items: ConversationRowData['cards'], missingParent = false, context = rootId, connected = false): PreviewLayout {
    const states = new Map<bigint, PreviewState>(items.map(({ post }) => [post.id, {
      totalReplies: count(post.id),
      open: rowx.isOpen(post.id),
      hidden: rowx.isHidden(post.id),
      ended: !!endingOf(ledger.message(chain, post.id)),
      editorOpen: box.visible(chain, post.id),
    }]))
    return layoutPreview(items, rowx.preview(items.map(card => card.post)), states, {
      id: context,
      separator: connected ? false : replySeparator,
      loading: !parent && !row.root.omitted && !failed,
      missing: missingParent,
    })
  }

  function remainingPosts(): Posted[] {
    const live = rowx.remaining().filter(p => !endingOf(ledger.message(chain, p.id)))
    return row.depthFirst ? branchOrder(live) : live
  }

  function openContext(event: MouseEvent, id: bigint) {
    if (!plainClick(event) || router.embed) return
    event.preventDefault()
    const preview = [
      ...(parent && !row.root.omitted ? [parent] : []),
      ...(keepPreview && !hidden && !branchReady ? displayPreview(cards).posts : []),
      ...(expanded && branchReady ? rowx.preview(remainingPosts()) : []),
    ].filter(post => !endingOf(ledger.message(chain, post.id)))
    const branches = rowx.inherit(id, preview)
    router.go(href.thread(chain.id, id))
    threadView(chain, id, branches)
  }

  function remainingPreview(posts: Posted[], context = rootId, connected = false): PreviewLayout {
    return displayPreview(conversationCards(context, posts), !connected, context, connected)
  }
</script>

{#snippet answers(id: bigint, author: string | undefined, separator = true)}
  {@const ending = endingOf(ledger.message(chain, id))}
  <a class="conversation-context" class:no-separator={!separator} href={href.thread(chain.id, id)} onclick={event => openContext(event, id)}>in reply to {#if author && !host.blocked(author)}<Name address={author} />{' '}{/if}#{id}{#if ending} · {ENDING_LABEL[ending]}{/if}</a>
{/snippet}

{#snippet preview(display: PreviewLayout)}
  {#each display.cards as card (card.post.id)}
    {@const r = card.post}
    {#if card.context}{@render answers(card.context.id, r.parentAuthor, card.context.separator)}{/if}
    <MessageCard separator={card.separator} {gateRefreshReady} {reloadKey}
      {chain}
      msg={r}
      replyCount={card.replyCount}
      moreReplies={card.moreReplies}
      expanded={card.expanded}
      repliesLoading={previewLoading[r.id.toString()] === true}
      onexpand={() => togglePreview(r.id, display.posts)}
      onhide={card.moreReplies ? () => { rowx.retain(display.posts); rowx.hide(r.id) } : null}
      {collapseMuted}
      {onchanged}
      continuesAbove={true}
      connector={card.connector}
    />
    <InlineReply {chain} id={r.id} onposted={(id) => { rowx.retain(display.posts); rowx.landed(r.id, id); onchanged?.() }} />
    {#if card.expanded}
      <StreamBranch {rowx} separator={card.branchSeparator} {resume} {gateRefreshReady} {chain} id={r.id} {reloadKey}
        {onchanged}
        onloading={loading => { if (loading) previewLoading[r.id.toString()] = true; else delete previewLoading[r.id.toString()] }} />
    {/if}
  {/each}
{/snippet}

{#snippet pair(p: Posted)}
  <!-- A muted parent collapses to one line, as any muted post does; the reply beneath it is the reader's own or a followed author's, and stays. -->
  {#if p.parentId !== 0n}{@render answers(p.parentId, p.parentAuthor)}{/if}
  <MessageCard {gateRefreshReady} {reloadKey} {chain} msg={p}
    separator={p.parentId === 0n}
    connector={rootConnector}
    continuesAbove={p.parentId !== 0n}
    replyCount={rootControls.replyCount}
    moreReplies={rootControls.moreReplies}
    {expanded} {repliesLoading}
    onexpand={toggleRoot}
    onhide={hidePreview}
    {collapseMuted} {onchanged} />
  <InlineReply {chain} id={p.id} onposted={(replyId) => { rowx.landed(p.id, replyId); onchanged?.() }} />
{/snippet}

{#snippet remaining(posts: Posted[], context = rootId, connected = false)}
  {@render preview(remainingPreview(posts, context, connected))}
{/snippet}

{#snippet replies()}
  {#if keepPreview && !hidden && !branchReady}
    {@render preview(displayPreview(cards))}
  {/if}
  {#if expanded}
    <StreamBranch kept={remainingPosts()} {rowx} separator={replySeparator} onready={ready => branchReady = ready} onloading={loading => repliesLoading = loading} {resume} {gateRefreshReady} {chain} id={rootId} {reloadKey} preview={keepPreview ? cards.map(card => card.post) : []} {remaining} {onchanged} />
  {/if}
{/snippet}

<div class="pair" use:initialRow>
  {#if row.root.omitted}
    <!-- A grouping ancestor needs a header only for its direct preview or an explicit expansion choice. -->
    {#if rootPreviewJoins || expanded || hidden}
      {@render answers(rootId, parent?.author ?? cards.find(card => card.post.parentId === rootId)?.post.parentAuthor)}
    {/if}
    {@render replies()}
  {:else if parent}
    {@render pair(parent)}
    {@render replies()}
  {:else}
    <!-- Keep the preview visible while its parent loads or if that read fails. -->
    {#if !failed}<div class="row-placeholder"><Loading label={`loading #${rootId}…`} inline /></div>{/if}
    {#if keepPreview && !hidden}{@render preview(displayPreview(cards, failed))}{/if}
  {/if}
</div>

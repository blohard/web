<script lang="ts">
  import ReplyCount from '../streams/ReplyCount.svelte'
  import CardActions from './CardActions.svelte'
  import { messageSelection } from './message-selection.svelte'
  import { firstDisplay } from '../../shared/first-screen.svelte'
  import { isClosedReplyRule } from '../publishing/reply-rules'
  // One post as a timeline row: avatar, author, time, body, actions. The
  // whole row opens the thread, as a timeline reader expects; the focused
  // post of a thread is shown on a tinted background with its full timestamp.
  import { untrack, type Snippet } from 'svelte'
  import { zeroAddress, type Hex } from 'viem'
  import { host } from '../../lib/host.svelte'
  import { wallet } from '../../lib/wallet.svelte'
  import { ENDING_LABEL, hasResponseRight, endingOf, isDeactivated } from '../../lib/board'
  import { explain } from '../../lib/errors'
  import { getMessage } from '../../lib/messages'
  import type { Body } from '../../lib/body'
  import { loadBody } from '../../lib/content'
  import { gates as ledger } from '../../lib/gates.svelte'
  import { fullTime, shortHex, timeAgo } from '../../lib/format'
  import { replyFold } from './reply-fold.svelte'
  import { cardBody } from './card-body.svelte'
  import { muted } from '../../lib/muted.svelte'
  import { people } from '../../lib/people'
  import { href, plainClick, router } from '../navigation/router.svelte'
  import { threadOpener } from '../streams/thread-view'
  import type { ChainInfo, Posted } from '../../lib/types'
  import Loading from '../../shared/Loading.svelte'
  import Avatar from '../../components/Avatar.svelte'
  import MessageEmbed from './MessageEmbed.svelte'
  import Name from '../../components/Name.svelte'
  import BotMark from '../../components/BotMark.svelte'
  import StreamKeyBadge from '../keys/StreamKeyBadge.svelte'
  import MessageBody from './MessageBody.svelte'
  import ParentContext from './ParentContext.svelte'
  import QuoteCard from './QuoteCard.svelte'

  let {
    chain,
    msg,
    reloadKey,
    gateRefreshReady,
    linkToThread = true,
    withParent = false,
    replyCount = 0,
    moreReplies = false,
    separator = true,
    connector = false,
    continuesAbove = false,
    collapseMuted = true,
    expanded = false,
    repliesLoading = false,
    onexpand = null,
    onhide = null,
    onchanged,
    after,
  }: {
    chain: ChainInfo
    msg: Posted
    /** Identifies the load that retries missing content. Streams and reply lists keep it unchanged while paging; the ledger follows known gates. */
    reloadKey?: unknown
    /** Only explicit refreshes change this promise; checks wait for the refreshed ledger. */
    gateRefreshReady?: Promise<unknown> | null
    /** A timeline row (true) or the focused post of a thread (false). */
    linkToThread?: boolean
    /** Show what this message replies to, above it. */
    withParent?: boolean
    /** Direct replies; null while the count is still being read, which draws a mark, not a zero. */
    replyCount?: number | null
    /** The count is of replies beyond those drawn beneath this card, worded "n more replies"; a pair's parent. */
    moreReplies?: boolean
    /** Draw a top border. The arranging view omits it after a connected card or a context label. Independent of the reply stub above the avatar. */
    separator?: boolean
    /** Draw the thread line from this row's avatar down to the next row. */
    connector?: boolean
    /** This row is itself a reply to something not shown: draw a stub of the thread line above its avatar. */
    continuesAbove?: boolean
    /** Collapse posts by muted authors (off on a profile the reader opened on purpose). */
    collapseMuted?: boolean
    /** This card's replies are open beneath it, in place; the count reads "hide replies". */
    expanded?: boolean
    repliesLoading?: boolean
    /** Given, the count opens or hides the replies in place instead of linking to the thread. */
    onexpand?: (() => void) | null
    /** Hide an automatic preview while its count can still open additional replies. */
    onhide?: (() => void) | null
    onchanged?: () => void
    /** An attached preview keeps its context link unless this card shows its full content. */
    after?: Snippet<[boolean]>
  } = $props()

  const selection = untrack(messageSelection)
  const openFromStream = untrack(threadOpener)

  type Details = { timestamp: number; body: Body }

  // Remember the author once for the mention picker, without making the
  // card's fetch depend on the collection it updates (README, "Runes").
  people.note(untrack(() => msg.author))

  /** The record is remembered for the tab and the body once it has arrived, so a refresh re-reads neither. */
  async function load(id: bigint, contentHash: Hex, _reloadKey: unknown, _attempt: number): Promise<Details> {
    const [record, body] = await Promise.all([getMessage(chain, id), loadBody(contentHash, { chainId: chain.id, messageId: id })])
    return { timestamp: record.timestamp, body }
  }

  let hostBlocked = $derived(host.blocked(msg.author))
  let thread = $derived(href.thread(chain.id, msg.id))
  /** A muted author's post collapses to one line until the reader asks to see it. */
  let revealed = $state(false)
  let collapsed = $derived(collapseMuted && muted.has(msg.author) && !revealed)
  let identity = $derived(`${chain.id}/${chain.contract}/${msg.id}/${msg.contentHash}`)
  const gateView = replyFold(
    () => ({ chain, msg, enabled: linkToThread && !hostBlocked }),
    () => gateRefreshReady,
  )
  let checkingGate = $derived(gateView.checking)
  let folded = $derived(!revealed && gateView.folded)
  // Hidden cards still avoid body reads. A reply's read starts while its gate
  // verdict is out and shows nothing until it lands (features/messages/card-body.svelte.ts).
  // A visible card keeps its body and hydrated images while updated gate
  // details are being read.
  const content = cardBody((attempt) => load(msg.id, msg.contentHash, reloadKey, attempt), () => ({ identity, hidden: hostBlocked || ended !== null || collapsed || folded, checking: checkingGate }), {
    retryable: (v) => v.body.kind === 'missing' || v.body.kind === 'error',
    reask: (v) => v.body.kind === 'missing',
  })
  let d = $derived(content.value)
  let detailError = $derived(content.failure)
  // The gates come from the ledger (lib/gates.svelte.ts): asked for once when
  // unknown, then followed through the host's change stream on refresh, so a
  // deletion, a removal or a deactivation shows without a read per card. The
  // message's own gate decides when set; otherwise its author's does.
  let own = $derived(ledger.message(chain, msg.id))
  let authors = $derived(own === zeroAddress ? ledger.author(chain, msg.author) : undefined)
  $effect(() => {
    void reloadKey // a reload retries unknown gates and failed reads; known gates are followed, never re-read
    if (own === undefined) void ledger.ensureMessage(chain, msg.id).catch(() => {})
    else if (own === zeroAddress && authors === undefined) void ledger.ensureAuthor(chain, msg.author).catch(() => {})
  })
  let ended = $derived(endingOf(own))
  let deactivated = $derived(isDeactivated(own, authors))
  let canRespond = $derived(hasResponseRight(msg, wallet.account))
  let closed = $derived(isClosedReplyRule(chain, own, authors))
  firstDisplay(() => hostBlocked || ended !== null || collapsed || folded || (!checkingGate && (d !== null || detailError !== null)))

  let showsContent = $derived(!hostBlocked && !ended && !collapsed && !folded && !checkingGate)
  let connects = $derived(connector && (expanded || !after || showsContent))

  function openLink(event: MouseEvent) {
    const link = (event.target as HTMLElement).closest('a')
    if (!openFromStream || !plainClick(event) || event.defaultPrevented || router.embed || link?.target || link?.hasAttribute('download')) return
    event.preventDefault()
    openFromStream(msg.id)
  }

  /** Clicks on the row itself open the thread; links, buttons and text selection keep their own meaning. */
  function open(e: MouseEvent) {
    if (!linkToThread) return
    const t = e.target as HTMLElement
    const link = t.closest('a')
    if (link) {
      if (link.getAttribute('href') === thread) openLink(e)
      return
    }
    if (t.closest('button, input, textarea, select, img, .post-reply-rule')) return
    if (window.getSelection()?.toString()) return
    if (openFromStream && !router.embed) openFromStream(msg.id)
    else router.go(thread)
  }

</script>

<!-- Terminal placeholders link to their own page but never expand beneath this card. -->
{#snippet replyControl()}
  {#if !ended}<ReplyCount count={replyCount} more={moreReplies} {expanded} loading={repliesLoading} onclick={onexpand} {onhide} href={linkToThread ? href.replies(chain.id, msg.id) : undefined} />{/if}
{/snippet}

<!-- Keep action status alive when folding temporarily hides the footer. -->
{#if hostBlocked}
  {#if !linkToThread}
    <p class="dim">post blocked by host</p>
    {#if wallet.is(msg.author)}
      <CardActions {chain} {msg} {reloadKey} gate={own} bodyReady={false} repliesClosed focused deleteOnly {replyControl} {onchanged}>
        {#snippet children(actions)}{@render actions()}{/snippet}
      </CardActions>
    {/if}
  {/if}
{:else}
<CardActions {chain} {msg} {reloadKey} gate={own} bodyReady={!ended && !collapsed && !folded && !checkingGate && d !== null} repliesClosed={deactivated || closed} focused={!linkToThread} {replyControl} {onchanged}>
{#snippet children(actions)}
{#if ended || collapsed || folded}
  {#if withParent && msg.parentId !== 0n}<ParentContext {chain} parentId={msg.parentId} {reloadKey} />{/if}
  <article class="msg collapsed small dim" class:no-separator={!separator} class:connector={connects}>
    <div class="grid">
      <div class="avatar-col">{#if continuesAbove}<div class="line up"></div>{/if}<span class="avatar-gap"></span>{#if connects}<div class="line"></div>{/if}</div>
      <div class="content">
        {#if ended}
          {ENDING_LABEL[ended]} · <a href={href.user(chain.id, msg.author)}><Name address={msg.author} /></a>
        {:else if collapsed}
          hidden because you muted <a href={href.user(chain.id, msg.author)}><Name address={msg.author} /></a>
        {:else}
          hidden because the author no longer accepts replies from <a href={href.user(chain.id, msg.author)}><Name address={msg.author} /></a>
        {/if}
        · <a class="dim" href={thread} aria-label={`open post #${msg.id}`} onclick={openLink}>#{msg.id}</a>
        {#if !ended}<button class="small" onclick={() => (revealed = true)}>show</button>{/if}
        {#if !ended && (replyCount === null || replyCount || expanded || onhide)}<div class="actions">{@render replyControl()}</div>{/if}
      </div>
    </div>
  </article>
{:else if !checkingGate}
<!-- The post-number link is the keyboard target; clicking empty card space is a pointer shortcut. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
  class="msg"
  class:no-separator={!separator}
  class:link={linkToThread}
  class:focus={!linkToThread}
  class:selected={selection.has(chain, msg.id)}
  class:connector={connects}
  onclick={open}
>
  {#if withParent && msg.parentId !== 0n}
    <ParentContext {chain} parentId={msg.parentId} {reloadKey} />
  {/if}
  <div class="grid">
    <div class="avatar-col">
      {#if continuesAbove}<div class="line up" title="a reply in this conversation"></div>{/if}
      <a href={href.user(chain.id, msg.author)} title={msg.author}><Avatar address={msg.author} size={linkToThread ? 36 : 40} /></a>
      {#if connects}<div class="line"></div>{/if}
    </div>
    <div class="content">
      <div class="meta">
        <span class="author-with-key">
          <a class="author" href={href.user(chain.id, msg.author)}><Name address={msg.author} /></a><BotMark address={msg.author} />
          <StreamKeyBadge {chain} address={msg.author} {reloadKey} />
        </span>
        {#if chain.curated && host.curated(msg.author)}<span class="badge" title="selected by this host">✓</span>{/if}
        <span class="dim">·</span>
        <a class="dim" href={thread} aria-label={`open post #${msg.id}`}>#{msg.id}</a>
        {#if linkToThread}
          {#if d}
            <span class="dim">·</span>
            <span class="dim" title={new Date(d.timestamp * 1000).toISOString()}>{timeAgo(d.timestamp)}</span>
          {/if}
        {/if}
      </div>
      <div class="body">
        {#if d}
          {#snippet embed()}
            {#if d.body.kind === 'text'}
              <MessageEmbed text={d.body.text} {chain} id={msg.id} author={msg.author} {reloadKey} />
            {/if}
          {/snippet}
          <MessageBody body={d.body} chainId={chain.id} id={msg.id} author={msg.author} detail={` (${shortHex(msg.contentHash)})`}
            previewHref={linkToThread ? thread : null} linkPreview={embed}>
            {#snippet quote(q)}
              <QuoteCard chainId={q.chainId} id={q.id} commit={q.commit} here={chain} {reloadKey} />
            {/snippet}
          </MessageBody>
          {#if closed && !canRespond}<div class="placeholder small">no new replies to this post</div>{/if}
          {#if deactivated && !canRespond}
            <div class="placeholder small">the author's account is deactivated, so replies are closed</div>
          {/if}
        {:else if !detailError}
          <Loading label="loading the post…" inline />
        {/if}
        {#if detailError}<span class="err">{explain(detailError.cause)}</span>{/if}
        {#if content.retryable}<button class="small" onclick={() => content.retry()}>try again</button>{/if}
      </div>
      {#if !linkToThread}
        {#if d}
          <div class="time-full" title={new Date(d.timestamp * 1000).toISOString()}>{fullTime(d.timestamp)}</div>
        {/if}
      {/if}
      {@render actions()}
    </div>
  </div>
</article>
{/if}
{/snippet}
</CardActions>
{/if}

{#if after}{@render after(showsContent)}{/if}

<style>
  .author-with-key { display: inline-flex; align-items: center; gap: 0.15rem; max-width: 100%; }
</style>

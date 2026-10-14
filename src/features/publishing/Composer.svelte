<script lang="ts">
  import { RelayDeclined } from './relay'

  import { onDestroy, untrack } from 'svelte'
  // The box, its buttons and its status line. Posting itself (transaction
  // first, then upload, CLIENT.md) lives in features/publishing/posting.ts; the text
  // grammar of attachments and mentions in features/publishing/attachments.ts and
  // lib/mentions.ts.
  import type { Hex } from 'viem'
  import { attachFiles, referencedRecords, withoutReference } from './attachments'
  import { draft, quoteLine } from './draft.svelte'
  import type { DraftBox } from './draft-box.svelte'
  import { linkify, present, type Mentions } from '../../lib/mentions'
  import { names } from '../../lib/names.svelte'
  import { fmtBytes, shortAddress, shortHex } from '../../lib/format'
  import { host } from '../../lib/host.svelte'
  import { sponsorship } from './sponsorship.svelte'
  import { newPendingPost, type PostRecord } from './pending'
  import { bodyBytes, bodyRecord } from './posting'
  import { publications, type Publication } from './publications.svelte'
  import { MAX_REFERENCES, textReferences } from '../../lib/reference-syntax'
  import { href } from '../navigation/router.svelte'
  import { revealWhen } from '../navigation/scroll'
  import { messageSelection } from '../messages/message-selection.svelte'
  import type { ChainInfo } from '../../lib/types'
  import { wallet } from '../../lib/wallet.svelte'
  import PostReplyRule from '../account/PostReplyRule.svelte'
  import ReplyAccess from './ReplyAccess.svelte'
  import { replyAccess, type ReplyAccess as ReplyRestriction } from './reply-access'
  import { Resource } from '../../shared/resource.svelte'
  import ComposeEditor from './ComposeEditor.svelte'
  import Name from '../../components/Name.svelte'
  import SponsorshipStatus from './SponsorshipStatus.svelte'
  import ComposerPreview from './ComposerPreview.svelte'

  let {
    chain,
    parentId = 0n,
    focusRequest = null,
    owner,
    onshown,
    onposted,
    feedStatus = null,
    oncancel = null,
    nearest = false,
  }: {
    chain: ChainInfo
    parentId?: bigint
    focusRequest?: unknown
    owner: DraftBox
    /** A reveal for `focusRequest` started. */
    onshown?: () => void
    /** Captured at submit; called when that draft lands while this mount still owns the box. */
    onposted?: (id: bigint) => void
    feedStatus?: 'updating' | 'failed' | null
    /** Given, a control closes this box; the words already typed go with it, and the label says so. */
    oncancel?: (() => void) | null
    /** Reveal by the smallest scroll that shows the box, none when it is already in view. */
    nearest?: boolean
  } = $props()

  // Keep this mount's owner even if navigation moves the reader elsewhere.
  const box = untrack(() => owner)
  const selection = untrack(messageSelection)
  let alive = true
  onDestroy(() => { alive = false })
  // Derive from the owner so a send completed by an earlier mount also clears
  // this mount. Input can override these values until its edit is reported.
  let text = $derived(box.draft.text)
  let attachments = $derived<PostRecord[]>([...box.draft.attachments])
  // The choice to pay is remembered for one chain and account, so switching
  // either returns to free posting without an effect writing state.
  let payFor = $state<string | null>(null)
  let payKey = $derived(`${chain.id}:${wallet.account ?? ''}`)
  let ruleContext = $derived(`${chain.id}:${chain.contract}:${wallet.account ?? ''}`.toLowerCase())
  let replyGate = $derived(box.replyGate(ruleContext))
  let payMyself = $derived(payFor === payKey)
  let hostBlocked = $derived(host.blocked(wallet.account))
  let dragging = $state(false)
  let preview = $state(false)
  let operation = $state.raw<Publication | undefined>(untrack(() => publications.forBox(box)))
  let busy = $derived(operation?.busy ?? false)
  let post = $derived(operation && (operation.busy || operation.needsUpload) ? operation.post : null)
  let outcome = $derived(operation?.outcome)
  // One result owns both the explanation and submission guard. Refresh retains
  // a known restriction until a successful check replaces it, including on failure.
  const replyRead = new Resource<ReplyRestriction>()
  let replyRetry = $state(0)
  const replyIdentity = $derived(`${chain.id}/${chain.contract}/${parentId}/${wallet.account}`)
  const replyRefresh = $derived(outcome?.kind === 'err' ? outcome : null)
  const replyQuery = $derived.by(() => {
    void replyIdentity; void replyRetry; void replyRefresh
    const indexed = host.keyring(chain.id)
    const account = wallet.account
    return parentId !== 0n && account && !hostBlocked ? untrack(() => replyAccess(chain, parentId, account, indexed)) : null
  })
  $effect(() => { if (replyQuery) return replyRead.watch(replyQuery, replyIdentity) })
  const replyRestriction = $derived(replyRead.value(replyIdentity))
  const checkingReply = $derived(parentId !== 0n && replyRead.pending && !replyRestriction && !replyRead.failure(replyIdentity))
  let confirmed = $derived(operation?.done && outcome?.kind === 'ok')
  let dismissed = $state<typeof outcome>()
  let showOutcome = $derived(!!outcome && dismissed !== outcome)
  $effect(() => {
    const current = outcome
    if (!current || !confirmed || feedStatus === 'updating') return
    const timer = setTimeout(() => { dismissed = current }, 4000)
    return () => clearTimeout(timer)
  })
  let warning = $derived(operation?.warning)
  /** Why the last file was not attached. */
  let attachError = $state<string | null>(null)
  let fileInput = $state<HTMLInputElement | null>(null)

  // ---- mentions: type @ to pick a person; the body carries account://<address> ----
  /** Labels inserted by the picker, and who they stand for. Only these become references. */
  let mentions = $derived<Mentions>({ ...box.draft.mentions })
  const report = () => box.edit({ text, mentions: { ...mentions }, attachments: [...attachments] })
  /** Picked people whose labels remain in the text. */
  let mentioned = $derived(present(text, mentions))

  /** Quotes are attachments by reference; the home composer takes them from the draft, a reply box has none. */
  let quotes = $derived(parentId === 0n ? draft.quotes : [])
  /** The body as it will be posted: the text with mentions as references, then one reference line per quote. */
  let composed = $derived.by(() => {
    const body = linkify(text, mentions)
    // Quotes go on lines of their own after the text. A card is a block with its
    // own spacing, so no blank line is written before it, and none when there is no text.
    const words = body.trimEnd()
    return quotes.length ? `${words ? `${words}\n` : ''}${quotes.map(quoteLine).join('\n')}\n` : body
  })
  let bytes = $derived(bodyBytes(composed))
  let overReferences = $derived(textReferences(composed, MAX_REFERENCES + 1).length > MAX_REFERENCES)
  let empty = $derived(text.trim().length === 0 && quotes.length === 0)
  /** Nothing is clickable while this box, or the wallet on anyone's behalf, is mid-request. */
  let submitting = $derived(busy || box.sending)
  let locked = $derived(submitting || wallet.busy || hostBlocked)
  /** Nothing in the draft changes while a request is running or a sent post still needs its upload. */
  let frozen = $derived(locked || post !== null)
  let label = $derived(parentId === 0n ? 'post' : 'reply')
  let policy = $derived(host.status?.store?.attachments ?? null)
  /** The host's body cap in bytes, header included; checked here, before any gas is spent. */
  let bodyCap = $derived(host.status?.store?.max_content_size ?? null)
  /** Bytes left under the cap. Shown as characters, which is what they are for most text; "about" covers the rest. */
  let bytesLeft = $derived(bodyCap === null ? null : bodyCap - bytes.length)
  /** A gateway-only host has nowhere to put the words; the post would be unreadable. */
  let noStore = $derived(host.status !== null && host.status.store === null)
  let overCap = $derived(bodyCap !== null && bytes.length > bodyCap)
  /** Attachments of both kinds: record references in the text plus quotes. */
  let referenced = $derived(referencedRecords(text) + quotes.length)
  let overRefs = $derived(policy !== null && referenced > policy.max_per_message)
  /** No room for another attachment of either kind. */
  let full = $derived(policy !== null && attachments.length + quotes.length >= policy.max_per_message)
  /** Eligibility and current service availability are distinct from the payment choice. */
  let sponsor = $derived(sponsorship.policy(chain))
  let eligibility = $derived(wallet.account ? sponsorship.lookup(chain, wallet.account) : undefined)
  $effect(() => {
    const account = wallet.account, c = chain
    if (!account || !sponsor || hostBlocked) return
    return untrack(() => sponsorship.watch(c, account))
  })
  function refreshSponsorship() {
    if (wallet.account) sponsorship.forget(chain, wallet.account)
  }
  let eligible = $derived(eligibility?.eligible === true)
  let namesEnabled = $derived(sponsor?.name_sponsorship?.ens || sponsor?.name_sponsorship?.basenames)
  let sponsored = $derived(eligible && eligibility?.posting_available !== false && !payMyself)
  /** Free posting is offered but cannot be used yet, and the author has not chosen to pay: eligibility is unknown, or posting is paused for an eligible author. */
  let sponsorBlocks = $derived(!!sponsor && !payMyself && (eligibility?.eligible == null || (eligible && eligibility?.posting_available === false)))
  /** The one rule for the post button and the keyboard shortcut. */
  let canSubmit = $derived(!!wallet.account && !frozen && !empty && !overCap && !overReferences && !noStore && !replyRestriction?.kind && !sponsorBlocks)

  async function addFiles(files: FileList | null) {
    if (!files || frozen) return
    if (!policy) {
      attachError = 'this host stores no attachments'
      return
    }
    attachError = null
    const error = await attachFiles(box, Array.from(files), policy,
      () => alive && !frozen, () => quotes.length)
    if (!alive) return
    attachError = error
    if (fileInput) fileInput.value = ''
  }

  function removeAttachment(hash: Hex) {
    attachments = attachments.filter((a) => a.hash !== hash)
    text = withoutReference(text, hash)
    report()
  }

  async function retry() {
    const c = operation && host.chain(operation.post.chainId)
    if (!operation || !c) return
    try { await operation.retry(c) } catch { /* The operation retains its error and recovery material. */ }
  }

  async function submit() {
    if (!canSubmit || !wallet.account) return
    attachError = null
    // Report the pruned list like any edit: the box's draft is what a failed send returns to.
    attachments = attachments.filter((a) => text.includes(`record:${a.hash}`))
    report()
    const c = chain, target = parentId, account = wallet.account, notify = onposted
    const op = publications.get(newPendingPost(c.id, wallet.account, [bodyRecord(composed), ...attachments]))
    operation = op
    try {
      await op.publish({ chain: c, wallet, parentId: target, replyGate, sponsored }, box, (id) => {
        if (alive && chain === c && parentId === target) {
          selection.select(c, id)
          notify?.(id)
        }
      })
    } catch (e) {
      // The operation owns the outcome and draft; this control owns the payment choice.
      // A busy relayer is RelayBusy, which offers no switch to paying (features/publishing/relay.ts).
      if (e instanceof RelayDeclined && alive && operation === op) payFor = `${c.id}:${account}`
    } finally {
      sponsorship.forget(c, account)
    }
  }
</script>

<svelte:document onvisibilitychange={() => {
  if (document.visibilityState === 'visible' && parentId !== 0n && wallet.account
    && (replyRestriction || replyRead.failure(replyIdentity))) replyRetry++
}} />

{#if hostBlocked}
  <p class="dim" role="status">posting blocked by host</p>
{:else}
<div class="composer" class:reply={parentId !== 0n} class:dragging use:revealWhen={{ key: focusRequest, focus: 'textarea', anchor: parentId !== 0n ? 'above' : undefined, nearest, onshown }}>
  <ComposeEditor owner={box} disabled={frozen} bind:dragging
    rows={parentId === 0n ? 2 : 1}
    placeholder={parentId === 0n ? 'type a message, drop or paste an image' : 'write a reply…'}
    onfiles={addFiles} onsubmit={submit}
  />
  {#if parentId !== 0n && wallet.account}
    <ReplyAccess {chain} access={replyRestriction} pending={replyRead.pending} failed={replyRead.failure(replyIdentity) !== null} onretry={() => replyRetry++} />
  {/if}
  {#if attachments.length || quotes.length || mentioned.length}
    <ul class="attachments small">
      {#each mentioned as [label, address] (label)}
        <li>
          <span>
            mentioning <Name {address} />
            {#if names.lookup(address)?.name}<span class="dim">{shortAddress(address)}</span>{/if}
          </span>
          {#if !frozen}
            <button class="small" onclick={() => { const m = { ...mentions }; delete m[label]; mentions = m; report() }} title="keep the text, drop the reference">remove</button>
          {/if}
        </li>
      {/each}
      {#each quotes as q (`${q.chainId}/${q.id}`)}
        <li>
          <span>
            quoting <a href={href.thread(q.chainId, q.id, q.commit)}>#{q.id}</a>
            {#if q.chainId !== chain.id}<span class="dim">on {host.label(q.chainId)}</span>{/if}
          </span>
          {#if !frozen}
            <button class="small" onclick={() => draft.remove(q)}>remove</button>
          {/if}
        </li>
      {/each}
      <!-- The draft's own copies: upload progress belongs to the publication's (features/publishing/pending.ts). -->
      {#each attachments as a (a.hash)}
        <li>
          <span>{a.name} <span class="dim">({a.mediaType}, {fmtBytes(a.bytes.length)})</span></span>
          {#if !frozen}
            <button class="small" onclick={() => removeAttachment(a.hash)}>remove</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  <div class="row small compose-actions" class:with-cancel={!!oncancel && post === null}>
    <span class="grow action-count" class:err={overCap} class:dim={!overCap}>
      {#if overCap && bytesLeft !== null}about {(-bytesLeft).toLocaleString()} characters over this host's limit of about {bodyCap?.toLocaleString()}
      {:else if bytesLeft !== null && text.length > 0}about {bytesLeft.toLocaleString()} characters left{/if}
    </span>
    {#if oncancel && post === null}
      <button class="small" onclick={oncancel} disabled={locked}>{empty && attachments.length === 0 ? 'cancel' : 'discard reply'}</button>
    {/if}
    <div class="post-controls">
      {#if wallet.account}
        <PostReplyRule isReply={parentId !== 0n} {chain} address={wallet.account} gate={replyGate} disabled={frozen}
          onsave={(gate) => box.setReplyGate(ruleContext, gate)} />
      {/if}
      <button class="icon preview-post" type="button" aria-label="preview" title="preview" onclick={() => { preview = true }} disabled={!wallet.account || frozen || empty}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg></button>
      {#if policy}
        <input bind:this={fileInput} type="file" accept="image/*" multiple hidden onchange={(e) => addFiles((e.currentTarget as HTMLInputElement).files)} />
        <button class="icon attach-image"
          aria-label="attach images"
          onclick={() => fileInput?.click()}
          disabled={frozen || full}
          title="attach images · up to {policy.max_per_message} attachments (images and quotes), images {fmtBytes(policy.max_bytes)} each"
        ><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7l-10 10a2 2 0 0 1-2.8-2.8l9.2-9.2" />
        </svg></button>
      {/if}
      {#if post !== null && post.messageId !== null && !submitting}
        <button onclick={retry} disabled={busy || wallet.busy}>retry upload</button>
      {:else}
        <button class="post-action" onclick={submit} disabled={!canSubmit} aria-busy={submitting}>
          <span class="post-label">
            <span class:inactive={submitting} aria-hidden={submitting}>{label}</span>
            <span class:inactive={!submitting} aria-hidden={!submitting}>{parentId === 0n ? 'posting…' : 'replying…'}</span>
          </span>
        </button>
      {/if}
    </div>
  </div>
  {#if wallet.account || showOutcome || box.sending}
    <!-- Payment options and progress share a reserved slot; hidden options still reserve their space. -->
    <div class="compose-status">
      <div class:concealed={checkingReply || showOutcome || box.sending}
        inert={checkingReply || showOutcome || box.sending} aria-hidden={checkingReply || showOutcome || box.sending}>
        {#if wallet.account}
          <SponsorshipStatus entry={eligibility} offered={!!sponsor} {payMyself} {namesEnabled} disabled={locked}
            onToggle={() => { payFor = payMyself ? null : payKey }} onRefresh={refreshSponsorship} />
        {/if}
      </div>
      <div class="status transaction-status" class:working={submitting && !confirmed && showOutcome} role="status"
        class:err={showOutcome && !confirmed && outcome?.kind === 'err'} class:ok={showOutcome && (confirmed || outcome?.kind === 'ok')}>
        {#if showOutcome && outcome}
          {#if confirmed}
            {parentId === 0n ? 'posted' : 'reply posted'}{feedStatus === 'updating' ? ' · updating feed…' : feedStatus === 'failed' ? ' · reload the page to see it' : ''}
          {:else}
            {outcome.note}
            {#if outcome.id !== null && outcome.kind !== 'progress'}
              · <a href={href.thread(operation!.post.chainId, outcome.id)}>open #{outcome.id}</a>
            {/if}
            {#if outcome.txHash && outcome.kind !== 'progress'}
              <span class="dim">· tx {shortHex(outcome.txHash)}</span>
            {/if}
            {#if outcome.kind === 'err' && !submitting}
              <button onclick={() => { dismissed = outcome }}>dismiss</button>
            {/if}
          {/if}
        {:else if box.sending}
          <span class="dim">sending your {label}…</span>
        {:else if checkingReply}
          <span class="dim">checking reply access…</span>
        {/if}
      </div>
    </div>
  {/if}
  {#if noStore}
    <div class="status err">this host stores no content. a post made here would go on-chain, but its text would live nowhere.</div>
  {/if}
  {#if overRefs && policy}
    <div class="status dim">
      this text references {referenced} records, and this host stores only the first {policy.max_per_message} of them, in order of appearance
    </div>
  {/if}
  {#if overReferences}
    <div class="status err">at most {MAX_REFERENCES} mentions and post references per post, combined. remove a reference to continue</div>
  {/if}
  {#if attachError}
    <div class="status err">{attachError}</div>
  {/if}
  {#if warning}
    <div class="status err">{warning}</div>
  {/if}
</div>

{#if preview && wallet.account}
  <ComposerPreview {chain} author={wallet.account} text={composed} records={attachments} {parentId} onclose={() => { preview = false }} />
{/if}

{/if}

<style>
  /* Align with the editor after its 36px avatar and .75rem gap. */
  .compose-status { display: grid; margin-inline-start: calc(36px + .75rem); font-size: .86em; }
  .compose-status > div { grid-area: 1 / 1; min-width: 0; }
  .compose-status > .concealed { visibility: hidden; }
  .compose-status > .transaction-status { min-height: 1lh; }
  /* Keep the live region mounted without covering the payment controls beneath it. */
  .compose-status > .transaction-status:empty { pointer-events: none; }
  /* The reply rule takes the width its label needs, the count the rest, down to its longest word. Only when both are long is the label cut short. */
  .compose-actions { display: grid; grid-template-columns: minmax(min-content, 1fr) minmax(0, max-content) auto auto auto; align-items: center; column-gap: .5rem; }
  .compose-actions.with-cancel { grid-template-columns: minmax(min-content, 1fr) auto minmax(0, max-content) auto auto auto; }
  .action-count { grid-column: 1; grid-row: 1; min-width: 0; }
  .compose-actions > button { grid-column: 2; grid-row: 1; justify-self: end; }
  .post-controls { display: contents; }
  .post-controls :global(.post-reply-rule > button) { grid-column: -5; grid-row: 1; min-width: 0; min-height: 44px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .post-controls :global(.rule-panel) { grid-column: 1 / -1; grid-row: 2; }
  .post-controls > button { grid-column: -2; grid-row: 1; }
  .post-controls > .preview-post { grid-column: -4; }
  .post-controls > .attach-image { grid-column: -3; }
  .post-action { display: inline-flex; align-items: center; justify-content: center; gap: .25em; min-height: 44px; padding: 0 .8rem; border: 1px solid var(--accent); border-radius: 0; background: var(--accent); color: var(--bg); font-weight: 600; white-space: nowrap; }
  .post-label { display: grid; }
  .post-label > span { grid-area: 1 / 1; }
  .post-label > .inactive { visibility: hidden; }
  .post-action::before, .post-action::after { color: inherit; opacity: .75; }
  .post-action:hover:not(:disabled) { color: var(--bg); filter: brightness(1.1); }
  .post-action:disabled { color: var(--dim); background: var(--tint); border-color: var(--border); }
  @media (max-width: 480px) {
    .compose-actions, .compose-actions.with-cancel { grid-template-columns: minmax(0, 1fr) auto auto auto; }
    .action-count { grid-column: 1 / -1; }
    /* Phone posts rarely approach the limit: show the count only once over it, as it explains the disabled button. */
    .action-count:not(.err) { display: none; }
    .compose-actions > button { grid-column: 2 / -1; grid-row: 1; }
    .compose-actions.with-cancel .action-count { grid-column: 1; }
    .post-controls :global(.post-reply-rule > button) { grid-column: 1; grid-row: 2; }
    .post-controls > button { grid-column: 4; grid-row: 2; }
    .post-controls > .preview-post { grid-column: 2; }
    /* A rule would be cut off at this width: the button says only "reply rule", in the accent colour when this post has a rule of its own. */
    .post-controls :global(.post-reply-rule .rule-detail) { display: none; }
    .post-controls :global(.post-reply-rule > button.own-rule) { color: var(--accent); }
    .post-controls > .attach-image { grid-column: 3; }
    .post-controls :global(.rule-panel) { grid-row: 3; }
  }
  /* The eye and the paperclip: square tap targets without the brackets. */
  .icon { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; align-self: center; padding: 0; }
  .icon::before, .icon::after { content: none; }
  .icon svg { display: block; }
</style>

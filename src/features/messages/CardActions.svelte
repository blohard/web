<script lang="ts">
  // Card controls and their transient status. Wallet writes and saved hashes
  // remain owned by the shared transaction modules.
  import type { Snippet } from 'svelte'
  import type { Address } from 'viem'
  import { Resource } from '../../shared/resource.svelte'
  import { getMessage } from '../../lib/messages'
  import { endingOf, hasResponseRight, REMOVED, TOMBSTONE } from '../../lib/board'
  import { explain } from '../../lib/errors'
  import { gates as ledger } from '../../lib/gates.svelte'
  import { messageActions } from './message-actions.svelte'
  import { moderate } from './moderation'
  import { savePostReplyGate } from '../account/post-reply-rule'
  import { quote as quotePost, quoteLater } from '../publishing/quoting'
  import { replying } from '../publishing/replying.svelte'
  import { href, router } from '../navigation/router.svelte'
  import type { ChainInfo, Posted, MessageRecord } from '../../lib/types'
  import { wallet } from '../../lib/wallet.svelte'
  import PostReplyRule from '../account/PostReplyRule.svelte'
  import UnsettledChange from '../../components/UnsettledChange.svelte'

  let { chain, msg, gate, reloadKey, bodyReady, repliesClosed, focused, replyControl, children, onchanged, deleteOnly = false }: {
    chain: ChainInfo
    msg: Posted
    gate: Address | undefined
    reloadKey?: unknown
    bodyReady: boolean
    /** A host-hidden post keeps only its author's deletion and recovery controls. */
    deleteOnly?: boolean
    repliesClosed: boolean
    focused: boolean
    /** Reply expansion belongs to the card, including when the card is folded. */
    replyControl: Snippet
    /** The card places the footer; this component stays mounted when it hides it. */
    children: Snippet<[Snippet]>
    onchanged?: () => void
  } = $props()

  let identity = $derived(`${chain.id}/${chain.contract}/${msg.id}/${msg.contentHash}`)
  let ended = $derived(endingOf(gate))
  let mine = $derived(wallet.is(msg.author))
  /** The record names the parent author even when its card is not drawn. */
  let parentMine = $derived(msg.parentId !== 0n && wallet.is(msg.parentAuthor))
  const parent = new Resource<MessageRecord>()
  let parentIdentity = $derived(`removal/${chain.id}/${chain.contract}/${msg.parentId}`)
  let parentRead = $derived.by(() => {
    void reloadKey
    return parentMine && !mine && !ended ? getMessage(chain, msg.parentId) : null
  })
  $effect(() => { if (parentRead) return parent.watch(parentRead, parentIdentity) })
  let removable = $derived(parent.value(parentIdentity) !== null && !hasResponseRight(parent.value(parentIdentity)!, msg.author))
  let canRespond = $derived(hasResponseRight(msg, wallet.account))
  /** A change this device sent to the post whose receipt never came: nothing else is sent until it settles. */
  let unsettled = $derived(messageActions.unsettled(chain, msg.id))
  let changing = $derived(messageActions.busy(chain, msg.id) || unsettled !== null)

  let actionError = $state<string | null>(null)
  let actionProgress = $state<{ identity: string; account: Address; text: string } | null>(null)

  let actionNote = $derived(actionProgress?.identity === identity && actionProgress.account === wallet.account ? actionProgress.text : null)

  /** Quote this post. Without a wallet the page finishes it once one connects (features/publishing/quoting.ts). */
  async function quote() {
    const shown = { ...msg }
    if (!wallet.account) return quoteLater(chain, shown)
    actionError = null
    try {
      await quotePost(chain, shown)
    } catch (e) {
      actionError = explain(e)
    }
  }

  /** What each ending asks before it is sent; both are permanent. */
  const questions = {
    delete: (id: bigint) => `delete post #${id}?\n\nthis is permanent. the post is marked retracted on-chain and can never be restored.`,
    remove: (id: bigint) => `remove reply #${id}?\n\nthis is permanent. the reply is marked removed on-chain, and its branch is hidden from its parent’s discussion. it can never be restored.`,
  }
  /** Delete your own post, or remove a reply under yours. */
  async function end(action: 'delete' | 'remove') {
    if (changing || !wallet.provider || !wallet.account) return
    const targetChain = chain, id = msg.id, submittedFor = identity, account = wallet.account
    const sentinel = action === 'delete' ? TOMBSTONE : REMOVED
    if (action === 'remove' && !removable) return
    if (!confirm(`${questions[action](id)}\n\nnew transactions use your wallet’s gas.`)) return
    actionError = null
    actionProgress = { identity: submittedFor, account, text: 'check your wallet…' }
    try {
      const landed = await moderate(wallet, targetChain, id, action, text => { actionProgress = { identity: submittedFor, account, text } })
      ledger.settleMessage(targetChain, id, sentinel, landed)
      onchanged?.()
    } catch (e) {
      actionError = explain(e)
    } finally {
      actionProgress = null
    }
  }

</script>

{#snippet actions()}
<div class="actions">
  {#if bodyReady || deleteOnly}
    {#if !deleteOnly}
      {#if !ended && (!repliesClosed || canRespond)}
        <!-- The box opens under this card, in place (InlineReply); the focused post of a thread has its own, and the embed sends the reader to the app. -->
        {#if router.embed}
          <a class="act" href={href.reply(chain.id, msg.id)}>↳ reply</a>
        {:else}
          <button class="act" onclick={() => replying.open(chain.id, msg.id)}>↳ reply</button>
        {/if}
      {/if}
      {#if !ended && !repliesClosed && !router.embed}
        <button class="act" onclick={quote} title="quote this post in a new post of yours">↱ quote</button>
      {/if}
      {@render replyControl()}
    {/if}
    {#if !router.embed}
      {#if mine && !ended}
        <button class="danger small" disabled={changing} onclick={() => end('delete')} title={actionNote ?? 'delete this post'} aria-busy={!!actionNote} class:working={!!actionNote}><span class="spinner" aria-hidden="true"></span>delete</button>
        <!-- A post's own reply rule is changed from its thread page, not from every stream it appears in. -->
        {#if !deleteOnly && focused && gate !== undefined}
          <PostReplyRule isReply={msg.parentId !== 0n} {chain} address={msg.author} {gate} postId={msg.id} disabled={wallet.busy || changing}
            onsave={(gate, onProgress) => savePostReplyGate(wallet, chain, msg, gate, onProgress)} />
        {/if}
      {:else if !deleteOnly && parentMine && !ended && removable}
        <button class="danger small" disabled={changing} onclick={() => end('remove')} title={actionNote ?? 'remove this reply from under your post, permanently'} aria-busy={!!actionNote} class:working={!!actionNote}><span class="spinner" aria-hidden="true"></span>remove</button>
      {/if}
    {/if}
  {/if}
  {#if actionError}<span class="err small">{actionError}</span>{/if}
  {#if !router.embed}
    <UnsettledChange what="this post" hash={unsettled} saved={messageActions.saved(chain, msg.id)} busy={messageActions.busy(chain, msg.id)}
      check={() => messageActions.check(chain, msg.id)} clear={() => messageActions.clear(chain, msg.id)} onlanded={() => onchanged?.()} />
  {/if}
</div>
{/snippet}

{@render children(actions)}

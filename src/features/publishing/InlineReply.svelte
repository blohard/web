<script lang="ts">
  // The reply box under the card whose reply was pressed. One per page, kept
  // with the page (features/publishing/replying.svelte.ts); its draft is the post's, shared
  // with any other page's box for it. It closes when the reply lands, and the
  // owner shows the reply or refreshes so it appears beneath its post.
  import { untrack } from 'svelte'
  import { quoteAgain } from './quoting'
  import { replying } from './replying.svelte'
  import { href, router } from '../navigation/router.svelte'
  import type { ChainInfo } from '../../lib/types'
  import { wallet } from '../../lib/wallet.svelte'
  import Composer from './Composer.svelte'
  import ConnectPrompt from '../../components/ConnectPrompt.svelte'

  // Unless the owner shows the reply itself (a thread's branch, a row's main
  // post), the reply opens its own thread: a stream's preview card, an earlier
  // post above a thread, or a notification has nowhere to show it, and its
  // feed need not list it.
  let { chain, id, onposted = (replyId) => router.go(href.thread(chain.id, replyId)) }: {
    chain: ChainInfo; id: bigint; onposted?: (replyId: bigint) => void
  } = $props()
  // This mount's box is its page's, taken once: a completion arriving after
  // the reader moved on still speaks to the box it was sent from, not to
  // whatever page is on screen then.
  const box = untrack(() => replying.box(router.page))
  // A remote deletion closes the UI without discarding the reader's draft.
  let open = $derived(box.visible(chain, id))
  let reply = $derived(open ? box.reply : null)
  // A press reveals the box; a box mounted again for a press already revealed
  // (Back, a fresh link, a refresh) stays where the page is, so the page's
  // own restore, or a quote's reveal, is not fought over.
  const shownAtMount = untrack(() => box.shown)
  let focusRequest = $derived(box.press > shownAtMount ? box.press : null)
  const revealed = () => { box.shown = box.press }

</script>

{#if open}
  {#if box.quoteFailure && wallet.account}
    <p class="small err connect-prompt" role="alert">could not quote this post. {box.quoteFailure.text}. <button onclick={() => void quoteAgain(chain, box)}>try again</button></p>
  {:else if wallet.account && reply}
    <Composer {chain} parentId={id} {focusRequest} nearest onshown={revealed} owner={reply} {onposted} oncancel={() => box.close()} />
  {:else}
    <!-- In place, without a reveal: the reader is looking at the card they pressed. -->
    <ConnectPrompt {chain} toDo={box.intent === 'quote' ? 'to quote' : 'to reply'} />
  {/if}
{/if}

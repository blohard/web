<script lang="ts">
  import type { Address } from 'viem'
  import { postReplyRuleView } from './post-reply-rule-view.svelte'
  import { replyRuleLabel } from '../publishing/reply-rules'
  import { href } from '../navigation/router.svelte'
  import type { ChainInfo } from '../../lib/types'

  let { chain, address, gate, postId = null, isReply = false, disabled = false, onsave }: {
    chain: ChainInfo
    address: Address
    gate: Address
    postId?: bigint | null
    isReply?: boolean
    disabled?: boolean
    onsave: (gate: Address, onProgress?: (note: string) => void) => void | Promise<void>
  } = $props()
  const view = postReplyRuleView(() => ({ chain, address, gate, postId, disabled, onsave }))
</script>

{#if view.visible && (chain.blocking || chain.closed_gate)}
<div class="post-reply-rule">
  <!-- The detail is its own element so a narrow layout can leave out the rule while keeping the full summary as the button's name. -->
  <button class="small" class:own-rule={view.current !== 'default'} aria-label={view.summary} aria-expanded={view.opened} disabled={disabled || view.busy} onclick={view.toggle}>reply rule{#if view.detail}<span class="rule-detail">{` · ${view.detail}`}</span>{/if}</button>
  {#if view.opened}
    <div class="rule-panel small">
      <label>who can reply
        <select aria-label="post reply rule" value={view.selected} onchange={(e) => view.choose(e.currentTarget.value)} disabled={disabled || view.busy || view.loading || view.readFailed}>
          {#if view.current === 'other'}<option value="other" disabled>custom gate</option>{/if}
          <option value="default">account default · {view.inherited}</option>
          <option value="all" disabled={!chain.blocking}>{replyRuleLabel('all', view.empty)}</option>
          {#if view.keysAvailable || view.current === 'keys'}
            <option value="keys" disabled={!view.keysAvailable}>{replyRuleLabel('keys', view.empty)}</option>
          {/if}
          {#if chain.closed_gate}<option value="closed">no new replies</option>{/if}
        </select>
      </label>
      <p class="dim">applies to new direct replies. <a href={href.about('moderation')} target="_blank" rel="noopener noreferrer">more about reply rules</a></p>
      {#if isReply}
        <p class="dim">{view.selected === 'closed'
          ? 'only the author you replied to can still respond while this post is live'
          : 'the author you replied to can always respond while this post is live'}</p>
      {:else if view.selected === 'closed'}<p class="dim">forbid new direct replies without hiding existing ones</p>{/if}
      {#if postId !== null}<p class="dim">changing this rule uses your own gas</p>{/if}
      {#if view.keysFailed}
        <p class="err">could not check account keys. <button onclick={view.refresh} disabled={view.busy}>try again</button></p>
      {/if}
      {#if view.readFailed}<p class="err">could not read your account rule. <button onclick={view.refresh} disabled={view.busy}>try again</button></p>{/if}
      <!-- A draft's choice is instant, so its line appears only to report a failure. A post's change is a transaction, with room kept for its stages. -->
      {#if postId !== null || view.note}
        <p class="operation-status transaction-status" class:working={view.saving} role="status" class:err={view.note && !view.note.ok}>{view.note?.text ?? (view.saving ? 'check your wallet…' : '')}</p>
      {/if}
    </div>
  {/if}
</div>
{/if}

<style>
  .post-reply-rule { display: contents; }
  .rule-panel { flex-basis: 100%; width: 100%; box-sizing: border-box; margin: .5rem 0; padding: .75rem; border: 1px solid var(--border); border-radius: 3px; background: var(--tint); }
  label { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; }
  select { max-width: 100%; min-height: 36px; }
  p { margin: .5rem 0 0; }
</style>

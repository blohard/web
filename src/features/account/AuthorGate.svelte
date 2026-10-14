<script lang="ts">
  // The account-wide reply rule. Settings owns the read of the rule and the
  // blocklist check, and hands in their state, so both cards share one retry.
  import type { Address } from 'viem'
  import type { KeyStatus } from '../keys/account-key-status.svelte'
  import { authorGateView } from './author-gate-view.svelte'
  import { otherGateLabel, replyRuleLabel } from '../publishing/reply-rules'
  import type { ChainInfo } from '../../lib/types'

  // blocklistEmpty: known to be empty, so the choices need not say "except blocked".
  // held: an earlier account change may still land, so no other is sent.
  let { chain, address, keyStatus, blocklistEmpty = false, loading = false, failed = false, held = false }: { chain: ChainInfo; address: Address; keyStatus: KeyStatus; blocklistEmpty?: boolean; loading?: boolean; failed?: boolean; held?: boolean } = $props()
  const view = authorGateView(() => ({ chain, address, keyStatus, blocklistEmpty, loading, failed }))
</script>

<!-- Settings shows this only while the account is active; deactivation has its own card there. -->
<div>
  <div class="controls">
    <label for="author-reply-rule">who can reply</label>
    <select id="author-reply-rule" value={view.selected} onchange={(e) => view.choose(e.currentTarget.value)} disabled={view.busy || held || loading || !view.current || failed}>
      {#if view.currentChoice === 'other'}
        <option value="other" disabled>{view.current ? otherGateLabel(chain, view.current) : 'loading…'}</option>
      {/if}
      <option value="all" disabled={!chain.blocking}>{replyRuleLabel('all', blocklistEmpty)}</option>
      {#if view.keysAvailable || view.currentChoice === 'keys'}
        <option value="keys" disabled={!view.keysAvailable}>{replyRuleLabel('keys', blocklistEmpty)}</option>
      {/if}
    </select>
  </div>
  <p class="small dim">applies to posts without their own reply rule</p>
  <p class="small operation-status transaction-status" class:working={view.saving} role="status" class:err={view.note && !view.note.ok}>{view.note?.text ?? (view.saving ? 'check your wallet…' : '')}</p>
</div>

<style>
  .controls { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem; }
  select { max-width: 100%; min-height: 36px; }
  p { margin: .5rem 0 0; }
</style>

<script lang="ts">
  import Loading from '../../shared/Loading.svelte'
  import AccountIdentity from '../../components/AccountIdentity.svelte'
  import { untrack } from 'svelte'
  import type { Address } from 'viem'
  import { explain } from '../../lib/errors'
  import { refreshCue } from '../../shared/refresh-cue.svelte'
  import { readKeyringPage, type KeyringSide } from './keyring-balances'
  import { KeyringBalancesView, type KeyringPlace } from './keyring-balances-view.svelte'
  import { href, router } from '../navigation/router.svelte'
  import { visitPlace } from '../navigation/visit-position'
  import { positionBookmark, rememberPosition, type Position } from '../navigation/page-position'
  import { wallet } from '../../lib/wallet.svelte'
  import type { ChainInfo } from '../../lib/types'
  import KeyringBalances from './KeyringBalances.svelte'

  let { chain, account, market, initialSide = 'holding', refreshRevision = 0 }: { chain: ChainInfo; account: Address | null; market: Address | null; initialSide?: KeyringSide; refreshRevision?: number } = $props()
  // App remounts this view when the account, chain, indexed market or entry tab changes.
  // Back and Forward return to the tab and page being read, and the bookmark to the row.
  const saved = untrack(() => router.visit.state<KeyringPlace>(`keyring/${chain.id}/${account}`, () => ({ side: initialSide, after: null, previous: [] }),
    place => ({ ...place, previous: [...place.previous] })))
  const resume = untrack(() => saved.side === initialSide)
  const start = untrack(() => resume ? saved : { side: initialSide, after: null, previous: [] })
  const view = new KeyringBalancesView((side, after) => readKeyringPage(chain, account!, market!, side, after), start)
  const position = untrack(() => {
    const bookmark = positionBookmark(visitPlace(), 'data-person')
    return { ...bookmark, restore: resume, save(place: Position) {
      // Save the pane with its bookmark before navigation mounts its replacement.
      bookmark.save(place)
      Object.assign(saved, view.place)
    } }
  })
  // Polls only cue changes to a page on screen, so a page that never loaded needs its own retry.
  let retry = $state(0)
  $effect(() => {
    void refreshRevision
    void retry
    if (account && market) return view.watch()
  })
  $effect(() => refreshCue.cueChanges(() => view.changed))
  const page = $derived(view.shown)
  const error = $derived(view.page.failure(view.key))
  const mine = $derived(wallet.is(account))
</script>

{#if account}
  <section class="profile">
    <AccountIdentity address={account}>
      {#if mine}<span class="dim small">· you</span>{/if}
    </AccountIdentity>
  </section>
{/if}

<section class="keyring-management" class:loading={!!account && !!market && !page && !error} use:rememberPosition={position}>
  {#if !market}
    <p class="dim">account keys are not available on this chain</p>
  {:else if !account}
    <p class="dim">connect your wallet to manage your keyring</p>
  {:else}
    <nav class="key-tabs" data-tab-row aria-label="keyring management views">
      <a data-page-tab class:active={view.side === 'holding'} aria-current={view.side === 'holding' ? 'page' : undefined} href={href.keyring(chain.id, account)}>{mine ? 'keys I hold' : 'keys they hold'}</a>
      <a data-page-tab class:active={view.side === 'holders'} aria-current={view.side === 'holders' ? 'page' : undefined} href={href.keyHolders(chain.id, account)}>{mine ? 'my key holders' : 'their key holders'}</a>
    </nav>
    {#if error}<p class="err" role="alert">{explain(error.cause)}. <button onclick={() => retry++} disabled={view.page.pending}>try again</button></p>{/if}
    {#if page}
      <div class="summary small dim">
        <span>{page.total.toLocaleString()} {page.total === 1 ? 'account' : 'accounts'} · page {view.previous.length + 1}</span>
      </div>
      {#if page.ownBalance === 0}
        <p class="small">{#if page.active || mine}<a href={page.active ? href.userKeys(chain.id, account) : href.keys(chain.id)}>{page.active ? mine ? 'manage your keys' : 'view market' : 'activate account keys'}</a> · {/if}<a href={href.keysAbout(chain.id)}>about account keys</a></p>
      {/if}
      <KeyringBalances {chain} {account} {page} side={view.side} own={mine} />
      {#if page.entries.length === 0}
        <p class="empty dim">{view.after ? 'no accounts on this page. return to the first page to see current holdings.' : view.side === 'holding' ? mine ? 'you hold no keys to other accounts yet' : 'this account holds no keys to other accounts yet' : 'no other key holders yet'}</p>
      {/if}
    {:else if view.page.pending}
      <Loading label="loading keyring…" />
    {/if}
    {#if view.previous.length || page?.next}
      <nav class="pagination small" aria-label="keyring pages">
        {#if view.previous.length}<button onclick={() => view.first()} disabled={view.page.pending}>first page</button>{/if}
        <button onclick={() => view.back()} disabled={view.page.pending || !view.previous.length}>previous</button>
        <button onclick={() => view.next()} disabled={view.page.pending || !page?.next}>next</button>
      </nav>
    {/if}
  {/if}
</section>

<style>
  .keyring-management { padding: 0 1rem 1rem; }
  /* Keep the visible tab row in place while the next pane is empty. */
  .keyring-management.loading { min-height: 100vh; }
  .key-tabs { margin-top: 1.25rem; }
  .summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .4rem; margin: 1rem 0; }
  .pagination { display: flex; justify-content: flex-end; gap: 1rem; margin-top: 1rem; }
  .empty { padding: 1rem 0; }
</style>

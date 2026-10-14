<script lang="ts">
  // Curated membership, bot labels and host blocks share one local policy and
  // admin. One list per tab (design/BOT_LABELS.md); blocked is the admin's only.
  import { getAddress, isAddress, zeroAddress, type Address } from 'viem'
  import { host } from '../../lib/host.svelte'
  import { readHostPolicy, saveHostList, type HostList } from '../../lib/host-policy'
  import { wallet } from '../../lib/wallet.svelte'
  import { explain } from '../../lib/errors'
  import { rememberPage } from '../navigation/visit-position'
  import type { ChainInfo } from '../../lib/types'
  import AddressRow from '../../components/AddressRow.svelte'
  import Takedowns from './Takedowns.svelte'
  import Name from '../../components/Name.svelte'
  import { href, router, type HostListTab } from '../navigation/router.svelte'

  let { chain, refreshRevision = 0 }: { chain: ChainInfo; refreshRevision?: number } = $props()
  let policy = $derived(host.status?.host_policy)
  let owner = $derived(!!policy && wallet.is(policy.admin))
  let tab = $derived<HostListTab>(router.route.kind === 'list' ? router.route.tab : 'curated')
  let tabs = $derived<HostListTab[]>(owner ? ['curated', 'bots', 'blocked', 'takedowns'] : ['curated', 'bots'])
  let input = $state<Record<HostList, string>>({ curated: '', blocked: '', bots: '' })
  let shown = $state<Record<HostList | 'declared_bots', number>>({ curated: 50, blocked: 50, bots: 50, declared_bots: 50 })
  let note = $state<{ list: HostList; error: boolean; text: string } | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)
  async function refresh() {
    try { await readHostPolicy(); error = null }
    catch (e) { error = explain(e) }
  }
  $effect(() => { void refreshRevision; void refresh() })

  function addresses(text: string): Address[] {
    const values = text.trim().split(/[\s,;]+/)
    if (!values.length || values.length > 100 || values.some(a => !isAddress(a) || a.toLowerCase() === zeroAddress)) throw new Error('enter up to 100 wallet addresses')
    return [...new Set(values.map(a => getAddress(a)))]
  }
  async function write(list: HostList, action: 'add' | 'remove') {
    if (busy || !owner) return
    busy = true
    try {
      const values = addresses(input[list])
      note = { list, error: false, text: 'approve the list change in your wallet…' }
      await saveHostList(wallet, list, action, values)
      input[list] = ''
      note = { list, error: false, text: action === 'add' ? 'addresses added' : 'addresses removed' }
    } catch (e) { note = { list, error: true, text: explain(e) } }
    finally { busy = false }
  }
  const HEADINGS: Record<HostList, string> = { curated: 'curated accounts', bots: 'bots labelled by this host', blocked: 'blocked accounts' }
  const ABOUT: Record<HostList, string> = {
    curated: 'listed accounts get a badge and appear in the curated feed.',
    bots: 'a muted robot appears next to these names. an account’s own statement shows a bright robot, and neither replaces the other.',
    blocked: 'these accounts cannot post through this host, and their posts are hidden here. blocking takes priority over curation.',
  }
</script>

<div class="host-lists" use:rememberPage={'data-person'}>
  {#if error}<p class="err">{error} <button onclick={refresh}>try again</button></p>{/if}
  {#if !policy}
    <p class="dim">this host has no curated list.</p>
  {:else}
    <p class="dim small">managed by <a href={href.user(chain.id, policy.admin)}><Name address={policy.admin} /></a>{#if owner}{' (you)'}{/if}</p>
    <nav class="tabs page-tabs list-tabs small" data-tab-row aria-label="host lists">
      {#each tabs as t (t)}
        <a data-page-tab class:active={tab === t} aria-current={tab === t ? 'page' : undefined} href={href.list(t)}>{t}</a>
      {/each}
    </nav>
    {#if (tab === 'blocked' || tab === 'takedowns') && !owner}
      <p class="dim">the host admin manages this list.</p>
    {:else if tab === 'takedowns'}
      <Takedowns />
    {:else}
      {@const list = tab}
      {@const members = policy[list] ?? []}
      <section>
        <div class="listhead">
          <h2>{HEADINGS[list]}</h2>
          <p class="dim small">{ABOUT[list]}</p>
          {#if owner}
            <label class="small" for={`host-${list}`}>addresses to add or remove</label>
            <textarea id={`host-${list}`} bind:value={input[list]} rows="3" disabled={busy} placeholder="wallet addresses, one per line or comma-separated"></textarea>
            <div class="row small">
              <span class="grow">{members.length} account{members.length === 1 ? '' : 's'}</span>
              <button onclick={() => write(list, 'add')} disabled={busy || !input[list].trim()}>add</button>
              <button class="danger" onclick={() => write(list, 'remove')} disabled={busy || !input[list].trim()}>remove</button>
            </div>
            <p class="operation-status small" role="status" class:err={note?.list === list && note.error}>{note?.list === list ? note.text : ''}</p>
          {/if}
        </div>
        {#each members.slice(0, shown[list]) as address (address)}
          <AddressRow {chain} {address} />
        {:else}<p class="dim">nobody on the list yet.</p>{/each}
        {#if members.length > shown[list]}<button onclick={() => shown[list] += 50}>show more accounts</button>{/if}
      </section>
      {#if list === 'bots'}
        <section>
          <div class="listhead">
            <h2>bots by their own statement</h2>
            <p class="dim small">these accounts declared themselves bots and show a bright robot. only they can withdraw it.</p>
          </div>
          {#each (policy.declared_bots ?? []).slice(0, shown.declared_bots) as address (address)}
            <AddressRow {chain} {address} />
          {:else}<p class="dim">no account has declared itself a bot yet.</p>{/each}
          {#if (policy.declared_bots ?? []).length > shown.declared_bots}<button onclick={() => shown.declared_bots += 50}>show more accounts</button>{/if}
        </section>
      {/if}
    {/if}
  {/if}
</div>
<style>
  .host-lists > p, section > p { padding: 0 1rem; }
  section { margin-bottom: 2rem; }
  .listhead { padding: 0.8rem 1rem; }
  .listhead textarea { margin-top: 0.4rem; min-height: 3.5rem; }
  h2 { font-size: 1rem; }
  nav.list-tabs { margin-bottom: 1rem; }
  @media (max-width: 600px) {
    nav.list-tabs a { padding-inline: .3rem; }
  }
</style>

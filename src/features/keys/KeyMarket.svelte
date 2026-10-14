<script lang="ts">
  import Loading from '../../shared/Loading.svelte'
  import { loadingDelay } from '../../shared/loading-delay.svelte'
  import { onDestroy, untrack, type Snippet } from 'svelte'
  import { KeyPage, keyQuote } from './key-page.svelte'
  import Eth from '../../shared/Eth.svelte'
  import KeyTransactionStatus from './KeyTransactionStatus.svelte'
  import Name from '../../components/Name.svelte'
  import WalletHint from '../../components/WalletHint.svelte'
  import { formatEther, zeroAddress, type Address } from 'viem'
  import { keyDeployment, keyMarket, tradeKeyAmount } from './account-keys'
  import { canRetryRecipient, recipientInput, resolveRecipient } from './recipient'
  import { wallet } from '../../lib/wallet.svelte'
  import { captureWallet } from '../../lib/wallet-action'
  import { ethAmount, shortAddress } from '../../lib/format'
  import { keyCurveChart, keyPrice, MAX_KEY_SUPPLY } from './key-curve'
  import { host } from '../../lib/host.svelte'
  import { href } from '../navigation/router.svelte'
  import { explainKeyError as explain } from '../../lib/errors'
  import { burstKeys, sellKeys, sendKeys } from './key-burst'
  import { TradeCapture } from './trade-capture.svelte'
  import type { ChainInfo } from '../../lib/types'

  let { chain, creator, refreshRevision = 0, loading: loadingContent }: { chain: ChainInfo; creator: Address; refreshRevision?: number; loading?: Snippet } = $props()
  // The parent remounts this view for a different chain, creator or wallet account.
  const deployment = untrack(() => keyDeployment(chain))
  const api = untrack(() => deployment ? keyMarket(chain, deployment) : null)
  const spinnerReady = loadingDelay(() => loadingContent ? null : api)
  const page = untrack(() => new KeyPage(api, creator, wallet.account ?? zeroAddress,
    `blohard.account-keys.trade/${chain.id}/${deployment?.address}/${creator}/${wallet.account}`, 'trade'))
  const tracking = page.tracking
  // Tabs cannot change during a pending trade, including receipt recovery.
  // Only that tab needs a fresh amount; claims leave all quantities alone.
  const stopReset = page.onConfirmed(hash => {
    if (!capture.owns(hash)) statusAction = null
    else if (statusAction && statusAction !== 'claim') quantities[statusAction] = ''
  })
  onDestroy(() => { stopReset(); page.dispose() })
  $effect(() => { void refreshRevision; void page.readRevision; return untrack(() => page.watch()) })
  const mine = $derived(wallet.is(creator))
  const holdersAvailable = $derived(!!deployment && host.keyringMarket(chain.id)?.toLowerCase() === deployment.address.toLowerCase())
  const accountState = $derived(page.account.value())
  const loading = $derived(page.account.pending)
  const pending = $derived(tracking.hash)
  const busy = $derived(tracking.busy)
  /** This page's trade or claim is being signed, or is sent and not yet settled: the controls stay locked. */
  const inFlight = $derived(busy || !!pending)
  const readError = $derived(page.account.failure() ? explain(page.account.failure()!.cause) : '')
  const error = $derived(page.error || readError)
  let side = $state<'buy' | 'sell' | 'transfer'>('buy')
  let statusAction = $state<'buy' | 'sell' | 'transfer' | 'claim' | null>(null)
  const noKeys = $derived(!!wallet.account && accountState?.holdings === 0n && side !== 'buy')
  const controlsDisabled = $derived(inFlight || noKeys)
  let recipient = $state('')
  /** Each tab keeps its own amount: a number typed to buy says nothing about selling. */
  const quantities = $state({ buy: '1', sell: '1', transfer: '1' })
  const quantity = $derived(quantities[side])
  const emptyQuantity = $derived(quantity.trim() === '')
  let refresh = $state(0)
  const eth = (value: bigint) => `${formatEther(value)} ETH`
  const inputError = $derived.by(() => {
    try {
      const amount = tradeKeyAmount(quantity)
      if (side === 'buy' && accountState && amount > MAX_KEY_SUPPLY - accountState.supply) return 'this purchase would exceed the market supply limit'
      if (side !== 'buy' && wallet.account && accountState && amount > accountState.holdings) return 'you do not hold that many keys'
      return ''
    } catch (e) { return explain(e) }
  })

  const recipientTarget = $derived(recipientInput(recipient))
  let recipientRetry = $state(0)
  const resolvedRecipient = keyQuote(() => {
    void recipientRetry
    const name = recipientTarget.name
    return side === 'transfer' && !noKeys && name ? () => resolveRecipient(name) : null
  })
  const recipientAddress = $derived(recipientTarget.address ?? resolvedRecipient.value?.address ?? null)
  const recipientError = $derived.by(() => {
    if (side !== 'transfer') return ''
    if (recipientTarget.error || resolvedRecipient.error) return recipientTarget.error || resolvedRecipient.error
    if (!recipientAddress) return ''
    try { api?.transferRecipient(recipientAddress, wallet.account ?? zeroAddress); return '' }
    catch (e) { return explain(e) }
  })
  const needsRecipient = $derived(side === 'transfer' && (!recipientAddress || !!recipientError))

  const quantityLimit = $derived(side === 'buy' ? MAX_KEY_SUPPLY - (accountState?.supply ?? 0n) : accountState?.holdings ?? 0n)
  const chart = $derived(keyCurveChart(accountState?.supply ?? 0n, side, inputError ? 0 : Number(quantity)))

  const quotes = keyQuote(() => {
    void refresh; void page.revision
    const direction = side, author = creator, amount = inputError ? null : tradeKeyAmount(quantity)
    return api && accountState?.active && !noKeys && amount !== null
      ? async () => ({ side: direction, amount, value: await api.tradeQuote(author, direction, amount) }) : null
  })
  const quote = $derived(quotes.value)
  // The reviewed transaction this page sent, not a cache of the current market price.
  const capture = new TradeCapture<NonNullable<typeof quote> & { recipient: Address | null }>()
  // A hash recovered from storage or another tab has no known initiating control.
  $effect(() => { if (pending && !capture.owns(pending)) statusAction = null })
  const captured = $derived(capture.shown(pending))
  const trade = $derived(captured ?? (quote ? { ...quote, recipient: needsRecipient ? null : recipientAddress } : null))
  const quoteError = $derived(captured ? '' : quotes.error)
  let tradeButton = $state<HTMLButtonElement>()
  let claimButton = $state<HTMLButtonElement>()
  /** Once the receipt of a trade this page sent confirms: keys burst out of a purchase, ETH comes back from a sale, keys leave on a transfer. */
  const celebrations = { buy: burstKeys, sell: sellKeys, transfer: sendKeys }
  function celebrate(side: keyof typeof celebrations, amount: bigint) {
    if (tradeButton?.isConnected) celebrations[side](tradeButton, amount)
  }
  async function submit(action: 'trade' | 'claim') {
    const pressed = captureWallet(wallet), author = creator, reviewed = quote, to = recipientAddress
    if (!api || !pressed || !accountState?.active) return
    const { account: caller, provider } = pressed
    const recipientLabel = to ? resolvedRecipient.value?.name ?? shortAddress(to) : ''
    if (action === 'trade' && (noKeys || !reviewed || inputError || needsRecipient || reviewed.side !== side || reviewed.amount !== tradeKeyAmount(quantity))) return
    if (action === 'claim' && (!mine || accountState.fees === 0n)) return
    try {
      await page.send(async guard => {
        statusAction = action === 'claim' ? 'claim' : reviewed!.side
        capture.begin(action === 'trade' && reviewed ? { ...reviewed, recipient: to } : null)
        await wallet.ensureChain(chain)
        const ready = () => {
          guard()
          if (!pressed.current()) throw new Error('the wallet changed. review the transaction again')
        }
        ready()
        const hash = await (action === 'claim' ? api.claim(provider, caller, author, ready)
          : reviewed!.side === 'transfer' ? api.transfer(provider, caller, author, to!, reviewed!.amount, reviewed!.value.total, ready)
          : api.trade(provider, caller, author, reviewed!.side, reviewed!.amount, reviewed!.value.total, ready))
        capture.sent(hash)
        return hash
      }, action === 'claim' ? () => {
        if (claimButton?.isConnected) sellKeys(claimButton, 1n)
      } : reviewed!.side === 'transfer' ? receipt => {
        api.confirmTransfer(receipt, author, caller, to!, reviewed!.amount)
        celebrate('transfer', reviewed!.amount)
        return `transferred ${reviewed!.amount.toLocaleString()} ${reviewed!.amount === 1n ? 'key' : 'keys'} to ${recipientLabel}`
      } : () => celebrate(reviewed!.side, reviewed!.amount))
    } finally { capture.end() }
  }
</script>

<section class="key-market">
  <p class="small"><a href={href.keysAbout(chain.id)}>about account keys</a></p>
  {#if accountState}
    <header class="market-heading">
      <h2><svg class="gold-key" width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 13.5a6 6 0 1 1 4.5-4.5L22 17.5V21h-4v-3h-3v-3l-1.5-1.5Z" fill="#f5bf35" stroke="#95620b" stroke-width="1.5" stroke-linejoin="round" /><circle cx="7.5" cy="7.5" r="2" fill="var(--bg)" stroke="#95620b" stroke-width="1.5" /></svg> keys to <Name address={creator} /></h2>
      {#if holdersAvailable}<a class="keyring-link small" href={href.keyring(chain.id, creator)}>view keyring</a>{/if}
    </header>
  {/if}
  {#if !api}
    <p>the account-key market is not configured on this chain.</p>
  {:else if loading && !accountState}
    {#if loadingContent}{@render loadingContent()}
    {:else if spinnerReady()}<Loading label="loading account keys…" />{/if}
  {:else if accountState && !accountState.active}
    <p>this account has not activated keys.</p>
  {:else if accountState}
    <dl class="stats">
      <div><dt>next key · before fees</dt><dd>{#if accountState.supply < MAX_KEY_SUPPLY}<Eth wei={keyPrice(accountState.supply + 1n)} unit={false} /> <span aria-hidden="true">ETH</span>{:else}supply limit reached{/if}</dd></div>
      <div><dt>keys in circulation</dt><dd>{#if holdersAvailable}<a href={href.keyHolders(chain.id, creator)} title="view key holders">{accountState.supply.toLocaleString()}</a>{:else}{accountState.supply.toLocaleString()}{/if}</dd></div>
      <div><dt>your keys</dt><dd>{wallet.account ? accountState.holdings.toLocaleString() : wallet.canConnect ? 'connect wallet' : 'no wallet'}</dd></div>
    </dl>
    {#if statusAction === null && (inFlight || page.phase || error)}<KeyTransactionStatus {chain} {page} {error} />{/if}
    <div class="trade-card">
      <div class="key-tabs direction" aria-label="trade direction">
        <button class:active={side === 'buy'} aria-pressed={side === 'buy'} disabled={inFlight} onclick={() => side = 'buy'}>buy</button>
        <button class:active={side === 'sell'} aria-pressed={side === 'sell'} disabled={inFlight} onclick={() => side = 'sell'}>sell</button>
        <button class:active={side === 'transfer'} aria-pressed={side === 'transfer'} disabled={inFlight} onclick={() => side = 'transfer'}>transfer</button>
      </div>
      {#if noKeys}<p class="dim" role="status">you hold no keys to {side}</p>{/if}
      <div class="quantity-row">
        <label for="trade-keys">number of keys</label>
        <div class="stepper">
          <button aria-label="one fewer key" disabled={controlsDisabled || !/^[1-9][0-9]{0,9}$/.test(quantity.trim()) || Number(quantity) <= 1} onclick={() => quantities[side] = String(Number(quantity) - 1)}>−</button>
          <input id="trade-keys" type="text" inputmode="numeric" bind:value={quantities[side]} disabled={controlsDisabled} aria-invalid={!noKeys && !emptyQuantity && !!inputError} />
          <button aria-label="one more key" disabled={controlsDisabled || (!emptyQuantity && !/^(0|[1-9][0-9]{0,9})$/.test(quantity.trim())) || Number(quantity) >= Number(quantityLimit)} onclick={() => quantities[side] = String(Number(quantity) + 1)}>+</button>
        </div>
      </div>
      {#if side === 'transfer'}
        <div class="recipient-row"><label for="key-recipient">recipient address or name</label>
          <input id="key-recipient" type="text" bind:value={recipient} aria-invalid={!noKeys && !!recipientError} aria-describedby="key-recipient-status" disabled={controlsDisabled} autocomplete="off" spellcheck="false" />
        </div>
        <p id="key-recipient-status" class="recipient-status small" class:err={!!recipientError} class:dim={!!recipientTarget.hint} aria-live="polite">
          {#if !noKeys}
            {#if recipientError}{recipientError}{#if canRetryRecipient(resolvedRecipient.failure?.cause)} <button disabled={controlsDisabled} onclick={() => recipientRetry++}>try again</button>{/if}
            {:else if recipientTarget.hint}{recipientTarget.hint}
            {:else if recipientTarget.name && !resolvedRecipient.value}looking up recipient…
            {:else if resolvedRecipient.value}{resolvedRecipient.value.name} → {recipientAddress}{/if}
          {/if}
        </p>
        <p class="small dim">you pay the transfer fee. the recipient pays nothing.</p>
        {#if !noKeys && !inputError && accountState.holdings === BigInt(quantity)}<p class="small dim">moving your last key removes this wallet's key access. replies from this wallet may fold on the next refresh.</p>{/if}
      {/if}
      <figure class="curve">
        <div class="curve-heading"><span>price curve</span><span class="small dim">price per key · before fees</span></div>
        <svg viewBox="0 0 600 176" role="img" aria-label={`illustrative price curve. current supply ${chart.supply} keys. selected trade would bring supply to ${chart.after}.`}>
          <line class="grid" x1="24" y1="24" x2="576" y2="24" />
          <line class="grid" x1="24" y1="86" x2="576" y2="86" />
          <path class="area" d={`${chart.path} L576,148 L24,148 Z`} />
          <path class="curve-line" d={chart.path} />
          <line class="marker" x1={chart.x} y1={chart.y} x2={chart.x} y2="148" />
          <circle class="now" cx={chart.x} cy={chart.y} r="5" />
          {#if !inputError}<circle class="after" cx={chart.endX} cy={chart.endY} r="5" />{/if}
          <text x="24" y="169">0 keys</text><text x="576" y="169" text-anchor="end">{chart.max.toLocaleString()} keys</text>
          <text x="576" y="16" text-anchor="end">{ethAmount(keyPrice(BigInt(chart.max)))} ETH</text>
        </svg>
        <figcaption class="small dim"><span><i class="now-dot"></i> now · {chart.supply.toLocaleString()}</span>{#if !inputError}<span><i class="after-dot"></i> after {side} · {chart.after.toLocaleString()}</span>{/if}</figcaption>
      </figure>
      {#if !noKeys && !emptyQuantity && inputError}<p class="err" role="alert">{inputError}</p>
      {:else if !noKeys && quoteError}<p class="err" role="alert">{quoteError} <button disabled={inFlight} onclick={() => refresh++}>retry</button></p>
      {/if}
      {#if wallet.account}
        <button class="trade" class:signing={!!captured} aria-busy={inFlight} title={trade ? `${eth(trade.value.total)}${trade.side === 'transfer' && trade.recipient ? ` to ${trade.recipient}` : ''}` : undefined} bind:this={tradeButton} disabled={controlsDisabled || wallet.busy || !quote || !!inputError || needsRecipient || !!quoteError} onclick={() => submit('trade')}>
          {#if trade}{trade.side} {trade.amount.toString()} {trade.amount === 1n ? 'key' : 'keys'}{#if trade.side === 'transfer' && trade.recipient}{' '}to {shortAddress(trade.recipient)}{/if}{' '}· {trade.side === 'transfer' ? 'fee ~' : '~'} <Eth wei={trade.value.total} />
          {:else if !noKeys && !inputError && !quoteError}loading quote…{:else}{side}{/if}
        </button>
      {:else}
        {#if !inputError && !quoteError}<p class="quote-total" role="status">{#if quote}{side === 'transfer' ? 'fee ~' : '~'} <Eth wei={quote.value.total} />{:else}loading quote…{/if}</p>{/if}
        <!-- Prices and holders are public: only trading needs a wallet. -->
        <p class="connect-note">{#if wallet.canConnect}connect your wallet to buy, sell or transfer keys.{:else}<WalletHint toDo="to buy, sell or transfer keys" />{/if}</p>
      {/if}
      {#if statusAction === side}<KeyTransactionStatus {chain} {page} {error} />
      {:else if statusAction !== null && statusAction !== 'claim' && readError}<p class="err" role="alert">{readError}</p>{/if}
    </div>
    {#if mine}
      <!-- A card of its own, like the trade card, so claiming is not read as part of trading. -->
      <div class="trade-card fee-card">
        <h3>your fees</h3>
        <p><Eth wei={accountState.fees} round="down" /> available to claim.</p>
        <button class="trade" bind:this={claimButton} disabled={inFlight || wallet.busy || accountState.fees === 0n} onclick={() => submit('claim')}>claim fees</button>
        {#if statusAction === 'claim'}<KeyTransactionStatus {chain} {page} {error} />{/if}
      </div>
    {/if}
  {/if}
  {#if !api || !accountState?.active}<KeyTransactionStatus {chain} {page} {error} />{/if}
</section>

<style>
  .key-market { padding: 1rem; }
  .market-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: .4rem 1rem; margin: 1.2rem 0; }
  .market-heading h2 { font-size: 1.25rem; margin: 0; overflow-wrap: anywhere; min-width: 0; }
  .keyring-link { white-space: nowrap; }
  .gold-key { color: #c38c16; font-size: 1.6rem; vertical-align: middle; }
  .stats { display: grid; grid-template-columns: 1.5fr 1fr 1fr; margin: 0; border: 1px solid var(--border); border-radius: 4px; }
  .stats > div { padding: 1rem .8rem; }
  .stats > div + div { border-left: 1px solid var(--border); }
  dt { color: var(--dim); font-size: .78rem; line-height: 1.4; min-height: 2.8em; }
  dd { margin: .5rem 0 0; font-size: 1.3rem; font-weight: 600; overflow-wrap: anywhere; }
  dd span { font-size: .75rem; font-weight: normal; }
  .curve { margin: 1.3rem 0; }
  .curve-heading, figcaption, .quantity-row { display: flex; justify-content: space-between; gap: .7rem; align-items: center; }
  .curve-heading { margin-bottom: .6rem; }
  .curve svg { display: block; width: 100%; overflow: visible; }
  .grid { stroke: var(--border); stroke-dasharray: 3 5; }
  .area { fill: var(--accent); opacity: .07; }
  .curve-line { fill: none; stroke: var(--accent); stroke-width: 2; }
  .marker { stroke: var(--dim); stroke-dasharray: 3 4; }
  .now { fill: var(--bg); stroke: var(--accent); stroke-width: 2; }
  .after { fill: #e4af2b; stroke: #95620b; stroke-width: 1.5; }
  svg text { fill: var(--dim); font-size: 11px; }
  figcaption { justify-content: center; gap: 1.5rem; }
  figcaption span { display: inline-flex; gap: .4rem; align-items: center; }
  figcaption i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .now-dot { border: 2px solid var(--accent); }
  .after-dot { background: #e4af2b; border: 1px solid #95620b; }
  .trade-card { margin-top: 1.3rem; border: 1px solid var(--border); border-radius: 4px; padding: 1rem; background: var(--bg); }
  .fee-card { margin-top: 1.2rem; background: var(--tint); }
  .fee-card h3 { margin: 0 0 .5rem; font-size: 1rem; }
  .fee-card p { margin: 0; }
  .direction { margin: -1rem -1rem 1rem; background: var(--tint); }
  .direction button { flex: 1; }
  .stepper { display: flex; align-items: center; gap: .3rem; }
  .stepper button { min-width: 36px; min-height: 40px; font-size: 1.15rem; }
  .stepper button::before, .stepper button::after { content: none; }
  .quantity-row { flex-wrap: wrap; }
  input { width: 12ch; text-align: center; padding: .5rem; }
  .recipient-status { min-height: 2lh; overflow-wrap: anywhere; }
  .recipient-row { display: grid; gap: .5rem; margin-top: 1rem; }
  .recipient-row input { width: 100%; box-sizing: border-box; text-align: left; }
  .trade { display: block; width: 100%; min-height: 48px; margin-top: 1rem; padding: .7rem .5rem; border: 1px solid var(--accent); border-radius: 3px; background: var(--bg); color: var(--accent); font-weight: 600; overflow-wrap: anywhere; }
  .trade:hover:not(:disabled) { background: var(--accent); color: var(--bg); }
  .trade::before, .trade::after { color: inherit; }
  .trade:disabled { color: var(--dim); border-color: var(--border); cursor: default; }
  .trade:disabled.signing { color: var(--accent); border-color: var(--accent); }
  .quote-total { min-height: 2lh; text-align: center; font-weight: 600; overflow-wrap: anywhere; }
  .connect-note { text-align: center; }
  @media (max-width: 600px) { .trade { min-height: calc(2lh + 1.4rem + 2px); } }
  @media (max-width: 480px) {
    .stats { grid-template-columns: 1fr 1fr; }
    .stats > div:first-child { grid-column: 1 / -1; border-bottom: 1px solid var(--border); }
    .stats > div:nth-child(2) { border-left: 0; }
    .curve-heading { flex-wrap: wrap; }
  }
</style>

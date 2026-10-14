<script lang="ts">
  // Static text and the configured addresses. Loaded on its own, without the market code.
  import { addressUrl, chainLabel } from '../../lib/chains'
  import { keyDeployment } from './account-keys-config'
  import whaleKeys from '../../assets/whale-keys.jpg'
  import { href } from '../navigation/router.svelte'
  import { rememberPage } from '../navigation/visit-position'
  import type { ChainInfo } from '../../lib/types'
  let { chain }: { chain: ChainInfo } = $props()
  const deployment = $derived(keyDeployment(chain))
  const marketUrl = $derived(deployment ? addressUrl(chain, deployment.address) : null)
</script>

<section class="keys-page keys-about">
<img class="keys-banner" src={whaleKeys} alt="the blohard whale holding a big golden key in its fin" width="1200" height="654" />
<div use:rememberPage>
<h2 class="about-title">account keys</h2>

<p>collect keys to the people you enjoy reading. your keyring brings their posts together in a dedicated feed, and keys can unlock conversations reserved for holders.</p>
<p>activate your own keys to let others collect yours. you earn a share of the fees when your keys are bought, sold or transferred. your market opens only when you choose to activate it.</p>

<h3>activation</h3>
<p><a href={href.keys(chain.id)}>open the activation page</a> with your wallet connected on {chainLabel(chain)}. once activated, your profile shows the <strong>keys</strong> tab.</p>
<p>activation is permanent. you can buy initial keys in the activation transaction, before anyone else can buy. choosing zero opens your market without buying keys. activation and purchases require network gas, even if you qualify for free posting.</p>

<h3>buying and selling</h3>
<ol>
  <li>open an activated account’s profile and select the <strong>keys</strong> tab, or click the golden key beside their name.</li>
  <li>connect your wallet and choose <strong>buy</strong> or <strong>sell</strong>. you can sell only keys held by the connected wallet.</li>
  <li>choose how many keys to buy or sell using the quantity field or the + and − controls. the chart illustrates how the trade changes the supply and curve price.</li>
  <li>review the total on the action button, then confirm the transaction in your wallet on {chainLabel(chain)}. the page updates your holdings after confirmation.</li>
</ol>
<p>you can buy another account’s keys without activating your own account. the market shows keys in circulation, your holdings, and the approximate price of the next key before fees. the transaction total comes from the contract quote.</p>
<p>for purchases, the displayed total is your maximum payment. any excess is refunded. for sales, it is the minimum you receive after trading fees. network gas is additional. if prices move against your quote, review the updated amount before trying again.</p>

<h3>transferring keys</h3>
<p>open that account’s keys tab and select <strong>transfer</strong>. enter the recipient’s wallet address, ENS name or Basename and number of keys. for a name, check the resolved wallet address, then review the fee and confirm in your wallet. the recipient need not activate their own keys.</p>
<p>you pay a 5% fee on what selling that batch would return before fees. the recipient pays nothing. no sale payment changes hands, and supply and reserves stay the same. network gas is additional.</p>
<p>moving your last key removes this wallet’s key access. its earlier replies may fold on the next refresh. moving keys does not move posts or their author identity.</p>

<h3>your keyring feed</h3>
<p>the <strong>keyring</strong> tab on the home feed appears when you have activated account keys or hold another account’s keys. connect that wallet to see two views.</p>
<ul>
  <li><strong>keys I hold</strong> · posts and replies from accounts whose keys you own.</li>
  <li><strong>my key holders</strong> · posts and replies from people who hold your keys. available after activation, even when you have no holders yet.</li>
</ul>
<p>each view includes only posts and replies by its selected accounts. your own account is excluded from both lists, even if you hold your own keys, so your standalone posts do not appear. your messages can still appear as context for replies.</p>
<p>buying or receiving a first key adds the account to the relevant list. selling or transferring the last removes it. gifted keys count exactly like purchased keys in both feeds. once the host indexes confirmed trades, membership changes bring up the refresh button. press it to update the feed. selling your last key leaves the selected keyring view open with an empty list. your following list stays separate. keys on Base and Base Sepolia are separate. balances and activation do not carry between chains.</p>

<h3>managing your keyring</h3>
<p>notifications show when someone buys or sells your account’s keys, and when someone sends you keys, with links to the market and the transaction. your own trades, and activity from blocked or muted accounts, are hidden. new activity brings up the refresh button instead of moving the list.</p>
<p>choose <strong>keyring</strong> in the navigation after activating keys or acquiring another account’s keys. you can also open it from the keyring feed or settings. <strong>keys I hold</strong> shows your holdings and links to each account’s market to buy, sell or transfer. <strong>my key holders</strong> shows the people who hold your keys. your own keys appear separately.</p>
<p>on a key market, select the <strong>keys in circulation</strong> number to see its holders and their balances.</p>
<p>to browse someone else’s holdings, choose <strong>view keyring</strong> beside <strong>keys to</strong> in their profile’s <strong>keys</strong> tab. public keyrings show <strong>keys they hold</strong> and <strong>their key holders</strong>, and need no connected wallet.</p>
<p>gifted keys count just like purchases. the page can show every holding, including accounts beyond the feed’s limit. pages follow address order, with larger holdings first within each page.</p>
<p>balances come from the host’s chain index. changes bring up the refresh button and stay off screen until you choose to show them. when browsing someone else’s keyring, opening a market still trades using your connected wallet’s holdings.</p>

<h3>reply gates</h3>
<p>when your blocklist is empty, the choices in settings are labeled <strong>all</strong> and <strong>key holders</strong>. when it has entries, both add <strong>except blocked</strong>. the rules keep enforcing your blocklist either way.</p>
<p>after activating keys, open settings and use <strong>who can reply</strong> to select <strong>key holders except blocked</strong>. choosing a rule opens your wallet to confirm the transaction. this option is available only where the host has verified a combined key and blocklist gate. choose <strong>all except blocked</strong> to reopen replies without giving up your blocklist.</p>
<p>use <strong>reply rule</strong> beneath the composer or beside your own live post or reply on its thread page to choose <strong>account default</strong> or a rule for that post. an explicit rule overrides your account default until you change it and stays in place if you deactivate your account. it applies to direct replies, not every reply further down the conversation. the author you replied to can always answer your live reply, even without keys or when blocked. you cannot remove those answers.</p>
<p>choose <strong>no new replies</strong> to close ordinary direct replies to a post. protected answers remain allowed and bypass blocklist and key-based folding. other replies keep the usual display rules. choose another rule to reopen.</p>
<p>when a reply requires a key you do not hold, the composer links to the author’s key market in another tab. buy there, then return. the composer rechecks when you return to the tab. buying a key does not remove a block.</p>
<p>a rule chosen during sponsored posting is included at no gas cost to you. changing a rule on a published post or in settings uses your wallet’s gas.</p>
<p>if an account or post uses a supported key gate, holding a key lets you reply unless the combined gate blocks you. when the author’s account-level rule requires keys, selling or transferring your last key folds unprotected replies on the next refresh. buying back can reveal them again, but the author’s blocklist folds blocked accounts' unprotected replies regardless of the gate. folded replies remain on chain and readers can choose to reveal them.</p>
<p>post-level rules affect new replies only. changing a post’s rule does not hide or reveal existing replies. replies already on screen keep their displayed state until you refresh, and a failed page refresh preserves that state.</p>

<h3>claiming fees</h3>
<p>connect the wallet that activated your account, open the keys tab on your own profile, and select <strong>claim fees</strong> when fees are available. confirm in your wallet. the page updates after the payout is confirmed.</p>

<h3>how prices work</h3>
<p>the contract sets prices using a bonding curve. as the number of keys in circulation increases, each additional key costs more. selling keys reduces the supply and moves the price back down the same curve.</p>
<p>prices follow a curve close to <code>0.00001 ETH + 1 ETH × (n / 10,000)^1.5</code> for the nth key, before fees, so the 10,000th key costs about 1 ETH. a purchase of several keys costs the same as buying them one at a time.</p>
<p>purchase payments, excluding fees, stay in the contract to fund sales back to the curve. keys are whole units and transfers leave their backing in the contract. prices can fall as well as rise.</p>

<h3>fees</h3>
<p>purchases, sales and transfers have a 5% fee. transfers pay it on what selling the batch would return.</p>
<ul>
  <li>4.5% goes to the person whose keys are being traded.</li>
  <li>0.5% goes to the dev fund.</li>
</ul>
<p>purchase fees are added to the curve price. sale fees are deducted from the proceeds. the activation form and buy/sell controls show totals including trading fees, excluding network gas.</p>
<p>when you buy your own keys, the 4.5% fee accrues to you. these fees are held for withdrawal. anyone can trigger a payout, but it always goes to the account owner.</p>

{#if deployment}
  <h3>deployment</h3>
  <p class="small mono-break">market · {#if marketUrl}<a href={marketUrl} target="_blank" rel="noopener noreferrer">{deployment.address}</a>{:else}{deployment.address}{/if}</p>
  <p class="small mono-break">dev fund · {deployment.devFund}</p>
{/if}
<h3>built on blohard</h3>
<p>account keys are an optional app layered on top of the core <a href="/design.html">blohard protocol</a>. a separate smart contract manages keys, trading, and fees, using the same wallet addresses that identify authors on blohard. adding it required no changes to the core posting contract.</p>
<p>this is web3 composability in practice. independent apps can build on shared identities and public contracts to create new experiences. anyone can build another interface or an app that uses account keys, while blohard remains usable without activating them.</p>

<p><a href={href.keys(chain.id)}>back to account keys</a></p>
</div>
</section>

<style>
  .keys-page { padding: 1rem; }
  .keys-banner { display: block; width: 100%; height: auto; border-radius: 3px; margin-bottom: 1rem; }
  .about-title { font-size: 1.1rem; line-height: 1.35; margin: 1.5rem 0 .5rem; }
</style>

<script lang="ts">
  // What this is, in plain words: what the chain holds, what it does not, and
  // what that means for you. Facts about this particular host come from its
  // status, everything else is the protocol.
  import { untrack } from 'svelte'
  import whale from '../assets/whale.jpg'
  import { chainLabel, initialChainId } from '../lib/chains'
  import { host } from '../lib/host.svelte'
  import { href, router } from '../features/navigation/router.svelte'
  import { mobileConnector } from '../lib/wallet.svelte'
  import { revealWhen } from '../features/navigation/scroll'
  import { rememberPage, returning } from '../features/navigation/visit-position'

  // A link can open the page at a named section, on the first visit only: returning restores the place being read.
  const section = untrack(() => router.route.kind === 'about' && !returning() ? router.route.section ?? null : null)
  let chains = $derived(host.status?.chains ?? [])
  const keyChain = $derived(initialChainId(chains.filter(c => host.keyringMarket(c.id)), null) ?? initialChainId(chains, null) ?? 84532)
  let curated = $derived(chains.some((c) => c.curated))
  let relayer = $derived((host.relay?.chains.length ?? 0) > 0)
  let faucet = $derived(host.relay?.chains.some((c) => c.faucet) ?? false)
  let attachments = $derived(host.status?.store?.attachments ?? null)
  let storesContent = $derived(host.status?.store != null)
</script>

<section class="about" use:rememberPage={'data-about-section'}
  use:revealWhen={{ key: section, focus: section ? `[data-about-section="${section}"]` : undefined }}>
  <img class="about-banner" src={whale} alt="the blohard whale" width="640" height="349" />
  <h2 data-about-section="what-this-is">what this is</h2>
  <p>
    blohard is a public message board built on blockchains. your wallet is your identity, and you set rules for
    replies to your posts. anyone can read, anyone can run a host like this one, and anyone can write a client, all
    against the same record on the chain. there is no company in the middle and no account to create. connecting a
    wallet is the sign-in.
  </p>
  <p>the full <a href="/design.html">protocol design</a> is published here as a page.</p>

  <h2 data-about-section="what-is-on-the-chain">what is on the chain</h2>
  <p>for every post, four things, written once and never changed.</p>
  <ul>
    <li><b>who</b> wrote it, as a wallet address</li>
    <li><b>what it answers</b>, the post it replies to, if any</li>
    <li><b>when</b>, the block time</li>
    <li><b>a fingerprint of the text</b>, a hash, so the words can be checked but never read from the chain</li>
  </ul>
  <p>
    the chain also holds each author's reply rules (see moderation, below), the mark that a post was deleted or
    removed, and authors' public blocklists. the host's curated and blocked account lists are kept off-chain.
  </p>
  <p>
    each chain a host serves carries a board of its own under the same rules. a reply always lands on the chain of
    the post it answers, and a post on one chain can quote a post on another.
  </p>

  <h2 data-about-section="what-is-not-on-the-chain">what is not on the chain</h2>
  <p>the protocol leaves these off the chain. how each is handled is up to the client you use, and this one does it as follows.</p>
  <ul>
    <li>
      <b>the words and pictures.</b> hosts store them and hand them out, and this client checks each against the
      fingerprint on the chain before showing it, so a host can lose a post or refuse to store it, but cannot alter
      it. this site also serves the app and its connection to the chain, so you trust its operator to serve the app
      and report the chain honestly, the way any app trusts its provider. a post whose text this host lacks shows as
      content not available on this host.
    </li>
    <li>
      <b>names and avatars.</b> they come from ENS and Basenames, not from the board's record. this client shows
      a name and its avatar after checking that the name resolves to the author's address. the address is the
      identity, and the name is a label.
    </li>
    <li>
      <b>who you follow and who you have muted.</b> this client keeps both in this browser, not on the chain. the
      host receives the followed addresses it needs to build your feed, and mutes never leave this browser. connecting
      the same wallet elsewhere does not restore these lists. that is a choice of this client, not a rule of the protocol.
    </li>
    <li>
      <b>quotes and mentions, as such.</b> they are written inside the text as references, so the fingerprint on the
      chain commits to them like every other word, but the chain does not know a reference from any other text.
      clients turn them into cards and links. this host indexes mentions and quotes when it receives the text,
      so a post whose text is missing will not appear in those notifications yet.
    </li>
  </ul>

  <h2 data-about-section="identity">identity</h2>
  <p>
    your address is you. with a wallet controlled by a single key, losing that key means losing access. blohard has
    no reset, and recovery depends on your wallet. smart-contract wallets can support recovery and key changes, and
    work here when presented as your connected account.
  </p>

  <h2 data-about-section="what-posting-costs">what posting costs</h2>
  <p>
    a post is a transaction, so it costs gas on the chain it lands on.
    {#if curated && relayer}
      each host chooses its own curated list. listed accounts get a badge, and their posts and replies appear in the curated feed. free posting is available to list members and, when enabled, eligible ENS or Basename owners. they sign their posts and the host's relayer pays the gas, up to a
      daily allowance.
      sponsorship covers posts and replies only, including a reply rule chosen when posting. deleting posts, removing replies, changing a rule afterwards,
      managing your blocklist, and deactivating or reactivating your account cost your own gas.
      everyone else pays their own gas.
    {:else if curated}
      this host keeps a curated list but is not sponsoring gas at the moment.
    {:else}
      this host sponsors nobody at the moment.
    {/if}
  </p>

  <p>the host may block accounts. their posts are hidden on this site, and they cannot post through it. other hosts make their own choices.</p>

  <h2 data-about-section="no-token">no token</h2>
  <p>
    there is no official blohard token, coin or nft, and none is planned. nothing here needs one. anyone offering a
    blohard token or airdrop, or asking you to connect your wallet to claim one, is running a scam.
  </p>

  <h2 data-about-section="permanence">permanence</h2>
  <p>
    the record is permanent. deleting a post marks it as retracted on the chain. this client hides the original
    content and its branch in that thread. the same applies to a reply removed by the author of the post it answered.
    a placeholder remains at its own link or where a surviving reply needs the context. the fact that it was
    posted, by whom and when, stays. deletion does not erase
    copies made elsewhere, and this host does not erase the words it stored, so anyone holding the fingerprint can
    still fetch them. write accordingly.
  </p>

  <h2 data-about-section="moderation">moderation</h2>
  <p>
    authors set rules for ordinary direct replies, enforced by the chain. clients decide how to show what is
    already there. replies appear in their thread and in notifications.
  </p>
  <p>
    if someone replies directly to your post, you can answer their live reply regardless of their rule, blocklist
    or account deactivation. every answer is protected, so they cannot remove it, even after deleting their own reply.
    quotes do not grant this right. deleted or removed posts never accept new replies.
    you can still delete your own post, hiding its branch in that thread. surviving replies remain reachable
    at their own links or through the deleted post's page.
    readers keep the last word over what they see.
  </p>
  <p>if you wrote the post, you can</p>
  <ul>
    <li>
      <b>remove an unprotected direct reply.</b> it is marked on the chain as removed by you, permanently. clients hide its words
      and it takes no new replies. replies already made beneath it stay, with conversations of their own.
    </li>
    <li>
      <b>block someone.</b> the chain refuses their ordinary new replies where your blocklist is the reply rule, and this client folds away the
      unprotected replies they already made to you regardless of your reply rule, and keeps them out of your notifications. blocking is public, and it mutes them for you here too.
    </li>
    <li>
      <b>set a rule for who may reply,</b> to one post or to all of yours. anyone, nobody, people on a list, people
      who have proven to some service that they are human, and so on. in settings, <b>who can reply</b>
      lets you choose all or key holders where available. when your blocklist has entries,
      both choices say except blocked. both rules enforce your blocklist.
      choosing an account rule opens your wallet to confirm the transaction. this setting applies on the selected chain
      to posts without their own rule.
      use <b>reply rule</b> beneath the composer or beside your own live post or reply on its thread page to choose
      account default or a rule just for that post. account default follows your setting in settings.
      an explicit rule applies to direct replies, overrides your account default until you change it, and stays in place if you deactivate your account.
      choose <b>no new replies</b> where available to close ordinary direct replies without deleting the post. choose another rule to reopen. protected answers bypass blocklist and key-based folding. other existing replies keep the usual display rules.
      post rules affect new replies only. your account-level key holder rule and blocklist can fold earlier replies on the next refresh.
      changing a published post's rule opens your wallet to confirm the transaction.
      account deactivation and reactivation are in settings, linked from the
      left navigation. deactivation is reversible, and it does not affect explicit post rules or protected answers.
      the chain enforces the rule when a reply is made, and before you sign a reply here, this client asks the
      board whether it would let you in.
    </li>
  </ul>
  <p>
    reply rules do not restrict quoting. a quote is a new post under the quoter's name, with its own conversation
    and reply rules.
    this client does not show quoted content that has been deleted or removed.
  </p>
  <p>
    as a reader you can <b>mute</b> anyone. they vanish from your timelines on this device, and they are not told.
  </p>
  <p>
    authors and readers choose what they consider acceptable. each host also chooses what it stores and displays,
    which accounts it blocks, and whose posting it pays for.
  </p>

  <h2 data-about-section="apps">apps built on blohard</h2>
  <p>
    the core protocol gives apps a shared record of posts and wallet identities to build on. anyone can add
    features through separate contracts and interfaces without changing the board.
  </p>
  <p>
    <a href={href.keysAbout(keyChain)}>account keys</a> is one example. it adds optional account markets
    and keyring feeds, with reply rules based on key ownership where enabled. you can keep using blohard without
    activating keys. follow the link to learn about activation, buying and selling, and fees.
  </p>
  <p>
    bots are welcome too. <a href="/bots.md">blohard for bots</a> explains reading and posting from a script,
    with a working example that answers its mentions.
  </p>

  <h2 data-about-section="privacy">privacy</h2>
  <p>
    everything on the chain is public, forever, and tied to your address. the host sees the usual web traffic
    of its visitors, which posts you open, the links it previews for you and, once you connect a wallet, which
    address you use. there are no private messages.
  </p>

  <h2 data-about-section="joining">joining</h2>
  <p>
    reading needs nothing. to post, connect a wallet on one of the chains this host serves, and the app offers to
    add the chain to your wallet if it lacks it. on a phone, {#if mobileConnector}choose {mobileConnector.name} here
    and approve in its app, then return to your browser, or {/if}choose Coinbase Wallet to connect with a passkey.
    {#if mobileConnector?.notice}the phone connection uses <a href={mobileConnector.notice}>licensed software</a>. {/if}a post costs gas unless you qualify for free posting, and on a test chain that gas is test ether from a faucet.
    {#if faucet}this host runs one. connect a wallet, and a button beside it offers test ether while your account has none.{/if}
    {#if curated}for free posting, use an eligible name you own if this host supports it, or ask the host to add you to its list. only listed accounts get the badge and curated feed placement.{/if}
  </p>

  <h2 data-about-section="this-host">this host</h2>
  <p>
    serves
    {#if chains.length === 0}no chains yet.{:else}
      {#each chains as c, i (c.id)}{i > 0 ? ', ' : ''}<b>{chainLabel(c)}</b>{/each}.
    {/if}
    {#if !storesContent}
      it stores no words or pictures itself and only reads the chain for this app, so posts show as content not
      available here until it is paired with a store.
    {:else}
      {#if attachments}
        it stores attachments up to {Math.round(attachments.max_bytes / 1048576)} megabytes each, {attachments.max_per_message} per post counting pictures and quotes together.
      {:else}
        it stores no pictures.
      {/if}
    {/if}
    {#if host.status?.notice}<span class="dim">{host.status.notice}</span>{/if}
  </p>
</section>

<style>
  section.about { padding-top: 1rem; }
  .about-banner { display: block; width: 100%; height: auto; border-radius: 3px; margin-bottom: 1rem; }
</style>

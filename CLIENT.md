# Client rules

What a client of the blohard protocol does beyond what the chain enforces. The
[protocol specification](https://github.com/blohard/protocol/blob/main/SPEC.md)
(SPEC below) says what records, messages and gates are; this says how a client
that follows the design treats them. It is the rulebook of this client, and
other clients are welcome to it.

The chain enforces very little on purpose. A client that follows these rules gives its users the
guarantees the design intends.

**Trust nothing you did not verify.**
- Hash every fetched record and compare before parsing. Show a mismatch as an error, never as text.
- Render body text as escaped text nodes with the bounded formatting of the spec's message text (SPEC §6), never by inserting
  supplied HTML. Links open in a new tab with `rel="noopener noreferrer"`.
- Body media must not fetch third-party resources without asking. Name-record avatars and link
  thumbnails on the reader's own posts or posts by followed authors are explicit exceptions.
  Record attachments come from content hosts and follow the image-display rules.

**Posting is transaction first.**
1. Compute the record hash locally and show it. That hash is what the wallet signs.
2. Send `post()` and start waiting for its receipt while uploading as in step 3. The `Posted` event
   carries the new id. Set the transaction's gas limit yourself, from a simulation, rather than
   accepting a wallet default: a reply gate can use more gas when the transaction is mined than it
   did in the simulation, and the limit is what caps the cost (SPEC §8). Refuse a post whose
   estimate is far beyond what a post needs.
   - A client may offer **sponsored posting** where a host runs a relayer for members of its list:
     the author signs the post (the board's EIP-712 `Post` type, with an unused bitmap nonce and a
     deadline) instead of sending a transaction, the relayer submits it as `postBySig` and returns
     the transaction hash, and from there the client proceeds exactly as with its own transaction.
     Keep the deadline short, about an hour. The signature can land at any time until then, and
     deleting the pending post from the client does not revoke it. A relayer may refuse a deadline
     it considers too far away.
     The `author` the client names is the account the user acts as — for a smart-contract wallet,
     the account's address, not the key's — and the signature bytes travel to the relayer unchanged,
     whatever their length: the board tries the author's own key first and otherwise lets an author
     with code validate them itself (ERC-1271, SPEC §4.2). The client says plainly who is
     paying and lets the author choose to pay instead.

     Before sending a sponsored request, a known pause in free posting (including an exhausted
     allowance) automatically selects wallet-paid mode for posts and replies. Keep the submit
     button usable, show the pause reason and that the author pays gas, and require the normal
     wallet confirmation. This automatic choice is not a saved preference: free posting resumes
     when available unless the author explicitly chose to pay. Unknown eligibility still waits
     for a successful check or the author's explicit choice to pay.

     After sending a sponsored request, offer a paid retry only after a definite relayer refusal;
     temporary busy responses remain retryable through the relayer. A missing or unknown outcome
     retains the exact signed request for recovery and must not offer a paid retry. A later refusal
     cannot disprove an earlier uncertain send. A relayer's refusal is never a verdict on the post,
     only on who pays.
3. Upload the body, then attachments, as soon as the wallet returns the transaction hash, with the
   chain id and that hash as proof. A host that has not yet accepted the message says it is
   **holding** the record: it serves nothing yet and stores the bytes on its own once the chain has
   confirmed the message. Keep the bytes until a host says it has stored them, since a held record
   can still be lost if the host restarts or the message never becomes accepted. Once the `Posted`
   event is in and confirmed, upload again with the message id if no host has confirmed storage. A
   successful content download verified against its hash also proves storage and can skip that
   second upload. If the upload fails the post is already on-chain, so offer a retry, never a
   re-post.
4. Treat a host that cannot check, because it is in trouble or its gateway is not ready, as "could
   not check, try again", never as a verdict on the post. A host that says the transaction or
   message is unknown within seconds of sending may be behind a lagging RPC, so retry once or twice
   before concluding. A host whose holding area is full asks you to wait for the message to be
   accepted and upload with its id. The [host
   API](https://github.com/blohard/host/blob/main/STORE_API.md#anchoring-and-publication)
   lists our host's exact answers.

**Replying respects the gate.**
- Before asking the wallet, have the gateway run the Board's `checkReply(parentId, account,
  gateData)` preview. It returns the gate admission depended on, or zero when no gate was called:
  an open target or an entitled response. No gate address is pinned in the transaction.
- If `checkReply` reverts or the answer cannot be fetched, stop and distinguish rejection from an
  unavailable RPC before the user signs. The Board uses STATICCALL for this preview. Calling the
  gate directly with `eth_call` does not enforce it. The `gateData` argument is an opaque extension
  field: a client without proofs sends empty bytes, the shipped list gates ignore it, and a gate
  that needs real data needs a client that knows how to build it. The preview is advisory: state,
  gas and transaction context may differ at inclusion. Simulate the complete transaction with its
  chosen gas limit before sending.
- A target's own `TOMBSTONE` or `REMOVED` always closes replies. Otherwise the author of its
  immediate parent may respond regardless of gates, account deactivation or blocking. Quotes,
  mentions and links confer no right. The Board applies this before the ordinary gate check.
  Every qualifying answer is protected, with no per-target quota. Protected responses cannot
  be removed by the other author, even after an ancestor is deleted, and bypass automatic
  blocklist/key folding; reader mutes and host blocks still apply. Other replies keep the normal gate and display rules.
- Blocking someone is a use of these rules, not a feature of them: the author adds the address to a
  list of theirs and, once, points their author gate at a gate that reads that list. A gate that
  resolves the list owner from the parent's author (one deployment serves everyone) is the natural
  default for a client to offer. From then on the chain refuses that account's ordinary new replies to the
  author's messages that have no per-message gate, and clients fold its earlier ones, as described
  next.

- On the reader's own profile, offer an account default selector for all except blocked
  (`AuthorBlocklistGate`) and key holders except blocked (`AuthorKeyBlocklistGate`).
  Key restriction requires activated keys and a host-verified combined gate.
  Never substitute the plain key gate or zero for a choice that promises block enforcement.
  Show an unset or custom gate as its actual current state until the user confirms a
  supported choice in their wallet. Changing the selector opens the wallet immediately;
  disable it until the transaction finishes and restore the current rule on rejection. Deactivation is reversible; per-message gates still override this default.
  When the indexed blocklist is known empty, shorten the labels to all and key holders.
  An unset gate may then display as all, and a plain key gate as key holders. If the list
  is nonempty or unread, keep the explicit distinction for gates that do not enforce blocks.
  Confirming either policy still selects its blocklist-enforcing gate. Check emptiness with one
  indexed member lookup, not by downloading the list.
- Keep account deactivation in settings, reached from the left navigation. Settings names its
  chain in the route so opening it from a profile cannot silently switch chains. Deactivation
  sets `TOMBSTONE` after confirmation; reactivation selects the shared author blocklist gate.
  A deactivated profile links to settings instead of offering the reply selector. Settings
  also links to account-key activation where the market is configured.

**Per-post reply controls.** On a new post or reply, leave the own gate unset unless
its author chooses an explicit rule. Offer account default, all except blocked, and
key holders except blocked. Omit “except blocked” when the author's list is known
empty. Show what account default currently means, including custom and deactivated
account rules. The key-holder option requires activation and a client market matching
the host's verified keyring market. Fetch this information only when the picker opens.

The author's own live posts offer the same picker. Selection sends a wallet-paid
transaction immediately and changes the displayed selection only provisionally until
its receipt confirms. A failed action restores the current rule. Deleted posts have no
rule control. Where the host publishes a verified closing gate, also offer no new
replies. It closes ordinary direct replies and can be reversed by selecting another rule.
Protected responses remain allowed and bypass automatic folding; other existing replies
keep the normal display policy. In a reply's picker, explain that the author being answered
can always respond while it stays live. Do not offer arbitrary gate addresses in this UI.
Keep deletion separate. Existing unknown gates remain labeled as custom gates.

Inside the expanded picker explain that the rule applies to new direct replies,
leaves existing reply visibility unchanged, and that an explicit rule overrides the account
default for admission until changed and survives account deactivation. A rule chosen while composing travels with the post, including a
sponsored post. Subsequent changes use the author's gas. Draft rule selections belong
to the chain, Board and account, survive navigation, and clear with the submitted draft.
Before signing a new post with an explicit rule, recheck the host's current verified
addresses and, for keys, activation on the matching market. An unavailable choice
falls back to account default with a notice; a failed check stops the send. Recovery
always preserves the original signed request. Reading picker options must not advance
the shared gate ledger. A confirmed edit updates the receipt overlay without reloading
the stream. Rule edits and deletion of the same post cannot run concurrently in one tab.

**The chain applies gates once, and clients use account-level display rules.** Except for protected
responses, the chain checks the gate in force *at the moment a reply lands* and never revisits it
(SPEC §5.2): what landed, stays. The following display rules apply to unprotected replies.
Per-post gates affect admission only and neither hide nor reveal existing replies.

- Apply the parent author's current blocklist to existing unprotected replies, regardless of
  the gate that admitted them. This includes unset, custom, unverified, and closed gates.
  The host publishes the list independently of gate validation; it is a display policy,
  not a claim about an unverified contract's behavior.
- For unblocked replies, read the parent author's current account rule, ignoring
  any per-message gate.
- Re-apply only known, proof-free account-level key gates published by the host. `AuthorKeyGate` and
  `AuthorKeyBlocklistGate` fold replies whose authors no longer hold a key; buying back
  restores visibility. These gates do not require the parent's author to hold keys.
- Fold the reply and what hangs under it behind one line with a control to show it.
  Folding never deletes on-chain history. Unset, unknown, and unsupported gates add no
  further display restrictions. Tombstone and removal sentinels retain their separate
  deletion and removal semantics.
- Do not replay arbitrary proofs from the original transaction. Adding support for another gate
  requires defining its read-side meaning explicitly.
- Keep displayed verdicts stable until explicit refresh. Paging, posting and local moderation
  actions do not recheck cards already shown. New cards check once when mounted; an explicit
  refresh waits for updated page data before rechecking. Share concurrent checks for the same gate
  and author/replier pair, using bounded keyring index lookups rather than admission simulations.
  A failed read is not a rejection. Unknown checks show the reply and retry only on
  refresh. If a page refresh fails while old rows remain visible, keep their previous
  verdicts too.

For unprotected replies, the chain checks the effective gate for admission. Historical
folding separately uses the parent author's account rule:

| account rule | client, for existing replies |
|---|---|
| a recognized key gate | apply the parent author's blocklist and key holdings check |
| unset, deactivated, or any other rule | apply the parent author's blocklist |

A thread can hold replies admitted under different rules. Gate-history labels, markers where rules
changed, human-readable gate descriptions and opt-in mirror gates are future work, not conventions
yet. There is no automatic inheritance of the parent's gate: the current reply's own pointer starts
at zero, deferring to its author.

Additional policies, such as thread-specific address lists or per-reply hiding lists, require
explicit client support. Recognition of shared author gates does not add those list types.
Neither policy would change the chain.

**Reading uses the host's accepted index.**
- Author, parent-author and parent posting lists are derived from `Posted` events. Clients ask the
  host for bounded feeds and direct-reply pages. They do not replay those events themselves. The
  host supplies current gates, counts and registry membership in the same accepted snapshot. Body
  hashes protect bytes, while the host remains trusted for chain state and query completeness.
- A timeline lists **top-level posts** (parent 0) newest first by block and log index, each with its
  count of direct replies. Where a view includes the reader's own replies, including another
  author's profile, they are shown **inline** as a pair: the post being answered and then the reply,
  at the reply's position. A post that appears as the parent of such a pair is not repeated on its
  own. Replies within a thread go oldest first, flush with the post they answer. Depth is shown by
  thread lines and by which post is focused, not by indentation, and replies can be expanded in
  place at every depth. Every stream card follows the same rule, including automatic previews
  and kept replies. Its post-number link opens its thread page. Nothing expands without the
  reader's press. Expanding keeps replies already visible in the preview, including
  nested replies and ones beyond the first page. Kept previews follow the requested replies
  with context labels until the reader opens their own parent. No intervening branches open
  automatically. Each branch loads only when opened, pages its direct replies, and
  retains its expansion choices when hidden and reopened or when returning with Back.
  In a thread, an ancestor’s “more replies” control opens its other replies in place, keeping
  the focused path mounted and omitting that path’s child from the added list.
  Automatic stream previews and the thread's main reply list can also be hidden; the reply count
  reopens them. Hiding an expanded stream list hides the preview too. Posting a reply reopens
  that post's list to reveal it.
- The everyone and following views also show every **direct reply to the reader's own
  messages**, by anyone, paired under the message it answers: those are exactly the replies the
  reader moderates, except for protected responses. A reader's own reply to such a reply chains beneath it, so a
  conversation that hangs from the reader's post is one block with the post at its head. A
  shown reply carries its immediate parent as context, whoever wrote that parent.
  Following, Keyring and Curated group through selected records only. An unselected parent supplies
  context for its selected replies, without bridging to or promoting an older selected ancestor.
  Several selected replies to one post form one group, so a busy post does not repeat itself
  down the feed. Curated selects the host's listed authors' posts and replies, plus the reader's
  own replies to listed authors. If the reader is listed, it also selects direct replies from
  anyone to the reader's own messages. That exception is personal to the reader. It does not
  include an unlisted reader's other posts or replies merely because they are their own.
  Keyring feeds select only posts and replies by the accounts whose
  keys the reader holds, or by the reader's key holders. Other authors can appear as thread
  context. Replies excluded by these rules remain available in notifications and their threads.
- Home feeds exclude authors on the reader's indexed blocklist on that chain before paging,
  even without a local mute. A membership change reloads the feed on its next refresh.
  Profiles deliberately opened and parent records needed as reply context remain available.
- A client may keep a **muted list**: authors whose posts are left out of the reader's timelines and
  collapsed to one line inside threads, where the reader can still open them. A profile the reader
  opens on purpose still shows them. Like following, this is the reader's business and stays local
  unless the reader chooses otherwise. It hides, it does not delete, and it says nothing to anyone
  else.
- A reply is never shown on its own: wherever a reply appears outside its thread, it carries the
  message it answers above it, at least the author, id, and first line, linking to the thread.
- Timestamps come from the accepted chain record, not from the client's clock.
- Reply counts come with the host's records. They count live direct replies only, excluding
  deleted and removed ones. Neither deleted nor removed children promote their
  descendants into the list or count. A thread displays twenty direct replies oldest first and
  offers the next page. An unavailable count is unknown, never zero.
- A first feed read consumes bounded pages until enough visible rows are available or its work
  budget is reached. An empty page with a continuation cursor is incomplete. Refreshes use changes
  since the last completed look, including late content-derived references. Failed requests advance
  nothing. All pages of a refresh share its captured upper boundary.
- Loaded pages may contain more posts than a screen needs after grouping. Display twenty
  conversation groups initially, revealing twenty more on request from the cache before fetching
  older history. A refresh retains every still-selected displayed row: additions above make room for
  themselves, while deletion or filtering can remove rows. Back and Forward restore the stream's
  shown rows and reading position. Sidebar links keep the shown rows but open at the top. Both
  keep the displayed snapshot and cue new content with the refresh button. Pressing the selected
  sidebar link also scrolls to the top without refreshing. A browser reload starts at twenty again. A long
  conversation previews its newest three selected replies across every branch, oldest first,
  except in Curated, which shows every selected reply already loaded, in depth-first order
  with siblings oldest first. Missing parents group their visible children without extra reads.
  All Home streams show immediate parents as context without opening their other replies,
  including parents by unfollowed authors while signed out. Explicit collapse still applies.
  These context cards do not consume preview slots or recursively add ancestors. A selected
  root stays visible too; a context-only root disappears when its selected replies fold away,
  unless the reader has explicitly opened it.
  Missing or separated parents appear as "in reply to #id" links. Consecutive siblings share
  one label; changing branches names the parent again. Context links have no reply controls.
  Dashed lines join only adjacent parent and reply cards; each count reaches the direct
  replies not drawn. A profile's
  replies tab keeps the author's reply followed by up to two newest answers from the reader.
  A preview offers "hide replies" and "more replies" only when it starts directly below
  its parent. Otherwise the full reply count opens the list there; existing preview
  copies move into that list once it is ready. Counts travel with indexed records.
  Missing context counts may arrive after the rows.
- A feed never changes on its own. A client may poll quietly and show how many posts a refresh would
  add. Nothing moves until the reader asks.
- Long bodies in streams, reply lists and thread ancestors have a height-limited preview, including
  their attachments. "Read full post" opens the addressed post's thread, where its body is shown in
  full. Back restores the stream. Controls entirely past the cut must not remain keyboard targets,
  and a control with any visible part keeps working. Ours uses twelve lines' height and remeasures
  after layout changes. A "show picture" press lifts the containing previews while that picture
  stays open, revealing any extra text too. Hiding it restores the cap unless another opened picture
  remains. Pictures loaded automatically do not lift the cap.
- Notifications interleave replies, mentions and quotes newest first, with each source message shown
  once. They exclude authors on the reader's blocklist from the source chain's configured blocking
  registry, regardless of which reply gate the reader currently uses. The host filters query results
  before paging. It retains the shared reference associations. On refresh, a blocklist change
  reloads that notification view. Unblocking may therefore take until the next refresh to restore
  older notifications. Local mutes and the reader's own posts are filtered by the client.
- Mentions and quotes come from the host's references index. A late body can create an association
  for an old post. It arrives through the change stream rather than requiring a browser body scan.
  Reference extraction considers the first eight mention/post-reference occurrences in text order,
  including repetitions and invalid occurrences, before deduplication. This is a reading convention
  for hosts and clients, not a Board restriction. It is separate from the attachment cap (SPEC §7).

Only accepted-depth records are indexed. A gateway assumes accepted history is stable. If it finds a
contradiction it stops serving its index and rebuilds, and a client whose snapshot or cursor the
gateway no longer recognizes starts over, telling the reader rather than reloading silently. Pinned
quotes cannot silently resolve to a different record. Our [host
API](https://github.com/blohard/host/blob/main/GATEWAY_API.md#accepted-snapshots-and-cursors)
defines its boundaries.

**Deletion, removal and deactivation.**
- A message whose per-message gate is `TOMBSTONE` was **deleted** by its author. One whose gate is
  `REMOVED` was **removed** by the author of the post it replied to. The two labels must not be
  confused, since the chain records which of the two people acted. Neither gate is ever lifted, so a
  client may remember either for the rest of the session, subject to the reorg limitations above.
- Neither is ever a standalone item: not in feeds, profiles, notifications or quote cards. They
  appear only at their own direct address or as necessary context above a surviving reply
  that a view is showing. Filter before grouping inlined replies, so neither takes a slot in a group
  nor lifts it.
- Deleted and removed replies disappear from their parent's list and count together with their
  whole branch, including if it was open when deletion was applied. Descendants are not promoted
  into the parent's list. Context placeholders show no original content, reply count or expansion
  control.
- Surviving replies still surface on their own where a feed selects them, a followed author's reply
  or a reply to the reader's own post, with the necessary ancestor placeholders as context. This
  neither reopens a hidden branch nor surfaces its siblings.
- A direct link to a deleted or removed message shows its placeholder and its surviving direct
  replies, with list controls outside the placeholder. Deletion and removal hide a branch from
  the parent's discussion; neither erases its descendants. An
  embedded discussion under a deleted or removed post says so in one line and closes replies.
- Offer remove on unprotected direct replies to the reader's own posts, with the same
  irreversible-action confirmation as delete.
- A message whose effective gate resolves to `TOMBSTONE` through the author gate belongs to a
  deactivated account. Show that, and close replies except for the entitled author.
- Deleting is permanent. The confirmation must say so.

**Chains and hosts.**
- Each chain is its own namespace. Show which chain a message is on and never merge ids across
  chains.
- Take the list of chains, contract addresses, deployment blocks, and browser-safe RPC URLs from the
  host, and offer to add a chain to the wallet from those. A published URL may be a path on the
  host, which the client resolves against the host's origin.
- A client may know several hosts, and learns more from the `peers` a host publishes in its status.
  When fetching a record, name the message that anchors it (the host API says how): a host that
  lacks the bytes may then fetch them from a peer, check them as it would an upload, and serve them.
  One host not having the bytes does not mean they do not exist, so try the next. A record uploaded
  moments ago may be held rather than stored (posting, above), so a very recent message can be
  missing until the chain has confirmed it.
- A host may publish **curated and blocked lists**, local to the host and shared across its
  chains. Curation gives a badge, a Curated feed and sponsorship eligibility. The configured admin
  edits the lists with a wallet signature, without a transaction. A host block overrides curation
  and name sponsorship: its client hides that author's posts (including quotes) and shows
  "posting blocked by host" in their composers. Other wallet actions, including deleting their
  posts, key trades and fee claims, remain available; their own post's page keeps a delete control
  without displaying its content. The admin can still edit the policy if they block themselves.
  The host refuses new uploads and sponsorship for blocked authors. Public reads remain available,
  including immutable bytes already stored; blocking is host policy, not deletion from the chain.
  Personal blocklists and reply gates remain on-chain and independent.
  See [Host policy](design/HOST_POLICY.md).
- A host may also show **bots**. An account can say it is one with a signed, gas-free statement,
  and the admin can label one that does not. The client shows a robot after the name, bright for
  the account's own statement and muted for the admin's label. A label changes nothing else:
  feeds, curation, sponsorship and reply rules treat bots like any account. Labels are the host's
  records, off chain. See [Bot labels](design/BOT_LABELS.md).
- A gateway supplies indexed records, pages, membership and changes under the [host
  API](https://github.com/blohard/host/blob/main/GATEWAY_API.md). The client recomputes immutable
  commitments and body hashes, but relies
  on its chosen gateway for chain history and completeness. Core posting uses wallet RPC for
  signing/submission. The optional account-key app also prefers wallet reads on its own chain, with
  a narrow unsupported-read fallback described in [Account keys](design/ACCOUNT_KEYS.md). A direct
  node comparison can diagnose a bad answer. It does not prove that a feed contains every matching
  post.
- Records are immutable: cache them by hash for as long as you like.

**Following is the reader's business, not the chain's.** The chain has no notion of followers. A
feed is whatever a reader chooses to look at, and the host index supports it as a bounded union of
author and parent-author filters. Nothing needs to be written anywhere for someone to follow
someone. A follow list is therefore a client-side object, and it can live in three places, in
increasing order of publicity:
- **On the device**, the default. Private, free, and instantly editable. Its cost is that it does
  not travel to a second device by itself.
- **As a published record.** A client may let the reader post their follow list as a record of its
  own media type, which makes it hash-committed and available on any device that can find the post.
  This makes the list public, and that is a deliberate act the client must ask for, never a default.
- **On-chain, as a list** in a list registry (SPEC §5.3). This is the only form other contracts
  can read, and it is what makes rules like "only people I follow may reply" possible as a gate. It
  is the most public and the only one that costs gas. A client may also read an existing on-chain
  follow graph as a source of follows and mutes.
A standard client keeps follow lists local unless the reader chooses otherwise, never infers follows
from behaviour, and treats a list published by someone else as an input to what it shows, not as a
fact about who its user is. Its following view is the union of the followed authors' posts and
replies, newest first, each reply paired with what it answers. Follower *counts* are not a protocol
concept and a client should not present them as if they were verified.

**Identity.** The address is the identity. Show it shortened but copyable, and never take an
author's identity from the content of a message.

A client may show a **readable name** next to the address when a name service provides one, under
these rules:

- Show a name only when both directions agree: the address's primary (reverse) name, resolved
  forward, must come back to the same address. A reverse record alone proves nothing, since anyone
  can point theirs at any name.
- Prefer the Ethereum Name Service primary name. Fall back to a name service on the chain the board
  runs on, such as Basenames on Base. When a verified name is shown it stands in for the address,
  but the address must stay one step away: on hover, and in full on the profile page, so a lookalike
  name can always be checked.
- A name is a display hint, never an identity: gates, mute lists, and links use addresses.
- Names change, so cache them for hours, not forever. Cache a "no name" answer too, more briefly. A
  gateway may perform these checks and return the verified name, so a browser need not resolve names
  itself.
- An **avatar** from the name's records may be fetched and shown without asking, because the owner
  chose it for exactly that purpose. Link thumbnails have the separate consent rules for references (SPEC §7). A
  client keeps a local copy so it happens once per device, and falls back to a deterministic picture
  derived from the address.

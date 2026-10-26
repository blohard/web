# Client state and ownership

For file locations and common changes, start with the [frontend guide](README.md).

Keep these lifetimes separate. A URL, a visit to that URL, a draft, and a
publication are different identities. Navigation must not transfer an active
publication to the new page or replay its focus/reveal commands.

| State | Owner and key | Lifetime |
|---|---|---|
| Route and history entry | `router.svelte.ts`, `Visits`; one ID per history entry | Browser Back/Forward revisits the entry. The page arrow copies its previous page into a new entry, including its bookmark, so browser Back undoes the arrow; repeated arrows follow the original page trail. Sidebar links copy the latest retained visit to that page into a new history entry. Profile and keyring tab links replace the current history entry and share its visit; Back leaves the page and Forward returns to its last selected tab. Other links make a new visit. The tab retains at most 100 visits. |
| Open thread branches, ancestors and shown reply pages | The thread's visit | Restored on Back/Forward; a fresh visit starts at its requested post. Opening a thread whose position the host no longer serves reads it into a new session, which replaces the old one only when its first read succeeds. |
| Stream pages, cursors, records and counts | `feed.ts`; deployment and filter | Shared in tab memory; a first visit loads current rows, initially twenty. Returning to a bookmarked stream reuses its snapshot and shown limit without advancing its cursor, including its open reply branches. The quiet refresh cue survives navigation. Reload clears it. A refresh whose position the host no longer serves (a rebuilt index, expired history, or more changes than one refresh may page through) reads the view afresh once and replaces it only when that succeeds; a failure keeps the page shown. Loading older rows never jumps to the latest, and a quiet poll only cues the refresh. Streams check once when they open, after any load or resume in progress finishes. While visible, they also check every thirty seconds and immediately when the tab becomes visible again or its window regains focus; hidden streams skip these repeat checks. A return during an outstanding check schedules one fresh check as soon as it settles; paired focus and visibility events share that check. |
| Reading position and displayed stream limit | `visit-position.ts` for every long page and stream: the visit, then stream identity | Back/Forward restore that entry's bookmark; sidebar returns keep the displayed limits but start at the top, without changing earlier entries. Ordinary links also start at the top. Switching the keyring balances tabs leaves the current viewport alone, without restoring a pane bookmark or scrolling to the top. Pressing the already-selected sidebar link scrolls to the top without refreshing. Short pages (settings, activation, a key market) keep none. Restoration follows the bookmarked row until the reader scrolls or the bounded restore ends. |
| Conversations opened in place under any stream card, and their paging and nested choices | `stream-expansion.ts`; stream identity, keyed by row | Tab memory until explicit Refresh or a sidebar Home press, which clears open and hidden branches, nested paging choices and retained previews for that stream. Resetting an already-default stream keeps its mounted cards. Other navigation, polling and local reloads preserve them. Expanding replies leaves the viewport in place. Reply controls briefly reset the browser's scroll anchor through the next paint, preventing a remembered bottom position from moving the page on reopen. Normal anchoring then resumes for late content above the reader; explicit reveals and Back restoration remain owned by navigation. The refresh cue covers them in the stream's one poll. Qualifying replies beneath explicitly collapsed previews do not cue refresh when the loaded context shows they would stay hidden. Replies already loaded in a fully shown open branch do not cue refresh again through the feed. Home ignores count-only changes. Profile streams also cue changed reply counts on displayed cards, including context, since replies by other authors need not match the profile filter. Counts stay unchanged until refresh; a reply by the connected account can change them too. Posts by the connected account do not count as new posts in the cue; notification discovery remains independent. Own posts and replies remain eligible for display, including on explicit refresh. Covered by `stream-expansion.test.mjs`. |
| Notifications dot | `features/notifications/notification-dot.svelte.ts`; account | The newest activity time the notifications page showed is kept in this browser. Activity heard since lights the dot: one check per account per app load, then Home and Thread share their existing polls. A notification checkpoint never rewinds the view's poll. When the view jumps ahead of discovery, a notifications head check covers the gap without delaying the feed cue. New candidates use that same filtered check, excluding blocks and paging past muted rows within the page's eight-page budget. Failed checks retry on the next shared poll. Threads with no fully loaded visible branch make no request for the dot alone. Only a current displayed result from all sources acknowledges activity, up to its newest item or what was heard when its load began. Other tabs merge seen progress. An additional indexed check covers every chain and key market every two minutes, including while hidden, and immediately on return to a visible tab. Background timers are best-effort and may be throttled by the browser. Checks update only the dot, never displayed content. |
| Explicit Home press | A scroll request consumed by the stream | Resumes Home and resets the active stream's reply choices to its default previews, scrolling to the top without fetching newer posts. Back/Forward clear the request; tab remounts do not repeat a consumed scroll. Covered by `stream-position.test.mjs`. |
| Selected reply card | `replying.svelte.ts`; canonical page | Tab memory, up to 100 pages: which card's box is open, one per page. A new visit to the same page finds the box where it was. |
| Reply draft | `replying.svelte.ts`; chain and the post it answers | Tab memory, up to 100 posts, shared by every page's box for that post, so a reply begun in a stream is the same draft on the post's thread, which opens its box for it. Only its owning send version can clear it; a send or a close clears it and closes every box open on that post. Moving a page's box to another card keeps the draft it left. |
| Home tabs and keyring membership | The Home visit, scoped by chain; membership also by wallet and market | Sidebar returns copy the selected tab and keyring side, and reuse displayed membership. Polls cue membership changes; only first load and explicit refresh adopt them. |
| Home draft and quotes | `draft.svelte.ts`; one `DraftBox` | Tab memory across navigation. The draft reply rule is scoped to chain, Board and account and clears with the submitted draft. Quote presses are events, delivered once. |
| Immutable message records and interpreted bodies | `messages.ts` by deployment/id; content cache by hash | Tab memory. Missing bodies are retryable, not permanent cache entries: a card asks once more four seconds after a miss, past the host's promotion of a new post's held body, and a missing or failed body offers try again. A rebuilt index (new generation) drops the chain's records; records of the replaced history are never served again. |
| Picture downloads | `picture-slots.ts`, `record-images.ts`; the page, then the rendered body | Pictures that open on their own share four downloads at once, first come first served; one the reader presses, or presses while it waits, starts at once. A body that leaves the page stops its pictures, waiting or downloading. A re-render of the same body stops nothing. |
| Post rule edits and deletion | `message-actions.svelte.ts`; Board and post | One in-flight action shared across mounted copies. Receipt updates the gate ledger without a page reload. A change whose receipt never came keeps its hash in browser storage (`tracked-changes.svelte.ts`): no other change to the post is sent until a check finds it landed or reverted, or the reader clears it. A card shown with one outstanding checks once on its own. |
| Account writes: author gate, deactivation, block and unblock, list edits | `account-actions.svelte.ts`; deployment and account | One at a time per account, kept the same way: while one may still land, Settings, the profile's block control and the list editor hold their changes and offer check and clear. Blocking may send the list and then the gate; the latest hash is the one kept. A block whose list write landed without its gate (the second step never ran) shows on the profile as not enforced yet, with enforce my blocklist; a check never sends it. |
| Reply folds | `reply-fold.svelte.ts`; mounted reply and explicit refresh | Uses the parent author's blocklist and account-level key rule, never the per-post gate. Keeps the verdict through paging, local writes and failed page refreshes. `features/messages/gating.svelte.ts` shares only unfinished indexed reads; it does not cache settled verdicts. |
| Mutable gates | `gates.svelte.ts`; deployment and message/author | Tab memory, indexed snapshots followed by sequenced changes; receipt overlays last until the index covers their block. Reads only fill in gates not yet known, so a quote, a page of older posts or more replies never changes a card already shown; a known gate moves by the changes a refresh follows, or by this tab's receipt, which a covering read confirms. Navigation never resets the shared cursor. A position the host refuses, or a catch-up past the refresh budget, forgets known gates (any may have changed in the skipped stretch), keeps receipts, and restarts from a head snapshot, retried by the next refresh until one succeeds. Only that head read may move the ledger to a rebuilt index's new generation; any other answer from another generation is refused, however late or early it arrives. |
| Notifications | `notifications.ts`; chain, Board and reader | Bounded host pages plus sequenced late associations. Personal mutes are applied locally. |
| Active publication | `publications.svelte.ts`; the publication key | One flight shared by composer and pending list; navigation detaches UI but leaves work and unsaved bytes alive. Finished operations release their bytes. |
| Unstored post bytes and signed post request | `pending.ts`; random publication key | IndexedDB until stored, explicitly discarded, or eligible unsigned cleanup. Identical bodies can be separate publications. Progress and record metadata sit in `pending`, each record's bytes apart in `pendingBytes` [key, hash], written once and deleted with the host's confirmation, so a progress save rewrites no bytes. A post saved before the split keeps its bytes inline until it finishes. |
| Following and muting | `AddressList`; named browser-storage key | Across reloads and tabs; toggles merge with stored state and storage events refresh other tabs. |

`Resource` owns a mounted view's asynchronous result, not any of the underlying
stores. A stale completion cannot overwrite the result for another key. Effects
subscribe to requests/events; they do not copy and reset the state they observe.
The pending-upload list uses the same rule: `Resource` owns its displayed list,
while each publication owns its retries and remains alive after the list unmounts.

`SerialQueue` orders feed looks, reference reads, thread-root reads and reads of
each reply branch. Each operation gets its own result, and a failure does not
prevent the next queued operation. Feed looks return rows immediately but hold
the queue through `countsReady` before starting the next look.

`sharedRead` shares only outstanding requests with the same key. Each reader
owns its keys and caches; success and failure both release the flight. It does
not queue unrelated work or remember completed results.

Name lookups share up to 512 outstanding addresses and use two HTTP lanes.
Retry waits hold their address's flight, not a lane. A visitor's 429 pauses all
name requests; a 503 leaves other names free to hit the host cache. A full queue
reports a retryable failure to sponsorship; it never establishes that a name is absent.

Full pages discover installed browser wallets with EIP-6963 and offer each by
name. Selection uses that exact provider, not whichever wallet last overwrote
`window.ethereum`. An unannounced browser provider remains available as a fallback.
Announcements are deduplicated and bounded to 32 providers; names are bounded
plain text, and wallet icons are neither fetched nor rendered. The selected
browser wallet's reverse-domain identifier is saved as a preference, never proof
of identity. Reload waits up to three seconds for that wallet; a missing or
ambiguous match requires an explicit choice instead of adopting another wallet.
Late announcements cannot replace an explicit choice or undo a disconnect.
Full pages also offer Coinbase Wallet's hosted passkey flow and, on a phone, the
wallet app connector the host serves (`mobile-wallet.ts`). Connection errors
distinguish account access from the subsequent network check and retain the
provider error as their cause. Account events during
connect do not show a connected account before both steps succeed. SDKs load on
an explicit choice, or silently to restore that chosen wallet. They own transport and session storage; `wallet.svelte.ts`
owns the selected provider, displayed account, prompt limits and local disconnect.
A stored choice is never an account or authorization. A saved remote choice takes
precedence over an injected provider; events from unselected providers are ignored.
An empty account list (wallet lock or revoked access) keeps the last verified
account for browsing in the open tab. It grants no signing permission: each
wallet action rechecks access, requests it only on that action if missing, and
stops if a different account is selected. Signing checks live access again.
The browsing address is not persisted across reloads. Explicit disconnect clears
it, closes the chosen SDK session and prevents silent restoration.
Initialization stays shared after a timeout, but late results cannot select a wallet.
SDK analytics are disabled, and RPC configuration uses only public URLs.

Silent wallet checks share one flight per provider. The caller's wait is bounded,
but the flight stays owned until all provider reads finish: EIP-1193 cannot cancel
those reads. Later focus events reuse that wait, even after timeout. Wallet events
and explicit prompts remain independent; generation checks reject stale answers.

Cached `MessageRecord` values contain immutable fields only. `RecordImage`
adds the mutable gates and count from a particular host snapshot. Cached reads
and ancestor walks return the former; fresh page reads return the latter.

Page readers check their own ordering and filters before accepting records through
`messages.ts`. Acceptance checks the entire batch against the index generation,
checkpoint and cached commitments before updating gates or the record cache.
An overtaken point read retries; a page rejects the stale answer and keeps its
cursor for the next attempt.

Deleted and removed replies leave direct lists and counts with their branches,
without promoting descendants. Opening either post's own page still shows its
placeholder and surviving direct replies. Feeds and references exclude both on
first load and refresh, retaining ancestors only where a normally selected reply
needs them. An ended ancestor drawn in a pair is not subtracted from its parent's
count. Context placeholders have no reply count or expansion control. These rules are
covered by the replies, feed, paging and notification tests.

Every newly mounted reply list waits for its cards to settle their first reads before
showing them together, including thread replies, nested branches and the widget.
The wait ends at most two seconds after the reply page arrives. Ready cards then
show while unfinished cards keep their own loading and folding checks; a slow
body or verdict cannot hold up the whole list. Collapsing cancels this deadline.
When expanding a stream row, a preview already on screen remains until then.
Standalone "in reply to" labels only link to the parent thread and have no reply
controls. Reply controls belong to post cards.
Every reply count expands in place, including preview cards; a post-number link
opens its thread page. Opening reads only the requested direct-reply page. Existing
preview cards whose parents are not open stay below that page with their usual
context labels. A kept preview joins its parent without the label when the parent
is the last card in the loaded list, shows its full card, and nothing comes between
them. This changes no post order. Kept previews move into their own parent's list
only when that list is visible, using the
existing tail mechanism for replies beyond its first page. No ancestor walk or
automatic branch expansion is needed. `RowExpansion` owns retained cards and
whether each parent's list has taken them over. Components derive the remaining
preview from that state and report when a list is visible; paging saves contain
only paging and expansion choices. Back preserves retained cards, while explicit
collapse dismisses them, including pins past the first page. Explicit Refresh or sidebar Home clears
the retained cards and rebuilds previews using the normal feed rules. Deleted or removed
kept cards disappear; surviving descendants keep their parent context links.
Preview cards and loaded copies share their row's expansion choice and each open
post's reply session. Moving between them preserves paging and open branches,
without fetching that page again. A handoff can briefly mount both copies, so the
refresh cue unregisters the list only when its last copy leaves.
The expanded list mounts out of layout meanwhile, using the same display-readiness
reports as the first screen.
A failed list read keeps any existing preview and shows a retry control; collapsing cancels
the handoff. Once shown, the branch keeps its usual refresh and paging behaviour.

## Card actions

`MessageCard` owns content, folding, navigation and the reply-count control.
`CardActions` owns the action footer, quoting, author controls and their
progress and errors. It stays mounted for the card's lifetime and lends the
footer as a snippet, so folding the card does not reset an action's status.
The card supplies the reply-count control, also used on collapsed cards.
`InlineReply` and its page still own the composer and where a posted reply lands.
Wallet checks, saved transaction hashes and duplicate-send protection remain
in `moderation.ts`, `post-reply-rule.ts` and `message-actions.svelte.ts`.

## Refresh signals

`refreshRevision` advances when the reader presses refresh. `reloadRevision`
also advances after local actions or retries. Home's `actionReloadRevision`
reloads after a publication. Feed's `inPlaceReloadRevision` reloads after a
delete or retry. Neither scrolls. A successful explicit stream refresh returns
to the top, even if it only updates replies in an existing conversation or adds
nothing. Replies just posted stay in their list, even beyond the loaded page,
without centering or taking focus. `message-selection.svelte.ts` marks
the latest submission with the card's existing tint. The marker belongs to
the visit, is scoped to the chain and Board, and is replaced by the next
submission. Back restores it; a fresh page starts without one.
`reloadKey` identifies the load passed to cards; streams and reply lists keep
it unchanged when paging.
`gateRefreshReady` is the promise for the initial or explicitly refreshed page.
Reply verdicts wait for it to succeed, so local reloads, paging and failed
refreshes keep the verdicts already shown.

`loadFeed` reads current changes. Its `preserveVisibleRows` option defaults to
true: newer rows extend the limit rather than pushing an existing row out of
view. A first visit passes false. `resumeFeed` reuses the retained snapshot and
the visit's saved limit; `olderFeed` extends the displayed range. These choices
are independent of the refresh cue, which only reports waiting changes.
A resumed snapshot restores its pending cue; a fresh load starts with no cue.

## Feed selection

`feed-policy.ts` owns the filter types, host queries and candidate selection.
It is pure: `selectPost` returns selected, excluded or
waiting-for-parent. Only profile answers need a selected parent from a later
page. `viewer` always identifies the reader; Following explicitly includes
replies to that viewer, while Keyring selects only its supplied authors.
The profile Replies tab keeps up to five ancestors above each reply, including
older context and deleted or removed placeholders needed by that reply. Ancestors
do not consume reply-preview slots or get age-folded. The oldest shown ancestor
links to its parent when the bounded chain stops short. Home streams retain their
existing context and folding rules. Overlapping profile reply paths share one
conversation, with each loaded card shown once in branch order. Conversations are
ranked by their newest profile reply; context and the reader’s answers do not
promote them. Grouping uses only the already-selected cards and reads no extra
ancestors.

Every Home stream shows a displayed reply's immediate parent as context, regardless
of whom the reader follows or whether a wallet is connected. Context does not
select that parent's other replies or recursively add its ancestors. Following
and Keyring group through selected records only; an unselected parent is the
context root of a separate group, so its replies cannot promote a distant selected
ancestor. Directly connected conversations still rank by their newest selected reply.
On load or refresh, all Home streams preview only replies newer than the
next conversation's newest activity, keeping their immediate parent context.
The last conversation has no age cutoff. Following, Keyring and Everyone retain their
three-reply limit; Curated has no fixed reply limit.
Replies posted after the previous completed stream load's checkpoint bypass both
limits on explicit Refresh. Background polls never advance this baseline. Local
reloads after posting, deleting or muting preserve existing previews and the
new-reply exemption, as do paging and Back. Only the next completed explicit
Refresh may fold them again. Older replies fetched while paging do not become
new merely because they were not loaded before.
A first load, or a different index generation, uses the normal preview rules.
Explicitly opened cards and their branches survive automatic cutoffs and limits
until explicit Refresh clears those choices. Fresh replies and their required
parent context still follow the normal preview rules. Deleted or removed context
cards are not kept merely because their branches were open.
Paging and Back retain existing cutoffs, so reading farther never folds earlier cards.
A context-only root disappears when automatic folding removes the replies that
needed it. Independently selected posts remain, and surviving replies retain
their immediate parent context or parent link. Explicitly opened roots remain.
This is a preview rule, not a claim that older replies have been read.

`feed.ts` owns reads, retained records, cursors and recovery. It supplies known
parents to the policy and retries waiting candidates when those parents arrive.
Current mutes and endings determine eligibility. `feed-selection.ts` groups
those eligible records and their loaded context without changing eligibility;
`conversation.ts` prepares the previews, context cards, labels and connectors. Curated
membership comes from the host on page reads; quiet polls and local-publication
merges share the existing eligibility check. Posts and replies qualify when their
author is curated; the reader's own replies also qualify when the parent author is curated.
Direct replies to the reader qualify when the reader is curated, without selecting
unlisted authors' replies to anyone else. Curated selects every qualifying reply already loaded, without the three-reply
preview limit used by other streams. Older automatic previews fold at the cutoff
described above; those replies remain available through the reply count.
Immediate parents supply context without selecting their other replies. Paging
and explicit hide-replies choices still apply. Curated orders loaded branches
depth first, with siblings oldest first, so each visible subtree stays together.
Missing parents keep their context links; ordering never fetches or expands a branch.
Across streams, a preview offers "hide replies" and discounts the reply count only
when its first reply is directly beneath the parent. Distant previews leave a plain
full reply count, which opens the parent's list and adopts those cards once ready.
`feed-policy.test.mjs` checks these product rules separately from paging and
recovery; the feed and paging suites cover their integration.

A top-level post submitted from Curated by a nonmember opens its thread after
confirmation, so the author can see it; Back returns to Curated. The completion
checks that the submitting view is still current, so changing tabs, wallets or
pages cancels that navigation. Curation is checked synchronously against the
current host policy. Curated authors and other streams keep their normal post
reload. Inline replies and background recovery are unchanged.

## Initial stream display

On a fresh stream or notifications load, cards mount and make their normal reads inside an invisible,
inert container, with a centred spinner during the wait (respecting reduced motion).
Streams and notifications show the spinner only after 300 ms from opening the
view. One delay covers the page read and card preparation. The profile keys tab
shares its delay across loading the code and reading the account, and the home
keyring tab across reading the keyring and its stream. A stream row's reply count
keeps one delay from reading the thread through its first list preparing. `loadingDelay`
also serves reply and paging indicators; changing or leaving an operation cancels
its timer, and returning to the same view starts a fresh delay. These page spinners
remain overlays, so appearing cannot move content.
Each conversation reports its parent lookup, any open branch's first page, and displayed cards:
body, parent excerpt and first reply verdict must settle, with failures counting as settled and
collapsed cards needing no body. After the DOM update, the stream reveals once a
consecutive settled prefix reaches half a viewport beyond the screen, all rows
settle, or two seconds pass from the feed page arriving. The reveal observes existing
reads; it owns no content, verdict cache or extra requests. Automatically opened
record pictures also wait for decoding or failure within that same budget, so their
natural proportions and clipping controls settle before reveal. Names and link
thumbnails do not hold it up; existing consent and folding rules still apply.

Back and tab returns use the same bounded wait while restoring their saved
position, so reply checks finish before the stream appears. Refresh retains
the visible stream. Paging leaves the existing rows and control in place and shows
its spinner after 300 ms. New rows mount once in zero-height, invisible, inert
wrappers; their child cards retain measurable dimensions. The same first-screen
check adds those heights in reading order, then reveals the new rows together,
with the same two-second budget. A retired load cannot delay its replacement.
The timeout uses no animation frame or resize observer; background browser
throttling can still delay timers. Slow reads or image decoding can finish after
the bounded wait; later name, quote and clipping updates can still change layout.

## Recent body and keyring reads

Bodies and keyring reads each retain up to 512 completed answers, least recently
used first. Bodies expire five minutes after their read starts; keyrings expire
after one minute. Insertion also discards expired answers. Eviction affects
future reads only: mounted views retain their answers and never refetch just
because an entry was evicted. These are entry bounds, not byte or concurrency
limits; in-flight reads are shared separately and are not evicted.

A failed read is not cached. Missing, taken-down and mismatched bodies are not
cached either. Explicit keyring refreshes replace the shared read, and invalidation
forgets it; a superseded completion cannot overwrite or remove the newer answer.

## Avatar ownership

`lib/avatars.ts` shares downloads and caches blobs by account and source URL.
Each answer carries its timestamp: pictures are fresh for seven days from
fetching (a disk hit does not restart that clock), failures and refusals for
one hour. Fresh reads move an entry to the end of the cache; insertions drop
expired entries, then the least recently read until at most 256 answers and
32 MiB of blob bytes remain. IndexedDB keeps the existing seven-day cache,
pruned on its first use in a page. Memory eviction leaves those disk copies.

Each mounted `Avatar` owns its object URL and revokes it when its account or
source changes, or when it unmounts. Late results for an old identity create
no URL. A name-only update keeps the same image. Eviction affects subsequent
cache reads, not mounted pictures, and does not trigger their refetch. The
memory-cache bounds exclude images retained by mounted components and downloads
still in flight; they are not a bound on the browser's total image memory.
Mounted pictures do not refresh on a timer. A CORS fetch failure still permits
the original image URL; refused content still shows an identicon. A component
mounting after a failure expires waits for the refetch before using the fallback;
images already mounted are unaffected.

## Account-key reads

Display reads try the connected wallet on the selected chain first. The wallet
network check must succeed before either provider can supply the read. A failed
read may make one attempt through the configured public RPC, preserving its
arguments and block number. Identical outstanding reads share that attempt;
there is no retry loop or balance cache. A wallet timeout is ten seconds, the
network recheck before fallback is bounded to ten seconds, and the public
request has its own ten-second deadline. A late wallet answer cannot start
another fallback. Rejection, disconnection, wallet changes and contract revert
evidence stop the read instead. Both failures leave an error with a try-again
control on the account-key page.

Transaction preflight uses a separate client. Only the existing unsupported-read
fallback applies there; a generic failure never moves a payment check or
simulation to another provider. Signing and sending stay with the wallet.

## Transaction progress

Before activation with an initial purchase, buying, or transferring keys, the
client reads the payer's current ETH balance and checks it covers the full
transaction value from the reviewed quote. A failed balance
read stops submission. This check does not reserve gas or run for gas-only
actions, because the wallet may sponsor the network fee. The balance is read
again on every attempt; the wallet and chain still make the final decision.

Wallet approval, a submitted transaction, and confirmed state loading are separate
presentation stages. Key pages keep their previous balances while reporting
"transaction confirmed. updating balances…", then replace them with reads from
the receipt's block or a newer block already read for that account. The tab remembers
minimum blocks for its 256 most recently read chain/market/creator/holder combinations,
including receipts whose balance reads fail. Navigation and RPC changes preserve
these minimums; a full reload clears them. Refreshes never replace a displayed
snapshot with an older one. An unavailable block leaves the displayed balances
intact and uses the existing error and transaction-retry controls. Posting reports
confirmation before waiting for the host's
index and finishing content uploads. Early uploads run concurrently with the
receipt wait without replacing its status text.

Progress callbacks report existing work; they do not start additional polls or
change transaction recovery. Account and post controls scope their notes to the
identity that started the action. Indicators reserve their width, status areas
reserve space, and reduced-motion preferences disable rotation.

## Notifications

| Event | Required behavior |
|---|---|
| First look | Read merged host notification pages of twenty per chain, stopping at enough visible rows, completion or eight pages. Interleave chains by time and display twenty rows total. No browser body scan. |
| Reply also mentions or quotes | Keep one row by chain and message id. A late body updates its reference reason. |
| Show more / refresh | One global display limit. Refresh retains every previously displayed row still selected; more adds twenty to that limit. |
| Refresh/remount | Consume sequenced changes with both replies to the reader and reference account in scope, including associations for old posts whose bytes arrived late. |
| More than one change page | Preserve the first `until` boundary; advance `through` only after applying each successful page. |
| Failed page | Keep earlier rows and the cursor for retry. If one chain fails, retain its rows while other chains update; if all fail, keep the page's retry state. |
| Simultaneous looks | Serialize work for that chain, Board and reader. A later reader has its own view. |
| Mute or own post | Exclude locally before displaying or fetching bodies. A mute edit changes selection without rebuilding the host index. |
| Blocklist changes | Notification queries exclude the reader's source-chain list before paging. A relevant membership change returns `reset_required`; discard this view's fetched data and reload once. An unblock restores older results on that refresh. |
| Host policy changes | Curated selects posts and replies by `curated` authors, the reader's replies to `parent_curated` authors, and direct replies to the reader when the reader is curated. A changed policy revision cues a refresh; a refresh reads the view afresh. The visible stream never moves just because curation changed. Host blocks take effect directly in cards, quotes, parent context and composers, including cached content. The policy watcher refreshes only policy, every 30 seconds while visible and on return. A failed read retains the last known policy. Posting checks again before asking the wallet; the host and relayer enforce their current lists independently. Bot labels only change the robot after names. Answers merge by two counters: the admin lists by `revision`, accounts' own declarations by `declarations`, so a late answer cannot undo either, and a declaration never cues a refresh. |
| Deleted or removed source | Apply its updated record and remove it from the visible notifications. |
| Quote target | Preserve the supplied immutable pin; never resolve a new pin for an existing reference. |
| Index generation changes | Discard the old notification view and retry once from its first page; never combine generations. A repeated reset or failed reload uses the ordinary retry state. |

`notifications.test.mjs` covers reader/deployment isolation, personal filtering,
partial chain failures, indexed blocking/unblocking, cross-chain pins, merged ordering, deduplication and one global display limit. `api.test.mjs` covers bounded
pages, late associations and failed change cursors; host reference tests cover
extraction, target matching, reconciliation and replay. The seeded notification
model mixes historical paging, new replies, late mentions, endings and failed
reads, then compares the drained stream with an independent map of eligible
messages. Every successful refresh must also retain earlier eligible rows.

`hasResponseRight` uses the target's immutable parent relationship: the author of its immediate
parent can respond to a live target regardless of its gate. The target's own terminal state wins.
For folding or removal of an existing response, read its parent through the shared message cache;
failed reads mean unknown protection, not permission to remove or apply ordinary folding.
Deleted and removed children leave their parent's discussion and reply count.
Placeholders remain only at their own address or as context for a surviving reply, with no expansion
or count. Their own thread page still shows surviving replies, with controls outside the placeholder.
Containers check terminal state too, so cached expansion and late reads cannot reopen a branch.

The composer owns its reply-eligibility result, scoped to chain, Board, parent and wallet.
A known gate restriction disables both its submit button and keyboard shortcut. Rechecking
retains that restriction, including on failure, until a successful check replaces it. A block
on an unprotected reply under a gate that does not enforce the blocklist only warns that readers will fold the reply.
The warning and button read the same result rather than keeping separate state. Unknown
eligibility still uses the mandatory live admission check before signing; a missing warning
is not permission. Returning to a visible tab rechecks only a displayed restriction, warning or failed
read, without polling. Only a failed read shows a retry button.

## Publication ownership

The operation is keyed by `PendingPost.key`, not by a component mount. Initial
publication, pending-list recovery and manual retry must share that operation.
One active flight owns its live post and uploads; another caller joins it rather
than starting a second send or using an older saved copy. Unmounting detaches UI
callbacks but does not cancel the operation. Closing the tab ends the flight;
the next visit reconstructs recovery from the saved bytes and exact signature.

The operation captures its `DraftBox` and version when it starts. Completion
may clear that version only. Revealing a reply or navigating remains the mounted
page's job, and must not fire after that page has gone away.

| State | Event | Next state and behavior |
|---|---|---|
| Draft | Reader submits | Capture intent and draft version; save bytes before asking the wallet. A storage failure warns but does not prevent posting. |
| Preparing | Wallet rejects, preview refuses, or first relayer response explicitly refuses | End flight, release the draft, keep its text. Delete this unsent recovery copy. Paid retry requires a new press. |
| Preparing | Signed request handed to relayer | Save exact signature first; an unknown answer retains it and the bytes. Never obtain another signature during recovery. |
| Preparing | Wallet send request | After preflight and the active-account check, save `walletSubmitted` before forwarding either wallet send method. A lost response retains bytes even without a hash; only explicit wallet rejection proves this attempt unsent. Recovery searches the chain and never submits another wallet transaction. |
| Preparing | Capture recovery range | Before signing or sending, save the Board, direct parent and accepted index checkpoint as the first lookup block. Never derive the bound from the browser clock. An unavailable index prevents a new send. |
| Sent, no message ID | Transaction hash received | Save hash; upload against it while waiting for the matching Posted event. A hash alone is not success. |
| Sent, waiting for receipt | Host returns 503, 429, 502 or 504, or the request fails to reach it | Keep waiting on the same hash. A landed transaction whose block the host is still indexing is reported as such, not as a failure. Consecutive refusals use 4, 8, 16, then 30-second delays, each shortened by up to 20% jitter. A valid pending answer restores the normal two-second interval. A pending receipt gets one last look at the deadline, an overloaded host none. No new poll starts after the two-minute wait window; an in-flight HTTP request remains subject to its own timeout. Expiry leaves the known hash available for recovery. |
| Sent | Matching Posted event found | Save message ID; upload remaining bytes against that ID. |
| Sent | Receipt proves a revert | End attempt. If this attempt's draft still holds its words, release the draft and delete the recovery copy. Otherwise the recovery copy is the only one: keep it, stop automatic retries and show its words in the pending list until the user discards it. A new attempt requires a new press. |
| Any active flight | Recovery or retry is requested | Join the existing flight. Do not send or upload twice. |
| Uploading | Host returns 200 for a record | Remove that record from the saved copy. Other records remain until independently stored. |
| Uploading | Host returns 202 | Keep those bytes as held; retry confirmation later. Clear only the submitted draft once all records are stored or held. |
| Uploading | Host answers 503 or 429, or its chain reads have not caught up (404 for the transaction, 403 for the message) | Send the same bytes and proof again, at most three more times, 1, 2 then 3 seconds apart. The host's `Retry-After`, held between 2 and 30 seconds, replaces those delays; a 429 without one waits 2 seconds. A refusal that outlasts them fails the record as below. |
| Uploading | Body or attachment fails | Keep the remaining bytes and release the sending lock for retry. A body failure stops the pass before attachments. |
| Uncertain, no hash | Unknown outcome, or a busy refusal (503, or 429 with `Retry-After`) | Keep asking the journal with the exact signature on the publication's backoff. The relayer enforces expiry for any new send. Continue chain searches independently. |
| Uncertain, no hash | Any other explicit refusal, such as a spent daily quota (429 without `Retry-After`) | Persist a pause on automatic journal checks. Continue chain searches; manual retry may ask with the same signature, including after expiry. |
| Uncertain signed post | Signature expires | Journal lookup remains allowed: the relayer returns recorded attempts before checking expiry. It refuses a fresh expired attempt; a non-temporary refusal pauses automatic journal checks. Keep chain checks and bytes for recovery or explicit discard. |
| Unknown message ID, known hash | Recovery check | Read that transaction through the host first. Require a successful Board Posted event matching author, parent and content hash; wait for the accepted index and verify its immutable commitment before revealing the post. Missing receipts retry; a proved revert ends the attempt and keeps the words as above. |
| Wallet post, no message ID | Receipt is still missing two minutes after this recovery record was created | Try one bounded indexed lookup using the saved block range and cursor on the existing publication backoff. A matching accepted post saves its ID and actual transaction hash before uploads resume by ID. No match keeps the old hash and bytes; a failed lookup advances nothing. A successful or reverted receipt still takes precedence. Never send another wallet transaction. |
| Signed post, no confirmed message | Receipt is pending or unavailable | On the publication's existing backoff, re-ask the relayer with the exact signature unless paused. A retained attempt returns the same hash; a dropped attempt may return a replacement after fresh validation. Save the returned hash before uploading. Refusal or outage never clears an earlier hash; its receipt and uploads remain recoverable. Manual retry may recheck a paused journal lookup. |
| Unknown or stale wallet hash | Successful chain search with no match | A lookup examines at most 500 author entries per pass. Retain its cursor and original checkpoint while incomplete. After finishing, advance the lower bound past that original checkpoint, never the later page's checkpoint. Accepted history needs no overlap. A failed request changes neither cursor nor bound. |
| Pending, idle | Automatic check | Each publication owns one backoff: 15, 30, 60, 120, then 180 seconds between completed attempts. A manual retry resets only its own delay. Page refresh and another publication cannot bypass that schedule. |
| Unsent preparation | Hour-old cleanup | Look for the post first. Only if no post, signature, hash or wallet submission is known may the abandoned recovery copy expire. A wallet submission never expires merely because it has not been found yet. |
| Pending | Reader discards | Exclude active work and check the chain again. If found, upload instead; otherwise require explicit confirmation before deleting bytes. Discarding cancels nothing on chain. A sent wallet transaction can still land, and so can a signature the relayer holds, until its deadline an hour after signing. Either leaves the post without its content. |
| Active | Navigate away or change another draft | Finish against the captured post and draft version; do not clear the newer draft or navigate the new page. |
| Active | Tab closes mid-upload | Already stored records stay removed; held/unfinished bytes and known transaction/signature remain recoverable from IndexedDB. |

The composer shares one reserved area for payment options, reply-access checks,
and publication progress. Progress temporarily replaces the payment options;
confirmation clears after four seconds once the feed settles. Errors stay until
dismissed or replaced by another attempt, and dismissing restores the payment
controls without cancelling recovery. Reserve one line, or the payment options’
natural height when they wrap. Routine updates keep the area stable;
long errors can wrap without being clipped.

Regression coverage belongs in the existing Node suites: posting and recovery
for outcomes, transaction tests for bounded receipt backoff, draft-box tests
for version ownership, and operation tests for concurrent retry, navigation
and resumed uploads. `recovery-model.test.mjs` interleaves relay outcomes,
replacement hashes, receipt/lookup failures, held and failed uploads, manual
retries and reloads from IndexedDB. Its model checks the exact signature,
remaining bytes, pause state and eventual completion after service recovers.
Separate seeded searches check that only successful scans advance the saved
lower bound. Playwright browser tests cover navigation, focus and retained DOM
behavior; the production-build layout suite checks visual stability at desktop
and mobile widths. Both suites run in CI. The
[manual release walkthrough](RELEASE_CHECKLIST.md) supplements them with
real-wallet prompt checks.

The pending list observes operations and their completion events; it owns no
retry timer. Navigation leaves scheduled recovery alive in the tab. Completion
or discard cancels that publication's timer. A reload resumes from the saved
hash, search cursor and resubmission pause. Upload failures and held bytes use
the same backoff; only successful storage releases bytes.

Once indexed and its body accepted, a local publication announces once, including
recovery after its composer has gone. Off-screen cached streams merge only that
post under their normal eligibility rules, without advancing their change cursor.
One targeted message read supplies the record and, where needed, its parent's
count. A mounted stream stays unchanged. Its own confirmations do not count as new posts; they appear through the existing in-stream posting flow or a later load. Profiles still cue changed reply counts, whoever replied.
The mounted Feed registers its identity and a count callback; this covers profiles
as well as Home. It owns the refresh count while mounted, just as a thread owns
its poll's count. A departed view cannot clear or overwrite the next view's cue.
Already merged IDs leave the cue through the view's existing seen set. A quiet
poll already in flight can briefly restore a stale cue until its next check.

Complete retained reply branches append the local reply. Partial branches only
update their count; their existing cursor reaches the reply on paging. Reply
windows retain their requested size, so a changed count alone cannot make a
resumed branch fetch unrelated replies. An explicit larger window can. Navigation
keeps its existing Back anchor and sidebar-to-top behaviour. A failed point read
or a different index generation leaves the cached view for normal refresh.

List edits, moderation, reply rules and key actions capture the provider and
account at the press through `captureWallet`.
After a network switch they recheck that capture before sending. The signer still
checks the wallet's account immediately before each signing request.

Account-key views remount on chain, creator or connected-account changes. Their
shared `KeyPage` controller uses `Resource` for reads and confirmed updates, and
`keyQuote` debounces inputs without effect-driven component resets. Reopening
activation or trading checks a saved receipt once; submitting a new transaction
waits for confirmation. A failed lookup keeps the hash and permits manual recovery.
Trade estimates show the quoted total. The exact quote is the maximum payment for buys
and transfers, or the minimum return for sells; adverse price movement requires a new quote.
A trade started in the view captures its reviewed quote and recipient for both submission
and display. While signing or pending, its button and tooltip keep that capture even if a
new quote arrives. The controls stay locked, but the captured amount keeps its normal contrast.
Each trade tab keeps its own quantity. Confirmation clears only the tab that started that
transaction; claiming fees leaves quantities alone. Transaction status sits beside the
initiating button and is shown only on its trade tab. A recovered hash whose action this
page does not know has neutral status above the tabs and clears no quantities. Confirmation
listeners receive the settled hash so another tab's transaction cannot clear this page's input.
Account-read errors remain visible across tabs.
The capture belongs to that view's own transaction (features/keys/trade-capture.svelte.ts): a remounted
view, or one whose pending transaction came from another tab, shows its live quote dimmed.

Account-key activation and trade hashes belong to a tab-wide transaction owner,
keyed by chain, market, account and (for trades) creator. Its in-flight lock stays
held through navigation until the operation settles or fails, including while a
wallet prompt is open. Storage events adopt another tab’s pending hash but never
clear an unresolved local transaction. A refresh also checks for missed saves;
finishing a local transaction preserves any different hash saved by another tab.
Local storage is a reload
fallback, not a source that overwrites a known in-memory outcome during refresh.
A failed save keeps the pending hash and warns the reader to keep the tab open.
Manual clearing still requires fresh account state and a successful storage write.
`KeyringView` owns membership polling and the displayed snapshot. The initial read
runs even if the browser tab is still hidden during startup; later polls require
visibility. Membership changes apply on initial load or explicit refresh; posting
refreshes only the posts, not the displayed membership. Visible keyring pages poll
for a refresh cue every 30 seconds, other home tabs every five minutes. The reader's
own keyring is one read that every view shares (`keyring.ts`): a read in flight
or under a minute old answers the navigation links on each page visit and home's
first load, and each poll asks again. An explicit refresh or a confirmed key
transaction forgets it, so the next view asks the host.

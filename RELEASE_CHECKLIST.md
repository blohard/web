# Manual release walkthrough

Use this before a beta release, and repeat affected rows after UI or wallet
changes. It covers browser behavior that the Node and integration suites do
not exercise. Record pass, fail or untested for each row; passing automated
checks does not turn an untested browser case into a pass.

## Setup

- Test one recorded revision. Run `npm run check`, `npm test`, `npm run build`,
  `npm run test:ui` and the integration suite (scripts/integration/README.md). Reload the served
  build and record its revision and URL too; report if it differs from the
  revision tested locally.
- Use test-chain accounts: one sponsored account, one funded account for paid
  sends, and a second account to send replies and notifications. Accounts may
  fill more than one role. Note which chain and accounts were used.
- Pick a stream with more than twenty rows and a thread with more than forty
  direct replies and several nested levels. Keep their URLs in the run notes.
- Check desktop with MetaMask and Coinbase Wallet. Check an actual phone both
  in its ordinary browser and in a supported wallet's browser. Record the OS,
  browser and wallet versions. A narrow desktop window checks layout only;
  `dev.html` can help reproduce navigation but does not verify real wallet prompts.

## Mobile wallet app (MetaMask on blohard.social)

Check the application's CSP includes the relay origin, a deployment setting.
Use Safari on iOS and Chrome on Android with the current MetaMask app. From the
ordinary browser (not MetaMask's browser): connect, reject and retry, then approve.
The site must stay in that browser. Post a sponsored signature and a paid testnet
transaction, returning from MetaMask after each. Check rejection preserves the
draft, switching accounts/networks updates the site, and a reload restores the
session without another approval. Disconnect, reload, and explicitly reconnect.
Also test with no MetaMask app installed: the failed connection must release the
button and leave the page usable. Record these as untested until tried on a phone.

## Before publishing the frontend

After building the candidate frontend and starting the intended host, run from
`web/` (pass the staging directory when it is not `dist`):

```sh
npm run check:deployment -- https://your-host.example /path/to/staged-dist
```

Run this before swapping the staged directory into service. It reads only
`/api/status`, compares its keyring market and chain with `deployment.json`
emitted by Vite, and requires the verified blocklist and both key gates when
keys are enabled. Gate addresses come from the host, not the frontend build;
the host checks their getters against its Board, market and blocklist, but not
their code: deploy gates only from this repository's contracts. If validation
is still pending,
wait and rerun the check. A mismatch must stop publication. No chain calls or
private RPC configuration are involved. A build with keys disabled requires
keys to be disabled on the host too. The small metadata file contains only the
chain and public addresses already included in the client.

## Walkthrough

| Done | Action | Expected result |
| --- | --- | --- |
| [ ] | Read while disconnected and press quote on a card. Connect, reject the prompt, then connect successfully. Switch accounts in the wallet. Disconnect on the site and change accounts again. | Reading needs no wallet, and quote without one shows the connect or install line under the card, then quotes once a wallet connects. A rejected connection leaves the site disconnected. A successful account switch updates the displayed identity and subsequent signing account. A site-side disconnect stays disconnected until an explicit reconnect. |
| [ ] | Scroll down a stream, use its stream-wide “show more,” open a reply, press a row's main post's reply count to open its replies in the stream, read them and hide them with the same count, which now reads “hide replies,” open and hide a previewed reply's replies in place, then follow its post-number link and come Back, then use Back and Forward. Return to the stream by the whale and by a tab press as well; switch chains, scroll the other chain's stream, open a post there and come Back. Open a reply box, type, and press its discard control. Repeat through a profile tab. Press Home while already on the feed. | The addressed reply is in view, with its immediate parent available above. Back restores the stream's rows and position; Forward restores the thread. Returning does not steal focus. An explicit Home press refreshes and takes the feed to the top. Conversations opened in place come back open with their pages, and none opens by itself. A reply posted from the second account inside an open branch raises the refresh cue, and folding that branch drops it from the count. Back, and a tab left and returned to within the visit, restore the stream position; the whale or a fresh link starts the stream at the top, and Back after switching chains and scrolling the other chain's stream restores that chain's saved position. Discarding a reply box closes it and drops its words. |
| [ ] | Open several nested reply levels, show a second page of direct replies, and open an inline reply box deep in the thread. Add earlier ancestors; visit a profile and return. | Each level opens and hides in place from its own card's reply count, without indentation, and no controls pile up where branches end. Earlier ancestors are added without collapsing open branches. Rows, branches and the box survive Back. A fresh reply press reveals and focuses the box; returning to an already-open box does not jump to it. |
| [ ] | Read a long body in a stream, a reply list and a quote, including a late-loading picture. Repeat at phone width and Tab through its controls. Follow "read full post", then Back. | Only overflowing bodies show the link and fade. The focused thread post is full, and Back restores the stream's rows and position. Visible controls work, and a picture cut by the preview opens full size from its visible part; links and controls entirely past the cut are skipped by Tab. Automatically loaded content keeps the preview bounded. Quotes and width changes remeasure it. |
| [ ] | Press "show picture" in a long stream card and inside a quote. Open a second picture, hide them one at a time, and refresh with one open. Compare with a followed author's automatically loaded picture. | An explicit show press displays the whole picture by lifting the containing previews, including extra text. The cap returns only after the last explicitly opened picture is hidden. Refresh preserves an opened picture. Auto-loaded pictures leave the cap in place; their visible part still opens the lightbox. |
| [ ] | In both Home and an inline reply, type text, select an @mention and attach a picture. On Home, add a quote. Navigate away and back. On desktop, move the caret and use the picker's arrows, Enter/Tab and Escape. | Text, mention identity, attachment and quote survive navigation. Mention insertion uses the caret position and leaves surrounding text intact. Escape closes the picker. Picking a mention does not submit. |
| [ ] | Submit a sponsored post, rejecting the signature once and then approving. Send a paid reply, rejecting the transaction once and then approving. Exercise Cmd/Ctrl+Enter on desktop. | Rejection preserves the draft and makes retry usable. Sponsored posting requests a signature, not a gas-paying transaction. Paid posting requests a transaction on the intended chain and account. Each accepted submission appears once, clears only its submitted draft and makes the landed post/reply reachable. |
| [ ] | With a slow connection, submit a reply, navigate elsewhere while it is pending and type a new draft. Separately, reload during another send once its pending record is visible. | The first completion leaves the newer draft and current page alone. The second send remains recoverable after reload and finishes without a second wallet send; its body and picture are readable afterwards. Unsent drafts are not promised to survive a hard reload. If either send finished too quickly, mark that case untested and repeat with throttling. |
| [ ] | Keep a stream or an expanded thread visible while the second account replies. Wait for the refresh cue, then press it. Also send a reply that mentions the recipient. | Quiet polling changes the cue only. Refresh preserves existing rows and open branches and inserts the new content. Notifications interleave replies, mentions and quotes in time order; a reply with a mention appears once. |
| [ ] | On the phone, repeat replying and picking a mention with the keyboard open. Rotate the device; view long plain text, a URL and a picture. Check both themes. | The focused editor and send control can be reached above/around the keyboard. Buttons and the stream expansion control are usable. Long text and URLs wrap within their card, not across the page. Rotation and image loading do not strand the active control offscreen. Text and focus indicators remain visible in both themes. |
| [ ] | Open a page containing the discussion widget, read the comment count, press "write a comment", expand replies and follow a body mention, post link and reply link. Repeat with a deleted root; check phone width too. | The frame sizes to its content; branches open on demand. The count says comments, each comment's own link says reply. App links open outside the frame at the intended account, post or composer. The widget does not offer a comment on a closed root. |
| [ ] | Post a body that contains raw HTML, a script tag, an element with an event handler attribute, a javascript link and an ordinary link to another site. Read it in a stream, in its thread and in the widget. | Everything renders as written text except the ordinary link. No dialog appears, no picture loads and nothing runs. The ordinary link opens in a new tab. |
| [ ] | In Home and an inline reply, type `*bold*`, `_italics_`, a bare domain, a URL, unmatched markers and Markdown-like headings/lists/fences. Include a mention, picture and quote. Post with the button and keyboard shortcut; refresh after opening the picture. | Only the flat emphasis, links and app references are interpreted. The other source stays literal. Pictures and quote cards keep their existing controls, nested quotes remain links, and an open picture survives refresh. The composer has no Markdown nesting check. |

After changes to reactive state, also navigate between Home, Settings and the
key pages, switch wallet accounts, and change a form value. Verify that controls
and status keep updating, with no busy loop or frozen UI. A regex cannot reliably
determine whether an effect creates a reactive cycle.

For the refresh row, distinguish a normal refresh from an explicit Home press:
a normal refresh may preserve the current reading position while inserting
new rows above it. Scrolling to the top is specifically part of the Home press.

## Reply rules and blocklist display

Use a test deployment with verified key gates for key-specific cases. If none is
available, record those cases as untested rather than treating a disabled option
as a successful gate check. Do not change production configuration for this walkthrough.

| Result | Action | Expected |
|---|---|---|
| [ ] | Open your profile's reply selector with an empty and a nonempty blocklist. Repeat on a chain without a matching verified key market. | Labels omit or include “except blocked” appropriately. The key choice requires activation and the matching verified combined gate. Changing a rule opens the wallet immediately; rejection restores the current selection. |
| [ ] | Choose an explicit rule in a post and a reply draft, navigate away and return, then publish with sponsorship. Repeat with wallet gas. | The draft keeps its account/chain-specific choice. The posted rule matches the signed or paid transaction. Reply composers keep the rule, cancel, preview and send controls separate at phone and desktop widths. |
| [ ] | Choose a draft rule, then withdraw that gate from the test host's published configuration before submitting. Separately, make the status request fail. | The unavailable choice falls back to account default with a notice. A failed read prevents signing instead of silently changing the rule. Recovery of an existing signature keeps its original rule. |
| [ ] | Open and save a rule on your existing post or reply while new posts are waiting. Reject once, then confirm. Try delete while the edit is pending, including another mounted copy of the post. | Opening the picker and confirmation do not advance or reload the stream. Rejection restores the rule; confirmation updates it from the receipt. Delete is disabled until the edit finishes. Deleted posts have no picker. |
| [ ] | Block a replier under an unset or custom gate, a plain key gate, and the combined gate. Repeat while the test host withholds gate validation but publishes its blocklist. | After explicit refresh, the author's blocklist folds the replies in every case and filters notifications/replies-to-you. On-chain admission depends separately on whether the effective gate enforces that list. |
| [ ] | Read replies under an account-level key rule, then sell the last key or change that account rule from another session. Load older rows, post, and return to the widget tab. Finally refresh successfully, and repeat with a failed refresh. | Existing folds stay fixed through incidental actions. Successful explicit refresh reevaluates them. A failed refresh retains the visible page and its prior folds. The widget follows the same rule. |
| [ ] | Give one post an explicit rule, leave another on account default, then deactivate and reactivate through settings. | The explicit rule survives. Only the inherited post follows account deactivation. Rules govern direct replies, not descendants authored by others. |

## Record the result

Keep a short note with the release or review:

```text
Revision / served revision / URL:
Date / tester:
Devices, OS, browsers and wallets:
Chain / test accounts / stream and thread URLs / embed page:
check, unit, build, browser and integration results:
Walkthrough rows passed:
Failed or untested rows, with environment and reason:
For each failure: steps, expected vs actual result, screenshot or console error:
```

Fix and repeat failed cases on the updated build. Do not silently substitute
`dev.html` for an unavailable wallet or report an untested mobile platform as
covered. The [integration notes](scripts/integration/README.md) describe which
failure and recovery paths are also checked automatically.

## Reply rules on Base Sepolia

- Activate a test creator and select the key-holder rule. A non-holder opening a
  reply sees a purchase link. It opens a separate tab and leaves the reply draft
  intact. After buying, return, wait for the automatic recheck, then send the reply.
- A blocked key holder sees a block explanation, with no purchase suggestion.
- Choose no new replies on a top-level post. Existing replies remain readable,
  and new direct replies are rejected, including the author's. Choose another
  rule to reopen. The embed must hide its write-comment link while closed.
- Changing rules must not reload a stream. Set a post to key holders while the
  account rule is all, then refresh. Existing unblocked replies remain visible.
  Account-level key-holder folds update only on an explicit refresh. Per-post
  rules do not hide or reveal earlier replies.
- Confirm both key gate addresses and the closed gate are published by the host
  only after validation on both Base and Base Sepolia.

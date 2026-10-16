# blohard web

The web app of [blohard](https://blohard.social), a public message board kept on
EVM chains: a Svelte client that reads and posts through a
[host](https://github.com/blohard/host), following the
[protocol](https://github.com/blohard/protocol) and the rules in
[CLIENT.md](CLIENT.md). MIT licensed.

## Native gas tokens

Wallet network setup reads `native_currency` (`name`, `symbol`, `decimals`) from
the host's `/api/status`. Configure it on the host, for example
`native_currency = { name = "COIN", symbol = "COIN", decimals = 18 }` under
`[[chains]]`; no frontend build setting or chain-specific code is needed.
Older hosts that omit it default to Ether/ETH/18. AccountKeys prices and displays
remain ETH-specific and are available only on their supported chains.

## Start here

[App.svelte](src/App.svelte) connects routes to pages and supplies the header,
wallet controls and refresh button. [app.css](src/app.css) holds shared styles.
Features keep their components, models and tests together. Start with the row
below that matches the change you want to make.

| Change | Start here | Detailed rules |
|---|---|---|
| Which posts a stream includes | [streams/feed-policy.ts](src/features/streams/feed-policy.ts) | [Feed selection](STATE.md#feed-selection) |
| Stream paging, retained rows and quiet polls | [streams/feed.ts](src/features/streams/feed.ts), [Feed.svelte](src/features/streams/Feed.svelte) | [State ownership](STATE.md#client-state-and-ownership) |
| Conversation grouping, parent context and reply expansion | [streams/conversation.ts](src/features/streams/conversation.ts), [ConversationRow.svelte](src/features/streams/ConversationRow.svelte), [replies.ts](src/features/streams/replies.ts) | [Client rules](CLIENT.md) |
| Thread pages | [streams/Thread.svelte](src/features/streams/Thread.svelte), [Replies.svelte](src/features/streams/Replies.svelte) | [State ownership](STATE.md#client-state-and-ownership) |
| Card spacing, dashed connectors and separators | [messages/message-layout.css](src/features/messages/message-layout.css), [ConversationRow.svelte](src/features/streams/ConversationRow.svelte) | [Card layout](#card-layout) |
| Post text, pictures, quotes and link cards | [messages/MessageBody.svelte](src/features/messages/MessageBody.svelte), [MessageCard.svelte](src/features/messages/MessageCard.svelte) | [Records and references](https://github.com/blohard/protocol/blob/main/SPEC.md#6-records) |
| Reply, quote and moderation controls | [messages/CardActions.svelte](src/features/messages/CardActions.svelte) | [Card actions](STATE.md#card-actions) |
| Composing, sending and recovering a post | [publishing/Composer.svelte](src/features/publishing/Composer.svelte), [publications.svelte.ts](src/features/publishing/publications.svelte.ts) | [Publication ownership](STATE.md#publication-ownership) |
| Key prices, trades and transaction recovery | [keys/KeyMarket.svelte](src/features/keys/KeyMarket.svelte), [key-page.svelte.ts](src/features/keys/key-page.svelte.ts) | [Transaction progress](STATE.md#transaction-progress) |
| Keys held and holders pages | [keys/KeyringManagement.svelte](src/features/keys/KeyringManagement.svelte), [keyring-balances-view.svelte.ts](src/features/keys/keyring-balances-view.svelte.ts) | [State ownership](STATE.md#client-state-and-ownership) |
| URLs, Back/Forward and scroll restoration | [navigation/router.svelte.ts](src/features/navigation/router.svelte.ts), [visits.ts](src/features/navigation/visits.ts), [visit-position.ts](src/features/navigation/visit-position.ts) | [State ownership](STATE.md#client-state-and-ownership) |
| Profiles, following, lists and account settings | [account/Profile.svelte](src/features/account/Profile.svelte), [Settings.svelte](src/features/account/Settings.svelte), [account-actions.svelte.ts](src/features/account/account-actions.svelte.ts) | [State ownership](STATE.md#client-state-and-ownership) |
| Notifications and the unread dot | [notifications/Notifications.svelte](src/features/notifications/Notifications.svelte), [notifications.ts](src/features/notifications/notifications.ts), [notification-dot.svelte.ts](src/features/notifications/notification-dot.svelte.ts) | [Notifications](STATE.md#notifications) |
| Embedded discussions on other sites | [embed/Embed.svelte](src/features/embed/Embed.svelte), [embed-discussion.svelte.ts](src/features/embed/embed-discussion.svelte.ts) | [Refresh signals](STATE.md#refresh-signals) |
| Refresh cue and initial loading | [shared/refresh-cue.svelte.ts](src/shared/refresh-cue.svelte.ts), [first-screen.svelte.ts](src/shared/first-screen.svelte.ts) | [Refresh signals](STATE.md#refresh-signals), [initial display](STATE.md#initial-stream-display) |

## Finding the owner

- `src/features/streams/` owns streams and threads. Its `keyring-view.svelte.ts`
  owns the membership snapshot used to select Home's keyring stream.
- `src/features/messages/` owns cards, their reply-display verdicts (`gating.svelte.ts`)
  and their actions, including moderation.
- `src/features/publishing/` owns drafts, sending and pending uploads. From
  `publications.svelte.ts`, follow `posting.ts` for one send and `recovery.ts`
  for retrying a saved post. `sign-post.ts` signs sponsored posts; `pending.ts`
  owns browser storage.
- `src/features/keys/` owns account keys. `keyring-balances.ts` reads balance
  pages; `keyring-balances-view.svelte.ts` owns their displayed page and polling.
- `src/features/navigation/` owns routes, visits and reading positions.
- `src/features/account/` owns profiles, following, lists and account settings,
  including author gates and reply rules. `src/lib/host-policy.ts` handles signed edits to the host lists and accounts' bot declarations; personal
  blocklists still use the on-chain registry in `src/lib/registry.ts`.
- `src/features/notifications/` owns the notifications page, its readers and the unread dot.
- `src/features/embed/` owns the embedded discussion and its refresh controller.
- `src/shared/` holds reusable UI and async helpers such as `Loading`,
  `Retained`, `Resource`, `SerialQueue` and HTTP response readers.
- `src/lib/mobile-wallet.ts` loads the wallet app connector a host serves beside the app,
  named when the app is built; `src/lib/coinbase.ts` supplies the passkey wallet adapter.
  `wallet.svelte.ts` owns provider selection and connection state;
  `components/ConnectWallet.svelte` supplies the shared chooser.
- `src/lib/` keeps protocol readers, generated ABIs and shared account state
  such as wallet, names, follows and gates. `relay-status.ts` reads relayer
  availability and policy for the app-wide host state.
- `src/components/` keeps shared account UI (names, avatars, wallet controls)
  and the About page.

Follow the owner of the behavior when placing a change. A feature can import
another feature directly; there are no barrel files or extra facade layers.
[STATE.md](STATE.md) is the reference for lifetimes, recovery and display rules.

## Installed app icon

`index.html` links `public/manifest.webmanifest`. Its ordinary 192px and 512px
icons use the existing whale avatar. Android uses the separate opaque maskable
icon: sky and water fill the square, with the face inside the central safe area
(a circle with radius 40% of the image width). Keep that artwork square; the
launcher applies its own circle or rounded-square crop. Browser and Apple touch
icons remain separate. Check both the circular crop and the safe area when
changing this artwork.

## Card layout

[app.css](src/app.css) keeps shared tab and card-action appearance rules together.
Profiles and host lists use `.page-tabs`, with page-specific spacing kept local.

[message-layout.css](src/features/messages/message-layout.css) owns the shared
card geometry. [conversation-layout.ts](src/features/streams/conversation-layout.ts)
calculates preview counts, context labels and connections from supplied display
state; `ConversationRow` reads that state and binds the result. The arranging view
(`ConversationRow`, `Thread` or `Replies`) passes three independent props to `MessageCard`:

- `separator`: the horizontal border above the card, on by default. Set it to
  `false` after a connected card or a context label that already carries the border.
- `connector`: extend the dashed line below this card toward the next one.
- `continuesAbove`: draw a short reply stub above the avatar. Sibling replies
  have this stub too; it does not mean they answer the card directly above.

A visible `InlineReply` interrupts a join, so the next card keeps its separator.
The editor and the arranging views share `Box.visible()` for that decision.
Scroll and focus wrappers do not determine borders. Keep avatar offsets and
connector extensions independent of card height when changing these rules;
check previews, expanded replies and open editors at desktop and phone widths.

## Status messages without layout shifts

Temporary status messages must not add or remove rows that move the page. Reuse
an existing status area with stable dimensions, or use an overlay. Check the
transition into and out of loading at desktop and phone widths, including its
effect on automatic scrolling. Use `shared/loading-delay.svelte.ts` for the 300 ms
spinner delay, keeping one operation identity across consecutive loading steps.
Keep actionable restrictions and errors readable.

## Tests and checks

Feature tests live in `src/features/<feature>/tests/`; shared-helper tests live
in `src/shared/tests/`. `scripts/` holds the common harness, protocol and other
client tests, integration tests and tooling. The harness loads real app modules
through Vite with explicit paths from `src/`, for example
`load('features/streams/feed-policy.ts')`.

From this directory:

```sh
npm ci
npm run check      # types
npm test           # Node tests
npm run build      # the app and the rendered protocol spec, into dist/
npm run test:ui    # browser layout and interactions in Chromium; separate pre-release check
```

The contracts the app talks to are pinned as submodules under `lib/`, so clone
with `--recursive`. The ABIs generated from them are tracked in `src/lib/abi/`:
after moving a pin, build the contracts there with Foundry and run `npm run abi`;
`npm run abi:check` is the check that the tracked ABIs still match. The
integration suite needs a host and a relayer binary; see
[scripts/integration/README.md](scripts/integration/README.md).

For a focused test, from `web/`:

```sh
node --test src/features/streams/tests/feed-policy.test.mjs
```

For UI interactions, from `web/`:

```sh
npx playwright install chromium  # once after npm ci; Linux may need --with-deps
npm run test:ui                  # real app in Chromium, fixture HTTP responses
npm run test:ui -- --ui          # inspect actions, DOM and failures interactively
```

Choose the smallest test that covers the change:

- Reader and recovery logic: keep using [scripts/harness.mjs](scripts/harness.mjs).
- Reactive controllers: [reactiveFixture](scripts/svelte-test.mjs) compiles a small
  fixture with Svelte's client runtime, without a DOM.
- Static markup, link destinations, counts and layout classes belong in the Node
  suite, which runs in every regular check. The harness's `renderComponent` uses
  the shared server renderer; its effects do not run. See
  [conversation-row.test.mjs](src/features/streams/tests/conversation-row.test.mjs)
  for real cards rendered at explicit read states. When a test overrides a
  method, use `t.mock.method` so Node restores it after the test.
- Clicks, layout, navigation and async handoffs: add a case beside
  [tests/ui/streams.spec.mjs](tests/ui/streams.spec.mjs). These mount the real app;
  [host.mjs](tests/ui/host.mjs) serves the existing reader fixture at the HTTP
  boundary. Unexpected API requests, outside traffic and uncaught app errors
  fail the test. No wallet, RPC or running host is needed. For a component that
  needs particular props, use a small mounting page such as
  [fixtures/Conversation.svelte](tests/ui/fixtures/Conversation.svelte); it uses
  the real cards and readers too.

The browser suite is separate from the fast checks (`npm run check`, `npm test`),
so those do not require a browser installation. Reserve it for behavior Node cannot verify, such
as computed CSS, browser events, focus and scrolling; keep ordinary rendering
checks in Node. Run the browser suite before a release and both suites when
changing these interactions.
It starts its own Vite server on port 8790; a port already in use fails the run.
A failed test saves its trace under `test-results/` for `npx playwright show-trace`.
Browser tests assert rendered behavior rather than replacing component source
or matching template text.

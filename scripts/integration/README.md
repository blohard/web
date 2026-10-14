# Application integration tests

From this directory, with Foundry and the two service binaries at hand:

```sh
forge build --root lib/protocol
forge build --root lib/account-keys
BLOHARD_HOST_BIN=/path/to/blohard-host BLOHARD_RELAY_BIN=/path/to/blohard-relay npm run test:integration
```

The host is built from [blohard/host](https://github.com/blohard/host); the
relayer is a deployment's own, as there is no public one yet. With either
unnamed, the suite stops before starting anything and says what it lacks. The
ordinary checks (`npm run check`, `npm test`, `npm run build`, `npm run test:ui`)
need neither; integration is explicit.

The fixture starts Anvil, deploys Board and ListRegistry, seeds sponsorship,
and starts the real host and relayer behind a local forwarding proxy. A separate
account-key scenario runs Anvil with chain ID 84532 and deploys AccountKeys and
both key gates, without contacting Base Sepolia. Ports
and storage are temporary, using only Anvil's public test keys. Processes and
temporary files are cleaned up on success or failure. The load-test smoke run
in `../load-test/e2e.mjs` shares this setup and keeps its own assertions.

## What is tested

| Scenario | Evidence |
| --- | --- |
| Successful sponsored send, lost HTTP answer, fresh tab | Signature and bytes saved before submission; journal repeats return one hash; exactly one matching on-chain post; recovery stores body and attachment and releases the pending record without wallet signing |
| Wallet replaces an unmined transaction at the same nonce | The original receipt stays missing; a fresh application finds the real replacement through the index, saves its ID and hash before uploading, and sends no additional wallet transaction |
| Host killed while uploads are held | Both uploads returned 202; after SIGKILL their unique bytes are unavailable; the transaction then mines and a fresh application restores both records from IndexedDB |
| Reply also mentions its recipient | Before the body arrives it is one reply notification; after upload it becomes one mention notification; a wallet-paid deletion removes it on refresh without a relayer request |
| Profile deactivation | The actual profile write helper submits through the connected wallet, the receipt immediately updates the gate ledger, the host indexes the change, and an on-chain reset reverses deactivation |
| Account-key lifecycle | Activate with own keys, buy, transfer and sell against the actual contract; read holdings, balances and paged trade notifications through production decoders; verify restored answers after a host restart |
| Staged deployment configuration | Build with disposable market addresses and compare the emitted deployment metadata to the live fixture status; reject a mismatched market |
| Right of response | A blocked author publishes paid and sponsored responses to a reply under their post. Protection bypasses automatic folding and removal, survives account deactivation, and ends admission when the target is deleted. Unrelated authors still face the gate; the deleted target's own page retains surviving replies. |
| Every core route the client reads | Feeds of each kind, the members-only timeline, changes, a thread with a deleted reply, a quote reference and its pin, state snapshots with memberships, list paging, admission, transactions, names and content are read from the real host through the client's own decoders; the run ends by checking that every documented client route was answered and no other was used |

Production modules are loaded through Vite, as in the Node unit suite. IndexedDB
uses `fake-indexeddb` and survives a fresh Vite module graph, while tab-local
operations and caches do not. The injected-wallet adapter reports a test account,
signs typed data with its Anvil key, and forwards chain calls to Anvil. Relative
fetch URLs resolve to the disposable site; response bodies come from the actual
services. The proxy deliberately loses one successful relayer response.

Only the client clock advances to skip two-minute pending-receipt waits; the node
and service clocks stay real. Automatic publication retries are driven explicitly
here; their timing and independent backoff remain covered by the unit tests.
The host runs with zero confirmation depth, and mining is paused explicitly for
the replacement and holding cases.

This does not test browser DOM behavior, extension prompts, IndexedDB disk
durability or mobile layout. Use the [manual release walkthrough](../../RELEASE_CHECKLIST.md)
for wallet, navigation, draft recovery and mobile checks. No production fault
switches or new dependencies are required.

# Read costs

Measure the actual app's feed, thread, gate and reply readers against a
disposable Anvil and a real host index. This is a manual measurement, not a
browser suite or part of `npm test`. It adds no dependency and never uses the
public site, funded keys or an existing store.

## Regression budgets

The ordinary `npm test` run includes exact request-count assertions in
[request-costs.test.mjs](../request-costs.test.mjs) and
[notifications.test.mjs](../../src/features/notifications/tests/notifications.test.mjs).
These use the real client modules with the shared HTTP fixture. They count all requests, so an
unexpected route fails too. They do not measure host RPC work or latency.

| Action | Expected host calls |
|---|---|
| First twenty feed rows, including card gates and counts | 1 feed |
| Feed refresh or quiet poll, at most fifty change entries | 1 changes |
| Feed refresh with 51 new posts | 2 changes |
| Cold thread with parent and twenty direct replies | 1 message, 1 replies |
| Thread refresh, unchanged branch | 1 changes, 1 message |
| Reveal a distant reply after the first page | 1 message |
| Next twenty direct replies | 1 replies |
| First twenty merged notifications | 1 notifications |
| Notification refresh, including a late body association | 1 changes |
| Recover a pending signed post with a known hash and two unstored records | 1 transaction, 1 relay, 2 uploads |
| Recover its accepted post after both records were promoted | 1 transaction, 1 state, 1 message, 2 content probes; no uploads |
| A hundred cards sharing a body | 1 content; 0 after verification; a missing body retries on the next read |

Feed cases compare 100 posts/20 retained rows with 2,000 posts/200 retained
rows. Thread and notification cases compare 100 with 2,000 entries; recovery
compares heads at 100 and 20 million. These budgets apply to the stated fixtures:
more change pages, unseen ancestor context, membership lookups, names and images
can require additional calls. Reopening a loaded branch and reading records or
gates already supplied by a page must add none.

Run just the budget cases from `web/`:

```sh
node --test scripts/request-costs.test.mjs
node --test --test-name-pattern='notification request budget' src/features/notifications/tests/notifications.test.mjs
```

## Measurement command

```sh
forge build --root lib/protocol
forge build --root lib/account-keys
BLOHARD_HOST_BIN=/path/to/blohard-host npm run measure:reads
```

Node, the installed dependencies, Anvil and a host binary (built from
[blohard/host](https://github.com/blohard/host)) are required.
Output goes to a new timestamped JSON file under ignored `web/load-results/`.
`--out /path/to/report.json` chooses a new file; existing files are not replaced.
Temporary services and stores are removed on completion or failure.

`--latency 25` is the default: 25 ms per browser-to-host request and per
host-to-node request. It models round-trip delay, not bandwidth. `--latency 0`
measures local overhead. Results are individual samples, not tail percentiles.

## Workload

Twenty authors create twenty roots. Another post replies to the first root,
and twenty posts reply to that reply. All gates are open. The chain then mines
4,000 empty blocks and stops; the host accepts blocks two confirmations deep.

Each view starts with an empty host store. The runner waits until ingestion
reaches the accepted head and records that startup time separately. Two fresh
Node processes load the production modules through Vite, each loading and then
refreshing the view. There is no simulated RPC cache or alternate app reader.

- Home: twenty Everyone rows, their gates and counts.
- Thread: the selected reply, its immediate parent and twenty direct replies,
  including the visible cards' gates and counts.

No Svelte components are rendered. Bodies, names, avatars, sponsorship, quotes,
attachments and custom gates are outside this measurement. It measures data
readiness, not when pixels appear. Following feeds, deletion-heavy history,
chain advancement and contention need separate workloads.

## Results

Each phase records host API requests by route, response bytes, data-ready and
settled time, and actual RPC calls at the host's private node boundary. The
last counter includes any concurrent background follower polling. Unexpected
application endpoints, upstream failures and incomplete counts fail the run.
Vite startup, fixture creation and ingestion are outside the page timings.

The [baseline](baseline.json) records the source revision and whether the tree
was modified. With 25 ms added per leg, the indexed implementation measured:

| View | Requests | Data ready | Upstream during read |
|---|---:|---:|---:|
| Cold home tab | 1 feed | 34–35 ms | 0 |
| Home refresh | 1 changes | 28–29 ms | 0 |
| Cold thread tab | 1 message, 1 replies | 62 ms | 0 |
| Thread refresh | 1 changes, 1 message | 57 ms | 0 |

Counts and card gate reads caused no additional requests. Ingestion still
requires node work; its measured startup time is retained in each sample.
These small fixed-history samples establish the request shapes, not a capacity
claim. Use the load test for concurrency and a larger journal for startup/RAM
measurements.

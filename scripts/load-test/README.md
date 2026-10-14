# Deployed-site load test

This is a stateful backend workload using the **actual deployed site's public
HTTPS endpoints**. It reads the chain configuration from `/api/status`, sends
bounded page, message, change, membership and receipt reads through the host
API, self-paid transactions through `public_rpc_url`, signed posts through
`/api/relay`, and bytes through `/api/publish` and `/api/content`. The wallet
RPC may be on another origin; application reads stay on the host.
There is no private Anvil bypass, funding, chain reset, cache deletion, or
automatic change to sponsor membership.

It creates visible posts marked with a unique load-test run identifier. Run it
on the prototype with the funded test accounts. Each user has its own
feed cursors, content cache and nonce allocator. Only the catalogue of
test-owned conversations is shared. The runner never replies to unrelated
visitors' posts, though its public feed reads can include them.

## Prerequisites

- Node **24+** and `npm ci` in `web/`. No new npm dependency is needed.
- The test mnemonic in a file readable only by its owner (`chmod 600`). Run
  the generator on the machine holding it; do not copy it into this repository
  or pass the phrase on a command line.
- Accounts funded on their assigned chains. Derivation is
  `m/44'/60'/0'/0/index`, beginning at `--offset` (default zero).
- For sponsored runs, those addresses must already belong to the relayer's
  advertised sponsor list. The preflight writes `accounts.json` and
  `preflight.json`, identifying missing membership or funding. Use the existing
  list management UI to enroll them. Seed publications are self-paid.

The following examples run from `web/`. Replace `/path/to/test.mnemonic` with
the existing private file. Output directories must be new; the runner refuses
to overwrite a previous run. `load-results/` is ignored by Git.

## Check the site, then the accounts

```sh
npm run load-test -- check \
  --site https://blohard.social --chains 810337

npm run load-test -- check \
  --site https://blohard.social --chains 810337 \
  --mnemonic-file /path/to/test.mnemonic --users 100 --sponsored 0.5
```

These commands only read. Without the mnemonic, the check verifies endpoints,
chain identity, deployed code and a ready host index, but cannot check
account funding or membership. A funding check requires at least 0.01 ETH;
that is a startup check, not a guarantee that a long run fits an account's
balance. `--max-fee-gwei` caps transaction execution fees, not chain-specific
additional data fees.

## Seed conversations

```sh
npm run load-test -- seed \
  --site https://blohard.social --chains 810337 \
  --mnemonic-file /path/to/test.mnemonic --users 100 \
  --roots 20 --wide 100 --deep-chains 3 --depth 100 --moderation \
  --out load-results/seed-a
```

This makes 20 roots, 100 direct replies distributed across three popular roots,
and three more roots each with a **100-level reply chain**. Authors alternate.
`--moderation` deletes and removes two interior replies in each deep chain
after their descendants exist, leaving the tip open. It only changes messages
created by this setup. Omit the flag for an entirely live fixture.

The fixture is saved after each publication. If setup fails, stop and audit
that run before starting another seed; seeding again creates additional posts.
Use its `fixtures.json` for later runs. Every fixture message is checked against
the current Board before reuse, including after a same-chain-ID reset.

Seeding does **not** advance empty blocks or fabricate old timestamps. To measure index growth, use a larger seed (`--wide`, `--max-posts`) or
let later test runs create history. Report the indexed message count and
startup time separately; page traffic no longer walks historical blocks.

## Smoke test, then ramp to 100

```sh
npm run load-test -- run \
  --site https://blohard.social --chains 810337 \
  --mnemonic-file /path/to/test.mnemonic \
  --fixtures load-results/seed-a/fixtures.json \
  --users 5 --duration 2m --sponsored 0 --max-posts 10 \
  --out load-results/smoke-a

npm run load-test -- run \
  --site https://blohard.social --chains 810337 \
  --mnemonic-file /path/to/test.mnemonic \
  --fixtures load-results/seed-a/fixtures.json \
  --users 100 --ramp 10:5m,25:5m,50:5m --duration 30m \
  --sponsored 0.5 --max-sponsored 1500 --sponsored-per-author 15 \
  --max-posts 2500 --max-depth 300 --burst read \
  --out load-results/mixed-a
```

The ramp is **in addition to** the 30-minute steady stage. Actions are jittered;
the default user reads every 15 seconds and publishes every two minutes, with
60% of publications replying to other authors. About a quarter of reply
selections prefer extending deep-chain tips; their depth can grow to 300.
Other replies concentrate on a few roots or branch off existing conversations.
No thread-depth recursion is used in the driver. If no eligible reply target
exists, the user starts a new conversation instead.

Users browse feeds (40%), threads/ancestor links (35%), profiles (15%), and
notifications (10%). Feeds and references read pages of twenty, stopping after
enough visible rows or eight pages. Refreshes consume bounded change pages;
notification bodies are fetched only for the resulting visible references.
Ten percent of
publications include a distinct valid PNG, around 64–192 KiB by default.
`--attachments 0` disables images. `--image-bytes` sets the central image size;
the full range must fit the host's advertised cap.

Budget limits skip further affected publication opportunities and record why;
they never silently switch sponsored work to self-paid work. Skips and missed
schedule slots appear in the report. The relayer's per-author limit is per
chain; its global limit spans both chains. The advertised remaining global
budget is checked, but another run or visitor can consume quota after that
check. Use a separate budget or self-paid mode for a longer soak.

`--burst read` makes all users refresh together after the steady stage.
`--burst post` submits one publication per user together, subject to the same
budget. No burst is the default. `Ctrl-C` stops scheduling, lets bounded
in-flight actions settle, then audits. Unknown self-paid sends pause that user
so it cannot accidentally reuse or skip a transaction nonce.

For both chains, use `--chains 810337,810338` in setup and the run. Users are
assigned round-robin: 100 means **100 total**, not 100 on each chain. Each user
stays on its assigned chain for the run. Run one chain first to concentrate
pressure on its relayer send lock.

## Recovery and verification

Before broadcast, each publication's body, attachments, signed request or raw
transaction are saved in an owner-only `pending/*.json` file. These contain
replayable signatures; keep the entire output directory private. They do not
contain the mnemonic or private keys. Recovery only reuses that exact signed
request or raw transaction, never a freshly signed replacement.

The relayer's explicit `outcome` field decides whether a refusal is definitive.
Unknown or unreadable answers stay uncertain. A temporary refusal (429 or 503)
can retry; another refused answer stops resubmission. A later refusal never
erases an earlier uncertain send. Known transaction hashes go to the host's
receipt endpoint. Without a hash, an author/hash lookup starts at the accepted
head captured before signing and advances only after a successful cursor walk.
Successful transactions are checked for exactly one canonical `Posted` event
with the expected author, parent, parent author and body hash. The host must then serve the same immutable commitment from its accepted
index. Early uploads run while the receipt is pending. A publication is complete only after fresh
HTTP downloads hash correctly, including attachments; a held upload is not
counted as success.

```sh
npm run load-test -- audit \
  --site https://blohard.social --chains 810337 \
  --run-dir load-results/mixed-a

# Explicitly resend unresolved material and retry uploads:
npm run load-test -- audit \
  --site https://blohard.social --chains 810337 \
  --run-dir load-results/mixed-a --recover
```

Audits need no mnemonic. Read-only is the default; `--recover` permits writes
using the saved material. A separate host lookup pass checks for duplicate commitments, including
deleted posts. A reply-page pass checks that each verified live reply appears
exactly once beneath its parent, and that deleted and removed replies are absent. These checks exercise different host
queries; they are not an independent verification of the index against a node.
Refusals, failed
transactions, unavailable content and unresolved sends are distinct outcomes.
A run exits nonzero for failed actions, an interrupted run or an incomplete
audit. Its report still gets written. Definitively refused publications stay
refused; an expired signature can still be reconciled and its bytes uploaded
if its earlier transaction landed.

## Reports and server measurements

Each run records configuration, source revision, deployed addresses and Node
version in `run.json`. Results include:

- `summary.json`: action counts, misses/skips, maximum observed depth, audit
  totals and latency distributions by phase, chain and outcome.
- `metrics.csv`: p50/p95/p99, samples and downloaded bytes, including JSON-RPC
  errors inside HTTP 200. Individual HTTP attempts are measured separately.
- `generator.csv`: generator CPU, RSS, heap and event-loop delay over time.
- `events.jsonl`: timestamped measurements and actions for further analysis.
- `audit.json`: every journaled publication's outcome, plus duplicate checks.
- `fixtures.json`: the previous fixture plus this run's successful messages,
  reusable by a later run.

Rebuild the report without making any network calls:

```sh
npm run load-test -- report --run-dir load-results/mixed-a
```

Percentiles with few samples are descriptive, not reliable tail estimates.
Page timings include the host-provided counts and requested bodies; counts
need no background scans. Thread timings include the immediate parent. A single slow user
cannot accumulate an unbounded queue: missed arrival slots and scheduling lag
are recorded so overload cannot quietly masquerade as lower offered traffic.
An event can appear before its upload. Those reads show a placeholder and
increment `missingContent`, without failing the whole feed action; the HTTP
404 remains in the request measurements. Such a page timing measures readiness
with placeholders, not arrival of every body. The publication audit requires
all bodies and attachments to become retrievable.

The generator's CSV alone does not describe server resource use. On the
server, a sampler (our deployment keeps one beside its operations scripts) records the services every few seconds into a CSV
with nothing but `/proc`, `curl` and `python3`: CPU and resident memory per
service, per-process and whole-disk bytes, each chain's index checkpoint
against the node's head (ingestion lag), holding occupancy, the host's
upstream call and busy counters by class, and the relayer's pending and
settled counts. Start it before a run and stop it after:

```sh
host-metrics.sh --out load-results/mixed-a/host.csv --interval 5
```

Record block production, confirmation depth and server configuration
alongside the run. Index ingestion, query admission and relayer send queues
are separate costs; the CSV shows each at its own boundary.

## Fidelity and limits

This is a protocol workload with independent user state, **not execution of
the Svelte UI**. It models bounded indexed pages, incremental changes, ancestor reads, content
hashing, counts and posting. The page grouping
is approximate: one visible representative per connected conversation, rather
than the client's exact groups and inlined chains. Deleted and removed
messages are omitted from lists but kept as immediate parent context.
Wanted-author descendants beneath deleted or removed replies are not
promoted by this model. Profiles combine an author's posts and replies.
These differences must be considered when comparing request totals with real
browsers; use a small browser cohort to verify rendering and deep navigation.

Body and image caches are per user and each bounded by `--body-cache` records
(default 1,000); eviction is intentional for long soaks. Only verified image
hashes are retained, since the generator does not decode or paint images.
Feed history grows as users
load more, as in the client. Counts and gates arrive with indexed records and changes. The model polls the user's last home feed every 30 seconds even
while visiting another view; it is a modest upper bound on the UI's visible-tab
polling. A refresh remains a separate user action. Name/avatar resolution,
wallet extension prompts, cross-chain mentions, arbitrary gate execution,
faucet traffic and browser painting are not part of this version.

Reads use one attempt; posting uses up to four sends of the same material with
backoff, and uploads retry short-lived lag and overload up to three times.
This deliberate policy exposes first-attempt failures without multiplying
transport retries. It approximates the client's longer pending-list recovery,
not its exact timing. No automatic fee bump is made for stuck transactions.

No workload action resets the index or content store. A host restart replays
its journal into RAM. Measure backfill and replay separately on an isolated
store; indexed queries require ingestion to finish first. Delay/failure
injection, external browser probes and larger histories are separate controlled
additions. Fault-free
publication verification does not promise crash durability beyond the host's
documented batched disk commits.

## Local scenarios

`node scripts/load-test/local.mjs [names] [patience] [together] [posting] [uploads] [funds]` runs
scenarios for choosing the host's and relayer's concurrency numbers, each on a
disposable stack (a fresh Anvil chain, host, relayer and proxies on loopback,
temporary data); nothing reaches a deployed site. Results go to
`load-results/local-<time>/results.json`. The host gets enough upstream budget
that its concurrency limits, not its call budget, decide.

- `names`: 300 readers open a feed of 20 authors no one asked about before
  (about 1,400 addresses), then open it again, behind a name upstream that
  answers after 50 and then 200 ms. A fifth of the authors have an ENS name
  and a fifth a Basename, each with an avatar; every answer is checked.
  Readers ask as the web client does: two lanes, and retries 2, 5, 10 and 20
  seconds after a 429 or 503.
  Busy answers are counted by how they came: at once, when 96 distinct
  addresses were already waiting, or after three seconds without a slot.
- `patience`: the same cold burst behind a 200 ms upstream, with the client's
  earlier single retry after two seconds and then with its current retries.
- `together`: 30 self-paid users post (half with an image) with every chain
  read delayed 150 ms, alone and then during a cold name burst, since names
  share the host's client chain-call slots with receipts and upload checks.
- `posting`: 50 users post (70% sponsored, a fifth with an image) and read for
  a minute while every chain read of the host and relayer waits 0, then 150 ms.
- `uploads`: 20 self-paid users post every five seconds while 0, 8 and then 16
  slow clients each trickle 1 MiB at 32 KiB/s: text posts, whose bodies use
  the host's small upload pool, then posts each with an image, which share
  the large pool with the slow clients.
- `funds`: the relayer refuses every send for low funds while its
  pending-count read takes three seconds, and eight sponsored posts arrive at once.

## Code and tests

- `support.mjs`: options, scheduling, output and measurement.
- `protocol.mjs`: public routes, signing, exact-byte uploads and reconciliation.
- `reader.mjs`: each user's browsing state.
- `workload.mjs`: setup, users, conversation selection, scheduling and auditing.
- `../load-test.mjs`: CLI and offline report.

Run `node --test scripts/load-test.test.mjs` from `web/` for the focused suite,
or `npm test` for it alongside the client tests. The tests use disposable local
files and a localhost mock server; they do not contact the deployed website.

For real transactions, build the contracts (`forge build` in `lib/protocol` and
`lib/account-keys`), name a host and a relayer binary as `BLOHARD_HOST_BIN` and
`BLOHARD_RELAY_BIN` (scripts/integration/README.md), then run
`node scripts/load-test/e2e.mjs` from this directory. It starts and removes a
disposable local Anvil, host, relayer and proxy, verifies a 100-level chain,
simulates 100 readers, and deliberately loses a successful relayer response.
Every command there passes `--forwarded-ips`: all simulated users share this
process's sockets, so each user's requests carry an address of its own in
`x-forwarded-for`, which the host trusts only from a loopback proxy, and the
host's per-visitor limits apply per user as they would to real visitors. An
audit checks each publication from an address of its own. Behind the deployed
site's proxy the header is replaced with the generator's address, so the flag
changes nothing there.
It also runs `scripts/sponsored-e2e.mjs` against that stack: a member posts
through the relayer, then deletes the post with a wallet-paid transaction. It
uses Anvil's public development mnemonic only on that disposable chain.

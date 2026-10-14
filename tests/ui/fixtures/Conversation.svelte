<script>
  // Mount the real row with explicit props. Requests still pass
  // through the browser suite's HTTP fixture; no app modules are substituted.
  import { rememberMessages } from '../../../src/lib/messages'
  import { gates as ledger } from '../../../src/lib/gates.svelte'
  import { record } from '../../../src/lib/api'
  import { replying } from '../../../src/features/publishing/replying.svelte'
  import ConversationRow from '../../../src/features/streams/ConversationRow.svelte'
  import { RowExpansion, expansionOf } from '../../../src/features/streams/stream-expansion'

  let { chain, at, gates = [], root, cards = [], counts = [], editor = 1 } = $props()
  // Feed pages provide gate snapshots independently of cached message records.
  ledger.observe(chain, at, gates.map(record))
  const id = BigInt(root.id)
  const row = {
    root: { ...root, id, post: root.post ? record(root.post) : undefined },
    cards: cards.map(card => ({ ...card, post: record(card.post) })),
  }
  rememberMessages(chain, at, [...(row.root.post ? [row.root.post] : []), ...row.cards.map(card => card.post)])
  const page = { counts: new Map(counts.map(([id, count]) => [BigInt(id), count])) }
  const rowx = new RowExpansion(expansionOf('mounted-row'), id)
  const box = replying.box()
</script>

<main class="column">
  <ConversationRow {chain} {row} {page} {rowx} />
  <button onclick={() => box.open(chain.id, BigInt(editor))}>open editor</button>
  <button onclick={() => box.open(chain.id, id)}>open root editor</button>
  <button onclick={() => box.detach()}>close editor</button>
</main>

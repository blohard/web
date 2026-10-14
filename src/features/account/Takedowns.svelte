<script lang="ts">
  // The admin's takedown list. The host never publishes it, so it is shown
  // only after the admin signs to see it. A post link is looked up into the
  // exact hashes of its text and attachments, each chosen on its own and shown
  // as it is, text or picture; the admin confirms the exact hashes before
  // signing.
  import { onDestroy } from 'svelte'
  import type { Hex } from 'viem'
  import { host } from '../../lib/host.svelte'
  import { readTakedowns, saveTakedowns, type Takedowns } from '../../lib/host-policy'
  import { readMessage } from '../../lib/messages'
  import { fetchContent, utf8, type Anchor } from '../../lib/store'
  import { decode, isInlineImage, TEXT } from '../../lib/envelope'
  import { wallet } from '../../lib/wallet.svelte'
  import { attachmentHashes, parseTakedownInput } from './takedown-input'
  import { explain } from '../../lib/errors'

  /** A hash the admin may take down, with what it holds: a picture, words or a note. */
  type Candidate = { hash: Hex; label: string; selected: boolean; picture?: string; words?: string; note?: string }

  let list = $state<Takedowns | null>(null)
  let input = $state('')
  let candidates = $state<Candidate[]>([])
  let confirming = $state(false)
  let busy = $state(false)
  let note = $state<{ error: boolean; text: string } | null>(null)
  let selected = $derived(candidates.filter(c => c.selected).map(c => c.hash))

  /** Pictures are shown through object URLs, released whenever the candidates change. */
  function release() {
    for (const c of candidates) if (c.picture) URL.revokeObjectURL(c.picture)
  }
  onDestroy(release)

  const excerpt = (words: string) => words.length > 600 ? `${words.slice(0, 600)}…` : words

  /** What a hash holds, read through this host as a reader would. */
  async function describe(hash: Hex, anchor?: Anchor): Promise<Pick<Candidate, 'picture' | 'words' | 'note'>> {
    const content = await fetchContent(hash, anchor)
    if (!content.ok) {
      return { note: content.reason === 'taken_down' ? 'already taken down' : content.reason === 'missing' ? 'not on this host' : 'could not be read' }
    }
    const decoded = decode(content.bytes)
    if (!decoded.ok) return { note: 'unrecognized content' }
    const type = decoded.envelope.mediaType
    // The whole text: its attachments are found in it. Only the excerpt shown is cut.
    if (type === TEXT) return { words: utf8.decode(decoded.envelope.body) }
    if (isInlineImage(type)) return { picture: URL.createObjectURL(new Blob([decoded.envelope.body.slice()], { type })) }
    return { note: type }
  }

  async function act(start: string, work: () => Promise<string>) {
    if (busy) return
    busy = true
    note = { error: false, text: start }
    try { note = { error: false, text: await work() } }
    catch (e) { note = { error: true, text: explain(e) } }
    finally { busy = false }
  }

  function show() {
    void act('approve in your wallet to see the list…', async () => {
      list = await readTakedowns(wallet)
      return ''
    })
  }

  /** A post link becomes its text and each attachment it names; a hash or content link stays itself. */
  function lookUp() {
    void act('looking up…', async () => {
      confirming = false
      release()
      candidates = []
      const target = parseTakedownInput(input.trim())
      if (!target) throw new Error('paste a post link or a content hash')
      if (target.kind === 'hash') {
        candidates = [{ hash: target.hash, label: 'this content', selected: true, ...await describe(target.hash) }]
        return ''
      }
      const chain = host.chain(target.chainId)
      if (!chain) throw new Error('this host does not serve that chain')
      const { record } = await readMessage(chain, target.id)
      const anchor = { chainId: chain.id, messageId: record.id }
      const hash = record.contentHash.toLowerCase() as Hex
      const body = await describe(hash, anchor)
      const found: Candidate[] = [{ hash, label: "the post's text", selected: true, ...body }]
      if (body.words === undefined) {
        candidates = found
        return "the post's text could not be read here, so its attachments are not listed"
      }
      // A post may name any record as an attachment, another post's text or
      // picture included, so only what was asked about starts ticked.
      for (const [i, attachment] of attachmentHashes(body.words).entries()) {
        found.push({ hash: attachment, label: `attachment ${i + 1}`, selected: false, ...await describe(attachment, anchor) })
      }
      candidates = found
      return ''
    })
  }

  function takeDown() {
    if (!list || !selected.length) return
    const revision = list.revision, hashes = selected
    void act('approve the takedown in your wallet…', async () => {
      list = await saveTakedowns(wallet, revision, 'add', hashes)
      release()
      candidates = []
      input = ''
      confirming = false
      return 'taken down'
    })
  }

  function restore(hash: Hex) {
    if (!list) return
    const revision = list.revision
    void act('approve the restore in your wallet…', async () => {
      list = await saveTakedowns(wallet, revision, 'remove', [hash])
      return 'restored'
    })
  }
</script>

<section>
  <div class="listhead">
    <h2>taken down content</h2>
    <p class="dim small">this host neither serves nor accepts these exact bytes, in any post. the posts stay listed and show removed by this host. a changed copy has a different hash and needs its own takedown. only you can see this list.</p>
    {#if !list}
      <button onclick={show} disabled={busy}>sign to see the list</button>
    {:else}
      <label class="small" for="takedown-input">post link or content hash</label>
      <div class="row small">
        <input id="takedown-input" class="grow" bind:value={input} disabled={busy} placeholder="a post link or 0x hash" />
        <button onclick={lookUp} disabled={busy || !input.trim()}>look up</button>
      </div>
      {#if candidates.length}
        <ul class="candidates small">
          {#each candidates as candidate (candidate.hash)}
            <li>
              <label>
                <input type="checkbox" bind:checked={candidate.selected} disabled={busy || confirming} />
                {candidate.label}{#if candidate.note}<span class="dim">{` (${candidate.note})`}</span>{/if}
              </label>
              {#if candidate.words !== undefined}<blockquote class="words">{excerpt(candidate.words)}</blockquote>{/if}
              {#if candidate.picture}<img class="picture" src={candidate.picture} alt={candidate.label} />{/if}
              <code>{candidate.hash}</code>
            </li>
          {/each}
        </ul>
        {#if !confirming}
          <button onclick={() => confirming = true} disabled={busy || !selected.length}>review takedown</button>
        {:else}
          <p class="small">every copy of these bytes stops being served by this host, in any post that uses them.</p>
          <ul class="small">
            {#each selected as hash (hash)}<li><code>{hash}</code></li>{/each}
          </ul>
          <div class="row small">
            <button class="danger" onclick={takeDown} disabled={busy}>take down</button>
            <button onclick={() => confirming = false} disabled={busy}>cancel</button>
          </div>
        {/if}
      {/if}
    {/if}
    <p class="operation-status small" role="status" class:err={note?.error}>{note?.text ?? ''}</p>
  </div>
  {#if list}
    {#each list.hashes as hash (hash)}
      <div class="taken row small">
        <code class="grow">{hash}</code>
        <button onclick={() => restore(hash)} disabled={busy}>restore</button>
      </div>
    {:else}<p class="dim">nothing is taken down.</p>{/each}
  {/if}
</section>

<style>
  section { margin-bottom: 2rem; }
  section > p { padding: 0 1rem; }
  .listhead { padding: 0.8rem 1rem; }
  h2 { font-size: 1rem; }
  .candidates { list-style: none; padding: 0; }
  .candidates li { margin: 0.6rem 0; }
  .words { margin: 0.3rem 0; padding: 0.4rem 0.6rem; border-left: 2px solid var(--border); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 12rem; overflow: auto; }
  .picture { display: block; max-width: 12rem; max-height: 12rem; margin: 0.3rem 0; border: 1px solid var(--border); }
  code { word-break: break-all; }
  .taken { padding: 0.4rem 1rem; }
</style>

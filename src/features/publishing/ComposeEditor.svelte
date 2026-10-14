<script lang="ts">
  // Text editing and the mention picker. The shared draft box owns the text
  // and references; only caret, selection and picker state belong to this mount.
  import { untrack } from 'svelte'
  import type { Address } from 'viem'
  import type { DraftBox } from './draft-box.svelte'
  import { follows } from '../../lib/follows.svelte'
  import { atWord, type Mentions } from '../../lib/mentions'
  import { names } from '../../lib/names.svelte'
  import { people } from '../../lib/people'
  import { sameAddress, shortAddress } from '../../lib/format'
  import { wallet } from '../../lib/wallet.svelte'
  import Avatar from '../../components/Avatar.svelte'

  let { owner, disabled, rows, placeholder, dragging = $bindable(false), onfiles, onsubmit }: {
    owner: DraftBox
    disabled: boolean
    rows: number
    placeholder: string
    dragging?: boolean
    onfiles: (files: FileList | null) => void
    onsubmit: () => void
  } = $props()
  const pickerId = $props.id()
  const box = untrack(() => owner)
  let text = $derived(box.draft.text)
  let mentions = $derived<Mentions>({ ...box.draft.mentions })
  let textarea = $state<HTMLTextAreaElement | null>(null)
  const report = () => box.edit({ ...box.draft, text, mentions: { ...mentions } })

  /** The @word under the caret while the picker is open: where it starts and what has been typed. */
  let mentionAt = $state<{ start: number; query: string } | null>(null)
  let pickerIndex = $state(0)

  type Candidate = { address: Address; label: string }
  /** People you follow, you, and recent authors, filtered by what was typed after the @. */
  let candidates = $derived.by((): Candidate[] => {
    if (!mentionAt) return []
    const q = mentionAt.query.toLowerCase()
    const pool: Address[] = []
    for (const a of [...(wallet.account ? [wallet.account] : []), ...follows.addresses, ...people.recent()]) {
      if (!pool.some((x) => sameAddress(x, a))) pool.push(a)
    }
    const out: Candidate[] = []
    for (const address of pool) {
      const label = names.display(address)
      if (q && !(label.toLowerCase().startsWith(q) || address.toLowerCase().startsWith(q))) continue
      out.push({ address, label })
      if (out.length === 6) break
    }
    return out
  })
  // Names can arrive while the picker is open and shrink the filtered list.
  let selectedIndex = $derived(Math.min(pickerIndex, Math.max(0, candidates.length - 1)))

  /** Is the caret right after `@something`? Called on every edit and caret move. */
  function trackMention() {
    if (!textarea) return
    const next = atWord(text, textarea.selectionStart ?? text.length)
    if (!next || !mentionAt || next.start !== mentionAt.start || next.query !== mentionAt.query) pickerIndex = 0
    mentionAt = next
  }

  function choose(c: Candidate) {
    if (!mentionAt || !textarea) return
    const caret = textarea.selectionStart ?? text.length
    const insert = `@${c.label} `
    text = text.slice(0, mentionAt.start) + insert + text.slice(caret)
    mentions = { ...mentions, [c.label]: c.address }
    report()
    const at = mentionAt.start + insert.length
    mentionAt = null
    queueMicrotask(() => {
      textarea?.focus()
      textarea?.setSelectionRange(at, at)
    })
  }

  function onKeydown(e: KeyboardEvent) {
    // Cmd or Ctrl with Enter posts, as in most compose boxes.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onsubmit()
      return
    }
    if (!mentionAt || candidates.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = candidates.length
      pickerIndex = (selectedIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      choose(candidates[selectedIndex])
    } else if (e.key === 'Escape') {
      mentionAt = null
    }
  }

  // Grow with the text up to the stylesheet's ceiling, then scroll inside the box.
  $effect(() => {
    void text
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }
  })

  function onPaste(e: ClipboardEvent) {
    const files = e.clipboardData?.files
    if (!files || files.length === 0) return
    e.preventDefault()
    onfiles(files)
  }
</script>

<div class="compose-row" role="group"
  ondragover={(e) => { e.preventDefault(); dragging = true }}
  ondragleave={() => (dragging = false)}
  ondrop={(e) => { e.preventDefault(); dragging = false; onfiles(e.dataTransfer?.files ?? null) }}
>
  {#if wallet.account}
    <Avatar address={wallet.account} size={36} />
  {/if}
  <textarea
    bind:this={textarea}
    bind:value={text}
    disabled={disabled}
    rows={rows}
    placeholder={placeholder}
    onpaste={onPaste}
    oninput={(e) => {
      text = e.currentTarget.value
      trackMention()
      report()
    }}
    onclick={trackMention}
    onkeyup={(e) => (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') && trackMention()}
    onkeydown={onKeydown}
    onblur={() => (mentionAt = null)}
    aria-autocomplete="list"
    aria-controls={mentionAt && candidates.length ? pickerId : undefined}
    aria-activedescendant={mentionAt && candidates.length ? `${pickerId}-${selectedIndex}` : undefined}
  ></textarea>
</div>
{#if mentionAt && candidates.length}
  <ul class="picker small" role="listbox" id={pickerId}>
    {#each candidates as c, i (c.address)}
      <li role="presentation">
        <button role="option" id={`${pickerId}-${i}`} aria-selected={i === selectedIndex} tabindex="-1" class:active={i === selectedIndex} onmousedown={(e) => e.preventDefault()} onclick={() => choose(c)}>
          <Avatar address={c.address} size={18} />
          <span>{c.label}</span>
          {#if c.label !== shortAddress(c.address)}<span class="dim">{shortAddress(c.address)}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
{/if}

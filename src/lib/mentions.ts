// The @ grammar of the composer, in one place: where an @word is being typed,
// which picked labels are still in the text, and how they become references
// (the protocol spec §7, account://) when the post is sent.
import type { Address } from 'viem'

/** Picked labels and who they stand for. Only these become references; anything typed by hand stays text. */
export type Mentions = Record<string, Address>

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `@label` as a word of its own: not inside another word, not already inside a link. */
function pattern(label: string, flags = ''): RegExp {
  return new RegExp(`(^|[^\\w\\]])@${escape(label)}(?![\\w.\\-])`, flags)
}

/** The @word the caret sits at the end of, if any: where its @ is, and what follows it so far. */
export function atWord(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([\w.\-]*)$/.exec(text.slice(0, caret))
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null
}

/** The picked people whose @label is still in the text. */
export function present(text: string, mentions: Mentions): [string, Address][] {
  return Object.entries(mentions).filter(([label]) => pattern(label).test(text))
}

/** Every picked `@label` becomes `[@label](account://0x…)`; longer labels first, so one is never a prefix of another's match. */
export function linkify(text: string, mentions: Mentions): string {
  let out = text
  for (const label of Object.keys(mentions).sort((a, b) => b.length - a.length)) {
    out = out.replace(pattern(label, 'g'), `$1[@${label}](account://${mentions[label].toLowerCase()})`)
  }
  return out
}

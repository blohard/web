// A composer's draft survives its mounts. A completion may clear only the
// version it sent, and may unlock only its own send, never a newer one.
import { zeroAddress, type Address } from 'viem'
import type { Mentions } from '../../lib/mentions'
import type { PostRecord } from './pending'

export type Draft = { text: string; mentions: Mentions; attachments: PostRecord[] }
export const emptyDraft = (): Draft => ({ text: '', mentions: {}, attachments: [] })

export class DraftBox {
  draft = $state.raw<Draft>(emptyDraft())
  private rule = $state.raw<{ context: string; gate: Address } | null>(null)
  replyGate(context: string): Address { return this.rule?.context === context ? this.rule.gate : zeroAddress }
  setReplyGate(context: string, gate: Address): void {
    this.rule = { context, gate }
    this.version++
  }
  version = 0
  private flight = $state<number | null>(null)
  private editSession = 0

  get sending(): boolean { return this.flight !== null }

  edit(draft: Draft): number {
    this.draft = draft
    return ++this.version
  }

  begin(): number {
    this.editSession++
    this.flight = this.version
    return this.version
  }

  holds(version: number): boolean { return this.version === version }

  /** Delayed input may merge with typing, but not with a reset or a submitted draft. */
  guardEdit(): () => boolean {
    const session = this.editSession
    return () => session === this.editSession && !this.sending
  }

  /** Drop only the submitted draft. A newer edit stays, but this send stops locking it. */
  finish(version: number): boolean {
    const held = this.holds(version)
    if (held) this.clear()
    else this.fail(version)
    return held
  }

  fail(version: number): void {
    if (this.flight === version) this.flight = null
  }

  clear(): void {
    this.editSession++
    this.draft = emptyDraft()
    this.rule = null
    this.flight = null
    this.version++
  }
}

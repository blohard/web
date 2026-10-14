import { sharedKeyring, type Keyring } from '../keys/keyring'
import type { Address } from 'viem'
import type { ChainInfo } from '../../lib/types'
import { explain } from '../../lib/errors'
import { pollVisible } from '../../shared/visible-poll'

// Polls update the refresh cue. Only an initial load or a requested refresh
// replaces the membership snapshot used by the displayed stream.
export class KeyringView {
  shown = $state<Keyring | null>(null)
  latest = $state<Keyring | null>(null)
  error = $state('')

  /** First load and explicit refresh apply a snapshot and call `applied`; returns and polls only cue changes. */
  watch(chain: ChainInfo, holder: Address, market: Address, selected: boolean, apply = true, applied?: () => void): () => void {
    let applyNext = apply || this.shown === null
    // Navigation may already have read it. Later polls always ask the host.
    return pollVisible(() => sharedKeyring(chain, holder, market, !applyNext), result => {
      this.observe(result, applyNext)
      if (applyNext) applied?.()
      applyNext = false
    }, error => { this.error = explain(error) }, selected ? 30_000 : 300_000)
  }

  observe(value: Keyring, apply: boolean) {
    this.error = ''
    this.latest = value
    if (apply || !this.shown) this.shown = value
  }

  get available() { return !!this.latest && (this.latest.active || this.latest.holding.length > 0) }
  changed(side: 'holders' | 'holding') {
    if (!this.shown || !this.latest) return false
    return this.shown.active !== this.latest.active || this.shown.truncated[side] !== this.latest.truncated[side] || this.shown[side].join(',') !== this.latest[side].join(',')
  }
}

// A list of addresses the reader keeps in this browser (muted, following):
// stored under one localStorage key, checksummed on the way in, reactive for
// the page. Nothing here is written anywhere but this browser. Every tab
// shares the stored list: a change is applied over what is stored, not over
// what this tab loaded, and another tab's change arrives through the storage
// event, so a tab that loaded the list earlier does not discard what another
// saved since. Simultaneous writes are not serialized; the last one wins.
// When storage cannot be written (blocked, full), the list still works for
// the tab: its unsaved changes stay on top of whatever is stored until a save
// succeeds.
import { getAddress, type Address } from 'viem'
import { sameAddress } from './format'
import { readJSON, writeJSON } from './storage'

/** The stored array, keeping every entry that is an address. */
function parse(raw: unknown): Address[] {
  if (!Array.isArray(raw)) return []
  const out: Address[] = []
  for (const a of raw) {
    try {
      if (typeof a === 'string') out.push(getAddress(a))
    } catch {
      // not an address: leave it out
    }
  }
  return [...new Set(out)]
}

export class AddressList {
  addresses = $state<Address[]>([])
  private readonly key: string
  /** Changes no save has taken yet, by address: in the list or not. */
  private unsaved = new Map<Address, boolean>()

  constructor(key: string, readonly limit = Infinity) {
    this.key = key
    this.addresses = this.current()
    // Fired in every other tab when one writes the key; a cleared store has no key.
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === null || e.key === this.key) this.addresses = this.current()
      })
    }
  }

  /** What is stored, with this tab's unsaved changes on top. */
  private current(): Address[] {
    let list = parse(readJSON<unknown>(this.key, []))
    for (const [addr, wanted] of this.unsaved) {
      list = list.filter((x) => !sameAddress(x, addr))
      if (wanted) list.push(addr)
    }
    return list.slice(0, this.limit)
  }

  has(address: string): boolean {
    return this.addresses.some((x) => sameAddress(x, address))
  }

  get full(): boolean { return this.addresses.length >= this.limit }

  /** Add or remove, judged by what this tab shows. A save that succeeds carries every unsaved change. */
  toggle(address: string) {
    const addr = getAddress(address)
    const adding = !this.has(addr)
    if (adding && this.current().length >= this.limit) {
      this.addresses = this.current()
      return
    }
    this.unsaved.set(addr, adding)
    this.addresses = this.current()
    if (writeJSON(this.key, this.addresses)) this.unsaved.clear()
  }
}

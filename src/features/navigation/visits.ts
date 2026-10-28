// UI state belongs to a visit, not a URL: Back/Forward restore it, ordinary
// links start fresh; sidebar links copy the most recent retained visit.
// The page arrow copies its predecessor with its position, leaving browser history intact.
// Only a marker goes into browser history; records stay
// in this tab and a reload, or eviction of an old visit, forgets them.
export class Visit {
  private values = new Map<string, { value: unknown; copy: (value: unknown, keepPosition: boolean) => unknown }>()

  constructor(readonly id: number, public page = '', public url = '', readonly previous: number | null = null) {}

  /** Every caller explicitly copies its view state or shares retained data with the new entry. */
  state<T>(key: string, initial: () => T, copy: (value: T, keepPosition: boolean) => T): T {
    if (!this.values.has(key)) this.values.set(key, { value: initial(), copy: (value, keepPosition) => copy(value as T, keepPosition) })
    return this.values.get(key)!.value as T
  }

  resume(id: number, previous = this.previous, keepPosition = false): Visit {
    const visit = new Visit(id, this.page, this.url, previous)
    for (const [key, saved] of this.values) visit.values.set(key, { ...saved, value: saved.copy(saved.value, keepPosition) })
    return visit
  }
}

type Entry = { session: string; visit: number }

export class Visits {
  private session = Math.random().toString(36).slice(2)
  private serial = 0
  private records = new Map<number, Visit>()
  current = new Visit(0)
  entry: Entry = { session: this.session, visit: 0 }

  constructor(private capacity = 100, page = '', url = '') {
    this.current = new Visit(0, page, url)
    this.records.set(0, this.current)
  }

  /** Hash-only actions on the same page share its state and keep it mounted. */
  move(marker: Entry | null | undefined, samePage: boolean, page = '', resume = false, url = '') {
    // Search the already bounded visit store; no second cache can outlive it.
    const restoring = marker?.session === this.session
    const recent = !restoring && !samePage && resume ? [...this.records.values()].reverse().find(visit => visit.page === page) : undefined
    this.entry = restoring ? marker : {
      session: this.session,
      visit: samePage ? this.current.id : ++this.serial,
    }
    this.current = this.records.get(this.entry.visit) ?? recent?.resume(this.entry.visit, this.current.id) ?? new Visit(this.entry.visit, page, url, restoring ? null : this.current.id)
    // Replacing a profile tab keeps the visit while changing the URL it names.
    this.current.page = page
    this.current.url = url
    this.records.delete(this.current.id)
    this.records.set(this.current.id, this.current)
    if (this.records.size > this.capacity) this.records.delete(this.records.keys().next().value!)
    return this.current
  }

  /** Return through the page trail, but add a browser entry so Back can undo the arrow. */
  returnEntry(): { url: string; entry: Entry } | null {
    const previous = this.current.previous === null ? null : this.records.get(this.current.previous)
    if (!previous) return null
    const visit = previous.resume(++this.serial, previous.previous, true)
    this.records.set(visit.id, visit)
    return { url: visit.url, entry: { session: this.session, visit: visit.id } }
  }
}

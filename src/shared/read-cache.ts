/** Recent completed reads, least recently used first. In-flight work is shared separately and never evicted. */
export class ReadCache<K, V> {
  private ready = new Map<K, { at: number; read: Promise<V> }>()
  private flights = new Map<K, Promise<V>>()

  constructor(private ttl: number, private limit: number, private keep: (value: V) => boolean = () => true) {}

  /** A forced refresh replaces the shared read; only its completion may populate the cache. */
  read(key: K, load: () => Promise<V>, fresh = false): Promise<V> {
    if (!fresh) {
      const pending = this.flights.get(key)
      if (pending) return pending
      const known = this.ready.get(key)
      if (known && Date.now() - known.at < this.ttl) {
        this.ready.delete(key)
        this.ready.set(key, known)
        return known.read
      }
    }
    this.ready.delete(key)
    const at = Date.now()
    const pending = load().then(value => {
      if (this.flights.get(key) === pending && this.keep(value)) {
        this.ready.set(key, { at, read: pending })
        for (const [k, entry] of this.ready) {
          if (Date.now() - entry.at >= this.ttl) this.ready.delete(k)
        }
        while (this.ready.size > this.limit) this.ready.delete(this.ready.keys().next().value!)
      }
      return value
    }).finally(() => {
      if (this.flights.get(key) === pending) this.flights.delete(key)
    })
    this.flights.set(key, pending)
    return pending
  }

  /** Existing readers finish normally, but cannot repopulate or replace reads made after invalidation. */
  clear(): void { this.ready.clear(); this.flights.clear() }
}

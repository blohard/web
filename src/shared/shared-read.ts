/** Share only outstanding work. Success and failure both release the key for a later read. */
export function sharedRead<K, V>(flights: Map<K, Promise<V>>, key: K, read: () => Promise<V>): Promise<V> {
  const existing = flights.get(key)
  if (existing) return existing
  const pending = read().finally(() => { if (flights.get(key) === pending) flights.delete(key) })
  flights.set(key, pending)
  return pending
}

// Best-effort JSON storage. Missing or unreadable values return the fallback;
// failed writes are ignored. Callers own any in-memory copy.

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return (JSON.parse(raw) as T | null) ?? fallback
  } catch {
    return fallback
  }
}

/** Saves, and says whether it did: storage may be unavailable or full, and callers keep their own state. */
export function writeJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** Removes a saved value, reporting unavailable storage just like a write. */
export function removeJSON(key: string): boolean {
  try {
    localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

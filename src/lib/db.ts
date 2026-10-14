// One IndexedDB database for pending uploads, cached
// avatars and nonce allocation. Bump VERSION for schema changes.

const DB = 'blohard-indexed'
const VERSION = 3
// A pending post's record bytes live apart from its progress, keyed [post key, hash],
// so a progress save rewrites no bytes. Posts saved before the split keep theirs inline.
export const STORES = { pending: 'pending', pendingBytes: 'pendingBytes', avatars: 'avatars', nonces: 'nonces' } as const

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORES.pending)) db.createObjectStore(STORES.pending, { keyPath: 'key' })
      if (!db.objectStoreNames.contains(STORES.pendingBytes)) db.createObjectStore(STORES.pendingBytes)
      if (!db.objectStoreNames.contains(STORES.avatars)) db.createObjectStore(STORES.avatars, { keyPath: 'address' })
      if (!db.objectStoreNames.contains(STORES.nonces)) db.createObjectStore(STORES.nonces)
      if (db.objectStoreNames.contains('moderation')) db.deleteObjectStore('moderation')
    }
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close()
      resolve(req.result)
    }
    req.onerror = () => reject(req.error)
  })
}

/** Run one transaction on one store; resolves with the request's result once the transaction completes. */
export function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
  options?: IDBTransactionOptions,
): Promise<T> {
  let result: T
  return across([store], mode, (t) => {
    const req = run(t.objectStore(store))
    if (req) req.onsuccess = () => (result = req.result)
  }, options).then(() => result)
}

/** Run one transaction over several stores: all of its writes land, or none. Resolves once it completes. */
export function across(
  stores: string[],
  mode: IDBTransactionMode,
  run: (t: IDBTransaction) => void,
  options?: IDBTransactionOptions,
): Promise<void> {
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(stores, mode, options)
        t.oncomplete = () => {
          db.close()
          resolve()
        }
        t.onabort = () => {
          db.close()
          reject(t.error)
        }
        try {
          run(t)
        } catch (e) {
          t.abort()
          reject(e)
        }
      }),
  )
}

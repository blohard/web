/** Run each operation after its predecessor, even if that predecessor failed.
 * Every caller gets its own result; this queues work rather than sharing it. */
export class SerialQueue {
  private tail: Promise<void> | null = null

  /** `after` holds the queue after the result is delivered, e.g. for a page's counts. */
  run<T>(work: () => T | Promise<T>, after?: (value: T) => Promise<unknown>): Promise<T> {
    const result = (this.tail ?? Promise.resolve()).then(work)
    const settled = result.then(after).then(() => {}, () => {})
    this.tail = settled
    void settled.then(() => { if (this.tail === settled) this.tail = null })
    return result
  }
}

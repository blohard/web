// Pictures that open on their own (features/messages/record-images.ts) share a few download
// slots, first come first served, so a stream full of them does not start every
// download at once and time some out on a slow link. A picture whose card
// left while it waited never takes a slot.

export class Slots {
  private active = 0
  private waiting: { start: () => void }[] = []

  constructor(readonly size: number) {}

  /** The way to give the slot back, or null when `signal` aborted first. */
  take(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return Promise.resolve(null)
    return new Promise((resolve) => {
      const entry = {
        start: () => {
          signal.removeEventListener('abort', cancel)
          this.active++
          let released = false
          resolve(() => {
            if (released) return
            released = true
            this.active--
            this.waiting.shift()?.start()
          })
        },
      }
      const cancel = () => {
        const at = this.waiting.indexOf(entry)
        if (at >= 0) this.waiting.splice(at, 1)
        resolve(null)
      }
      if (this.active < this.size) entry.start()
      else {
        this.waiting.push(entry)
        signal.addEventListener('abort', cancel, { once: true })
      }
    })
  }
}

/** Every picture that opens on its own, across the page. */
export const pictureSlots = new Slots(4)

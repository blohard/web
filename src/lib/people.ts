// Authors this page has shown recently, most recent first, so the mention
// picker can offer people you have just been reading. Plain module state: it
// is consulted on a keystroke, never rendered on its own.
import type { Address } from 'viem'
import { sameAddress } from './format'

const MAX = 50
const recent: Address[] = []

export const people = {
  note(a: Address) {
    const i = recent.findIndex((x) => sameAddress(x, a))
    if (i === 0) return
    if (i > 0) recent.splice(i, 1)
    recent.unshift(a)
    if (recent.length > MAX) recent.length = MAX
  },
  recent(): Address[] {
    return recent.slice()
  },
}

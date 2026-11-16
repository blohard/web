import { pollVisible } from '../../visible-poll'
export { flushSync } from 'svelte'

type Read = 'input' | 'reader' | 'failure'

/**
 * One effect that follows `input` and opens a poller. The poller's first check
 * reads `reader`; with `throws`, the reader then throws at once and the
 * failure callback reads `failure`.
 */
export function poller(throws: boolean) {
  const state = $state({ input: 0, reader: 0, failure: 0 })
  let opened = 0
  const stop = $effect.root(() => {
    $effect(() => {
      void state.input
      opened++
      return pollVisible<number>(() => {
        const value = state.reader
        if (throws) throw new Error('unreadable')
        return Promise.resolve(value)
      }, () => {}, () => { void state.failure }, 30_000)
    })
  })
  return { get opened() { return opened }, change(read: Read) { state[read]++ }, stop }
}

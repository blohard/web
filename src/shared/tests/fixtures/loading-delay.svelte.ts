import { loadingDelay } from '../../loading-delay.svelte'
export { flushSync } from 'svelte'

export function spinner() {
  let input = $state.raw<{ key: string | null }>({ key: null })
  let ready: () => boolean
  const stop = $effect.root(() => { ready = loadingDelay(() => input.key) })
  return { set(value: string | null) { input = { key: value } }, get ready() { return ready() }, stop }
}

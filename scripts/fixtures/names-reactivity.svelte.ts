import { flushSync } from 'svelte'
import { host } from '../../src/lib/host.svelte'
import { names } from '../../src/lib/names.svelte'

export { flushSync, host, names }
/** How many times a view showing `address`'s name re-ran. */
export function watching(address: string) {
  let runs = 0
  const stop = $effect.root(() => {
    $effect(() => { names.display(address); runs++ })
  })
  return { get runs() { return runs }, stop }
}

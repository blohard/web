import { flushSync } from 'svelte'
import { embedDiscussion } from '../../embed-discussion.svelte'

export { flushSync }
/** The widget's discussion with a load that answers a fresh page each time. */
export function widget() {
  let loads = 0
  let view!: ReturnType<typeof embedDiscussion<{ load: number }>>
  const stop = $effect.root(() => { view = embedDiscussion(async () => ({ load: ++loads })) })
  return {
    refresh: () => view.refresh(),
    back: () => view.returned(),
    get page() { return view.page },
    get folds() { return view.gateRefreshReady },
    stop,
  }
}

// When the embed widget's discussion reloads (features/embed/Embed.svelte). The
// refresh control reloads the page and, once it arrives, rechecks the folds
// of replies already shown; coming back to the tab reloads the page, since the
// reader may have replied in the app, but keeps the verdicts on screen.
import { untrack } from 'svelte'

export function embedDiscussion<T>(load: (reloadRevision: number) => Promise<T>) {
  let reloadRevision = $state(0)
  let refreshRevision = $state(0)
  const page = $derived(load(reloadRevision))
  // The fold checks wait for the page an explicit refresh asked for.
  const gateRefreshReady = $derived.by(() => {
    void refreshRevision
    return untrack(() => page)
  })
  return {
    get page() { return page },
    get gateRefreshReady() { return gateRefreshReady },
    refresh() {
      reloadRevision++
      refreshRevision++
    },
    returned() { reloadRevision++ },
  }
}

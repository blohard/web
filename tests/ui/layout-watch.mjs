// Sample painted-frame geometry, including frames before an async card is ready.
// This intentionally counts movement following clicks too; intended navigation
// is excluded by choosing the card/anchor whose position should stay fixed.
import { expect } from '@playwright/test'

export const frames = (page, count = 4) => page.evaluate(count => new Promise(resolve => {
  function next() { if (--count <= 0) resolve(); else requestAnimationFrame(next) }
  requestAnimationFrame(next)
}), count)

export async function watchLayout(page, ids, { anchor = null } = {}) {
  await page.evaluate(({ ids, anchor }) => {
    const find = id => document.querySelector(`article.msg:has(a[aria-label="open post #${id}"])`)
    const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility === 'visible'
    const samples = []
    let frame
    function sample() {
      const origin = anchor === null ? 0 : find(anchor)?.getBoundingClientRect().top
      samples.push(ids.map(id => {
        const node = find(id)
        if (!visible(node) || origin === undefined) return null
        const r = node.getBoundingClientRect()
        return { y: r.top - origin, height: r.height }
      }))
      if (samples.length < 600) frame = requestAnimationFrame(sample)
    }
    window.finishLayoutWatch = () => { cancelAnimationFrame(frame); return samples }
    sample()
  }, { ids, anchor })
  return async () => {
    await frames(page)
    return page.evaluate(() => window.finishLayoutWatch())
  }
}

export function expectStable(samples, ids) {
  expect(samples.length, 'sampled multiple animation frames').toBeGreaterThan(2)
  ids.forEach((id, i) => {
    const first = samples.findIndex(frame => frame[i] !== null)
    expect(first, `post #${id} was displayed`).toBeGreaterThanOrEqual(0)
    const shown = samples.slice(first).map(frame => frame[i])
    expect(shown.every(Boolean), `post #${id} never disappears after its first visible frame`).toBe(true)
    for (const field of ['y', 'height']) {
      const values = shown.filter(Boolean).map(rect => rect[field])
      expect(Math.max(...values) - Math.min(...values), `post #${id} ${field} stays within one pixel`).toBeLessThanOrEqual(1)
    }
  })
}

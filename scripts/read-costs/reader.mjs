// One fresh client tab, using the app's readers without a browser or a second feed implementation.
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createServer } from 'vite'
import { zeroAddress } from 'viem'

const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
globalThis.location = { origin: config.site }
const cacheDir = await mkdtemp(join(tmpdir(), 'blohard-read-costs-vite-'))
const vite = await createServer({ server: { middlewareMode: true, ws: false }, appType: 'custom', cacheDir })
const realFetch = globalThis.fetch
try {
  const load = (name) => vite.ssrLoadModule(`/src/${name}`)
  const { loadFeed } = await load('features/streams/feed.ts')
  const { readThread, replySlice } = await load('features/streams/replies.ts')
  const { gates } = await load('lib/gates.svelte.ts')
  const status = await (await realFetch(`${config.site}/api/status`)).json()
  const chain = status.chains[0]
  let calls, requests, bytes
  globalThis.fetch = async (url, init) => {
    const target = new URL(url, config.site)
    if (target.origin !== config.site || !target.pathname.startsWith(`/api/chains/${chain.id}/`)) throw new Error(`unexpected reader endpoint: ${target.pathname}`)
    const name = target.pathname.split('/')[4]
    calls[name] = (calls[name] ?? 0) + 1; requests++
    await sleep(config.latency)
    const response = await realFetch(target, init)
    const body = await response.arrayBuffer(); bytes += body.byteLength
    return new Response(body, { status: response.status, headers: response.headers })
  }
  async function card(msg) {
    if (await gates.ensureMessage(chain, msg.id) === zeroAddress) await gates.ensureAuthor(chain, msg.author)
  }
  const samples = []
  for (const phase of ['load', 'refresh']) {
    await realFetch(`${config.counter}/begin`)
    calls = {}; requests = 0; bytes = 0
    const start = performance.now()
    let ready, visible
    if (config.view === 'home') {
      const page = await loadFeed(chain, { kind: 'timeline' })
      ready = performance.now() - start
      // The seeded Everyone feed contains twenty top-level cards and no inline replies.
      const rows = page.rows.slice(0, page.limit)
      if (rows.length !== 20 || rows.some((r) => r.lead.parentId !== 0n || r.cards.length !== 0)) throw new Error('unexpected fixture feed shape')
      visible = rows.length
      await Promise.all([page.countsReady, ...rows.map((r) => card(r.lead))])
      if (rows.some((r) => !page.counts.has(r.lead.id))) throw new Error('feed counts did not finish')
    } else {
      const id = BigInt(config.thread)
      const page = await readThread(chain, id)
      const slice = await replySlice(chain, page.replies, id, 20)
      ready = performance.now() - start
      if (slice.list.length !== 20 || slice.total !== 20) throw new Error('unexpected fixture thread shape')
      visible = slice.list.length + 2
      await Promise.all([card(page.record), card(page.parent), ...slice.list.map(card)])
      if (slice.list.some((r) => slice.children.counts.get(r.id) !== 0)) throw new Error('reply counts did not finish')
    }
    const settled = performance.now() - start
    const upstream = await (await realFetch(`${config.counter}/end`)).json()
    if (upstream.errors !== 0) throw new Error(`upstream errors: ${JSON.stringify(upstream)}`)
    samples.push({ view: config.view, host: config.host, phase, visible,
      data_ms: Math.round(ready), settled_ms: Math.round(settled), http_requests: requests, response_bytes: bytes,
      api: calls, upstream: upstream.calls })
  }
  await writeFile(config.result, JSON.stringify(samples, null, 2))
} finally {
  globalThis.fetch = realFetch
  await vite.close()
  await rm(cacheDir, { recursive: true, force: true })
}

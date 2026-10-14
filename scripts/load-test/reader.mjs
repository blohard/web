// Per-user API workload, not a DOM renderer. Each action reads bounded pages;
// the audit is the only operation that deliberately exhausts a cursor.
import { content, ended, recordImage, same } from './protocol.mjs'
import { afterChanges, checkChanges } from '../../src/lib/api.ts'
import { Failure, limited } from './support.mjs'

const newest = (a, b) => a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1

/** Finite, per-user cache; no content or feed state is shared between virtual browsers. */
export class Cache {
  constructor(limit) { this.limit = limit; this.items = new Map() }
  get(key) {
    const value = this.items.get(key)
    if (value !== undefined) { this.items.delete(key); this.items.set(key, value) }
    return value
  }
  set(key, value) {
    if (!this.limit) return
    this.items.delete(key); this.items.set(key, value)
    if (this.items.size > this.limit) this.items.delete(this.items.keys().next().value)
  }
}

export class Reader {
  constructor(api, http, recorder, config, { follows = [], muted = [] } = {}) {
    Object.assign(this, { api, http, recorder, config, follows, muted })
    this.bodies = new Cache(config.bodyCache); this.records = new Cache(10000)
    this.images = new Cache(config.bodyCache)
    this.views = new Map(); this.threadPages = new Map()
    this.home = { kind: 'timeline' }
  }
  async record(id) {
    let p = this.records.get(`${id}`)
    if (!p) { p = (await this.api.message(id)).record; this.records.set(`${id}`, p) }
    return p
  }
  async body(p, gate, rng) {
    if (ended(gate)) return // Context placeholders and removals do not fetch hidden content.
    const bytes = await this.bodyBytes(p)
    if (!bytes) return
    const showImages = same(p.author, this.api.account.address) || this.follows.some((a) => same(a, p.author)) || rng() < 0.1
    if (showImages) {
      const images = [...bytes.toString('utf8').matchAll(/!\[[^\]]*\]\(record:(0x[0-9a-fA-F]{64})\)/g)].slice(0, 4)
      for (const [, hash] of images) if (!this.images.get(hash.toLowerCase())) {
        const bytes = await this.optionalContent(hash, p.id)
        if (bytes) this.images.set(hash.toLowerCase(), true) // Record the browser-cache hit without retaining decoded images in the generator.
      }
    }
  }
  async optionalContent(hash, id) {
    try { return await content(this.http, hash, this.api.info.id, id) } catch (e) {
      if (e.code !== 404) throw e
      // A Posted event may precede its body upload. The UI displays a placeholder; the publication audit still requires the bytes.
      await this.recorder.event({ type: 'content_missing', chain: this.api.info.id, id: `${id}` })
      return null
    }
  }
  async bodyBytes(p) {
    const key = p.contentHash.toLowerCase()
    let bytes = this.bodies.get(key)
    if (!bytes) { bytes = await this.optionalContent(key, p.id); if (bytes) this.bodies.set(key, bytes) }
    return bytes
  }
  filter(filter) {
    const me = this.api.account.address
    const any = filter.kind === 'timeline' ? [{ kind: 'posts' }, { authors: [me] }, { parent_authors: [me] }]
      : filter.kind === 'following' ? [...(this.follows.length ? [{ authors: this.follows }] : []), { parent_authors: [me] }]
        : filter.kind === 'profile' ? [{ authors: [filter.author] }] : [{ parent_authors: [me] }]
    return { any }
  }
  keep(view, wires) {
    const records = wires.map(recordImage) // Validate the entire answer before applying it.
    for (const p of records) { view.events.set(`${p.id}`, p); this.records.set(`${p.id}`, p) }
  }
  async page(view, path, query) {
    const page = await this.api.app(path, { ...query, cursor: view.cursor ?? null, limit: 20 })
    if (view.at && view.at.generation !== page.at.generation) throw new Failure('index_reset', 409)
    if (page.items.length > 20 || (page.next && JSON.stringify(page.next) === JSON.stringify(view.cursor))) throw new Failure('integrity', 0)
    this.keep(view, page.items)
    view.at ??= page.at
    view.cursor = page.next
    view.loaded = true
    return page
  }
  async changed(view, scope, apply = true) {
    if (!view.at) return []
    let at = view.at, until = view.until
    const records = new Map()
    // A busy chain cannot make one action chase its moving head forever.
    for (let i = 0; i < 8; i++) {
      const answer = await this.api.app('changes', { generation: at.generation, after: at.sequence, scope, until })
      checkChanges(at, answer)
      until ??= answer.until
      if (JSON.stringify(answer.until) !== JSON.stringify(until)) throw new Failure('integrity', 0)
      const wires = scope.account ? [...answer.references, ...answer.records.filter((r) => view.events.has(r.id))] : answer.records
      for (const p of wires.map(recordImage)) records.set(`${p.id}`, p)
      at = afterChanges(at, answer)
      if (apply) {
        this.keep(view, wires)
        view.at = at; view.until = answer.more ? until : undefined
      }
      if (!answer.more) break
    }
    return [...records.values()]
  }
  select(events, filter) {
    const rows = new Map(), held = new Map(events.map((p) => [`${p.id}`, p]))
    for (const p of [...events].sort(newest)) {
      if (ended(p.gate) || (filter.kind !== 'profile' && this.muted.some((a) => same(a, p.author)))) continue
      // Collapse linear inlined replies iteratively: depth never consumes JS call stack.
      let root = p, seen = new Set()
      while (root.parentId !== 0n && held.has(`${root.parentId}`) && !seen.has(`${root.id}`)) {
        seen.add(`${root.id}`); root = held.get(`${root.parentId}`)
      }
      const key = root.parentId !== 0n ? `parent:${root.parentId}` : `${root.id}`
      if (!rows.has(key)) rows.set(key, p)
    }
    return [...rows.values()]
  }
  async feed(filter, rng, older = false) {
    const key = JSON.stringify(filter), query = { filter: this.filter(filter) }
    let view = this.views.get(key)
    if (!view) { view = { events: new Map() }; this.views.set(key, view) }
    const previous = new Set(view.events.keys())
    if (view.loaded && !older) await this.changed(view, { feed: query.filter, ids: [...view.events.keys()] })
    else for (let round = 0; round < 8; round++) {
      if (view.loaded && !view.cursor) break
      await this.page(view, 'feed', query)
      const rows = this.select([...view.events.values()], filter)
      if (rows.filter((p) => !older || !previous.has(`${p.id}`)).length >= 20) break
    }
    const rows = this.select([...view.events.values()], filter).filter((p) => !older || !previous.has(`${p.id}`)).slice(0, 20)
    const parents = await limited(rows.filter((p) => p.parentId !== 0n), 8, (p) => this.record(p.parentId))
    const visible = [...new Map([...rows, ...parents].map((p) => [`${p.id}`, p])).values()]
    await limited(visible, 8, (p) => this.body(p, p.gate, rng))
    if (filter.kind === 'timeline' || filter.kind === 'following') this.home = filter
    return { rows: rows.length, more: !!view.cursor, sequence: view.at.sequence }
  }
  async thread(id, rng, expand = false) {
    const target = expand ? this.threadPages.get(`tip:${id}`) ?? id : id
    const { record: root, ancestors } = await this.api.message(target, 1)
    await limited([root, ...ancestors], 8, (p) => this.body(p, p.gate, rng))
    const key = `page:${root.id}`
    let view = this.threadPages.get(key)
    if (!view) { view = { events: new Map() }; this.threadPages.set(key, view) }
    if (view.loaded) await this.changed(view, { parents: [`${root.id}`], ids: [`${root.id}`] })
    if (!view.loaded || view.cursor) await this.page(view, 'replies', { parent: `${root.id}` })
    const page = [...view.events.values()].filter((p) => p.parentId === root.id && !ended(p.gate)).sort((a, b) => -newest(a, b)).slice(-20)
    await limited(page, 8, (p) => this.body(p, p.gate, rng))
    const branch = page.find((p) => p.replies > 0)
    if (expand && branch) this.threadPages.set(`tip:${id}`, `${branch.id}`)
    return { root: `${root.id}`, replies: root.replies, shown: page.length }
  }
  async ancestors(id, rng, steps = 10) {
    const { record, ancestors } = await this.api.message(id, Math.min(32, steps - 1))
    const posts = [record, ...ancestors]
    await limited(posts, 8, (p) => this.body(p, p.gate, rng))
    return { traversed: posts.length, next: `${posts.at(-1).parentId}` }
  }
  async poll() {
    const view = this.views.get(JSON.stringify(this.home))
    if (!view?.at) return 0
    const found = await this.changed(view, { feed: this.filter(this.home) }, false)
    return found.filter((p) => !view.events.has(`${p.id}`) && !ended(p.gate)).length
  }
  async notifications(rng) {
    let view = this.views.get('references')
    if (!view) { view = { events: new Map() }; this.views.set('references', view) }
    const account = this.api.account.address
    if (view.loaded) await this.changed(view, { account, ids: [...view.events.keys()] })
    else for (let i = 0; i < 8; i++) {
      await this.page(view, 'references', { account })
      if (!view.cursor || [...view.events.values()].filter((p) => this.visibleReference(p)).length >= 20) break
    }
    const posts = [...view.events.values()].filter((p) => this.visibleReference(p)).sort(newest).slice(0, 20)
    await limited(posts, 8, (p) => this.body(p, p.gate, rng))
    return posts.length
  }
  visibleReference(p) {
    return !ended(p.gate) && !same(p.author, this.api.account.address) && !this.muted.some((a) => same(a, p.author))
  }
}

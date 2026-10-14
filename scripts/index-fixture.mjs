// Deterministic host query fixture shared by reader tests. Chain ingestion,
// persistence and exact server pagination have their own Rust tests.
import assert from 'node:assert/strict'
import { zeroAddress } from 'viem'
import { hash, response } from './fixture-values.mjs'
const TOMBSTONE = '0x0000000000000000000000000000000000000001'
const REMOVED = '0x0000000000000000000000000000000000000002'
const live = (gate) => gate !== TOMBSTONE && gate !== REMOVED
export async function answerIndex(state, url, init) {
  const { rows, at, events = [], associations = new Map() } = state
  const generation = at.generation
  const sameList = (a, b) => a && b && ['registry', 'owner', 'list'].every((k) => a[k].toLowerCase() === b[k].toLowerCase())
  const blocked = (list, author) => {
    const changes = events.filter((c) => c.event.kind === 'chain' && c.event.event.kind === 'membership'
      && sameList(c.event.event.list, list) && c.event.event.member.toLowerCase() === author.toLowerCase())
    return changes.at(-1)?.event.event.present ?? false
  }
  // A clause's members_of: the list's own membership events, else the fixture's one member answer.
  const member = (list, author) => {
    const changes = events.filter((c) => c.event.kind === 'chain' && c.event.event.kind === 'membership'
      && sameList(c.event.event.list, list) && c.event.event.member.toLowerCase() === author.toLowerCase())
    return changes.length ? changes.at(-1).event.event.present : state.member ?? false
  }

    if (url.pathname.endsWith('/state')) {
      const body = JSON.parse(init.body)
      return response({ at, items: (body.ids ?? []).map((id) => rows.get(BigInt(id)) ?? null),
        accounts: (body.accounts ?? []).map((address) => ({ address, gate: state.authorGate ?? zeroAddress, member: state.member ?? false })), memberships: (body.memberships ?? []).map(() => state.member ?? false) })
    }
    if (url.pathname.endsWith('/notifications')) {
      const body = JSON.parse(init.body)
      const ceiling = body.cursor?.ceiling ?? String([...rows.keys()].reduce((a, b) => a > b ? a : b, 0n))
      const matches = [...rows].filter(([id, r]) => (r.parent !== '0' && r.parent_author === body.account || associations.get(id)?.account === body.account)
        && live(r.gate) && !blocked(body.exclude_list, r.author) && id <= BigInt(ceiling) && (!body.cursor || id < BigInt(body.cursor.before)))
        .sort(([a], [b]) => Number(b - a)).map(([id, r]) => ({ ...r, reference: associations.get(id)?.account === body.account ? associations.get(id).reference : null }))
      const items = matches.slice(0, body.limit)
      const next = matches.length > items.length ? { generation, filter: hash('af'), ceiling, before: items.at(-1).id } : null
      return response({ at, items, next })
    }
    if (url.pathname.endsWith('/references')) {
      const body = JSON.parse(init.body)
      const ceiling = body.cursor?.ceiling ?? String([...rows.keys()].reduce((a, b) => a > b ? a : b, 0n))
      const matches = [...associations].filter(([id, a]) => a.account === body.account && live(rows.get(id)?.gate) && !blocked(body.exclude_list, rows.get(id).author) && id <= BigInt(ceiling) && (!body.cursor || id < BigInt(body.cursor.before)))
        .sort(([a], [b]) => Number(b - a)).map(([id, a]) => ({ ...rows.get(id), reference: a.reference }))
      const items = matches.slice(0, body.limit)
      const next = matches.length > items.length ? { generation, filter: hash('af'), ceiling, before: items.at(-1).id } : null
      return response({ at, items, next })
    }
    if (url.pathname.endsWith('/replies')) {
      const body = JSON.parse(init.body)
      const parent = rows.get(BigInt(body.parent))
      const ceiling = body.cursor?.ceiling ?? String([...rows.keys()].reduce((a, b) => a > b ? a : b, 0n))
      const matches = [...rows.values()].filter((m) => m.parent === body.parent && live(m.gate)
        && BigInt(m.id) <= BigInt(ceiling) && BigInt(m.id) > BigInt(body.cursor?.after ?? '0'))
        .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))
      const items = matches.slice(0, body.limit)
      const next = matches.length > items.length ? { generation, parent: body.parent, ceiling, after: items.at(-1).id } : null
      return response({ at, parent, items, next })
    }
    if (url.pathname.endsWith('/feed')) {
      const body = JSON.parse(init.body)
      const ceiling = body.cursor?.ceiling ?? String([...rows.keys()].reduce((a, b) => a > b ? a : b, 0n))
      const candidates = [...rows.values()].filter((m) => BigInt(m.id) <= BigInt(ceiling) && (!body.cursor || BigInt(m.id) < BigInt(body.cursor.before)))
        .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))
        .filter((m) => body.filter.any.some((clause) =>
          (!clause.authors?.length || clause.authors.includes(m.author)) && (!clause.parent_authors?.length || clause.parent_authors.includes(m.parent_author))
          && (!clause.curated || state.policy?.curated.includes(m.author))
          && (!clause.parent_curated || state.policy?.curated.includes(m.parent_author))
          && (!clause.members_of || member(clause.members_of, m.author))
          && (!clause.parent_members_of || m.parent !== '0' && member(clause.parent_members_of, m.parent_author))
          && (clause.kind === 'posts' ? m.parent === '0' : clause.kind === 'replies' ? m.parent !== '0' : true)))
        .filter((m) => !state.policy?.blocked.includes(m.author) && live(m.gate) && !blocked(body.filter.exclude_list, m.author))
      const items = candidates.slice(0, body.limit)
      const next = candidates.length > items.length ? { generation, filter: hash('af'), ceiling, before: items.at(-1).id } : null
      return response({ at, items, next })
    }
    if (url.pathname.endsWith('/changes')) {
      const body = JSON.parse(init.body)
      const scope = body.scope, until = body.until ?? structuredClone(at)
      // As the host refuses: a cursor from another history, or older than the
      // changes it still keeps.
      if (body.generation !== generation || BigInt(body.after) < BigInt(state.first ?? 0)) return response({ error: 'reset_required' }, 409)
      // As the host pages: look through up to 2,000 entries, return at most
      // 50 changes and 100 records. The entry that would pass either starts
      // the next page.
      const pending = events.filter((c) => BigInt(c.sequence) > BigInt(body.after) && BigInt(c.sequence) <= BigInt(until.sequence)).slice(0, 2000)
      const matches = (id) => {
        const r = rows.get(BigInt(id))
        return r && ((scope.ids ?? []).includes(r.id) || (scope.parents ?? []).includes(r.parent)
          || (!blocked(scope.feed?.exclude_list, r.author) && scope.feed?.any.some((c) => (!c.authors?.length || c.authors.includes(r.author))
            && (!c.parent_authors?.length || c.parent_authors.includes(r.parent_author))
            && (!c.curated || state.policy?.curated.includes(r.author))
            && (!c.parent_curated || state.policy?.curated.includes(r.parent_author))
            && (!c.members_of || member(c.members_of, r.author))
            && (!c.parent_members_of || r.parent !== '0' && member(c.parent_members_of, r.parent_author))
            && (!c.kind || c.kind === 'all' || (c.kind === 'posts' ? r.parent === '0' : r.parent !== '0'))))
          || (!blocked(scope.exclude_list, r.author) && scope.account && associations.get(BigInt(id))?.account === scope.account))
      }
      const ids = new Set(), changes = []
      let through = body.after, stopped = pending.length === 2000
      for (const c of pending) {
        const event = c.event.event
        if (c.event.kind === 'chain' && event.kind === 'membership'
          && (sameList(event.list, scope.exclude_list) || sameList(event.list, scope.feed?.exclude_list)
            || scope.feed?.any.some((c) => sameList(event.list, c.members_of) || sameList(event.list, c.parent_members_of)))) {
          return response({ error: 'reset_required' }, 409)
        }
        const id = c.event.kind === 'references' ? c.event.id : event?.kind === 'posted' ? event.message.id : event?.kind === 'reply_gate' ? event.id : null
        const add = []
        if (id && matches(id)) add.push(BigInt(id))
        if (id && c.event.kind === 'chain') {
          const parent = rows.get(BigInt(id))?.parent
          if (parent && parent !== '0' && (matches(parent) || scope.parents?.includes(parent))) add.push(BigInt(parent))
        }
        const include = (event?.kind === 'reply_gate' || event?.kind === 'author_gate') ? scope.gates !== false : Boolean(id && matches(id))
        if (changes.length + (include ? 1 : 0) > 50 || ids.size + add.filter((x) => !ids.has(x)).length > 100) { stopped = true; break }
        through = c.sequence
        for (const x of add) ids.add(x)
        if (include) changes.push(c)
      }
      if (!stopped) through = until.sequence
      const references = [...ids].filter((id) => scope.account && !blocked(scope.exclude_list, rows.get(id).author) && associations.get(id)?.account === scope.account).map((id) => ({ ...rows.get(id), reference: associations.get(id).reference }))
      return response({ at, until, gates: scope.gates !== false, changes, references, records: [...ids].map((id) => rows.get(id)).filter(Boolean), through, more: BigInt(through) < BigInt(until.sequence) })
    }
    const match = url.pathname.match(new RegExp(`^/api/chains/${state.chain.id}/message/(\\d+)$`))
    assert.ok(match, `unexpected application request ${url}`)
    const id = BigInt(match[1])
    const message = rows.get(id)
    if (!message) return response({ error: 'message_not_found' }, 404)
    const ancestors = []
    let parent = BigInt(message.parent)
    while (parent !== 0n && ancestors.length < Number(url.searchParams.get('ancestors'))) {
      const row = rows.get(parent)
      ancestors.push(row)
      parent = BigInt(row.parent)
    }
    return response({ at, message, ancestors })
}

// A blohard bot that answers its mentions: an example to copy and change,
// not an unattended service. Change answer() at the bottom, then:
//
//   npm install viem
//   SITE=https://blohard.social CHAIN=8453 KEY=0x<private key> node bot.mjs
//
// It posts through the site's relayer, which pays the gas for accounts on the
// sponsor list, or holding an ENS or basename given as NAME=alice.eth (see
// /bots.md). Every post it signs is saved in STATE (./blohard-bot by default)
// before it is sent. A post it cannot finish stays there and is reported;
// `node bot.mjs resume` tries those again with the same signatures. Each
// answer's nonce comes from the mention it answers, so the Board takes at most
// one answer per mention, whatever happens. It also says it is a bot, so
// readers see a robot next to its name. Node 20 or later.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeAbiParameters, hexToBytes, keccak256, toHex, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/** Every wait is scaled by this; tests set it to zero. */
export const pause = { scale: 1 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms * pause.scale))
const HEADER = 'version/1 text/plain\n'

/** A refusal from the host or the relayer: `code` says why, `outcome` whether a send may have happened. */
export class Refused extends Error {
  constructor(status, body, retryAfter) {
    super(`${status} ${body?.code ?? ''} ${body?.error ?? ''}`.trim())
    this.status = status
    this.code = body?.code ?? null
    this.outcome = body?.outcome ?? null
    this.retryAfter = retryAfter
  }
}

/** Worth asking again in a moment: the network, a pause the server asked for, or a server error. */
const temporary = (e) => !(e instanceof Refused) || e.retryAfter !== null || e.status === 429 || e.status >= 500

async function call(site, path, { body, bytes } = {}) {
  const response = await fetch(`${site}${path}`, {
    method: body || bytes ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : bytes,
    signal: AbortSignal.timeout(60_000),
  })
  const answer = await response.json().catch(() => null)
  if (response.ok) return { status: response.status, answer }
  const wait = Number(response.headers.get('retry-after'))
  throw new Refused(response.status, answer, Number.isFinite(wait) && wait > 0 ? wait * 1000 : null)
}

/** Write a file whole, then rename it into place, so a crash never leaves half of it. */
async function writeWhole(file, value) {
  await writeFile(`${file}.tmp`, JSON.stringify(value))
  await rename(`${file}.tmp`, file)
}

/** The bytes a post commits to: a one-line header, then the text. */
export function envelope(text) {
  return new TextEncoder().encode(`${HEADER}${text}`)
}

/** A mention, written the way the app writes one. */
export const mention = (name, address) => `[@${name}](account://${address})`

/** The nonce of `author`'s answer to message `id`: one per mention, so a second answer can never land. */
export function replyNonce(author, chainId, id) {
  return BigInt(keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint64' }],
    ['blohard bot answer', author, BigInt(chainId), BigInt(id)],
  )))
}

/** The text an account signs, with no gas, to say it is a bot on the host at `origin`. */
export const declaration = (origin, address, issued) =>
  `Bot declaration\nHost: ${origin}\nAccount: ${address.toLowerCase()}\nBot: yes\nIssued: ${issued}`

/**
 * Say this account is a bot. Best effort: answering never waits on it. A host
 * refuses accounts it has not seen post, so before its first answer lands this
 * fails quietly; the bot tries again after each answer until it works.
 */
export async function declare(site, account) {
  try {
    const policy = (await call(site, '/api/status')).answer?.host_policy
    if (!policy || policy.declared_bots.some((a) => a.toLowerCase() === account.address.toLowerCase())) return true
    const issued = Math.floor(Date.now() / 1000)
    const signature = await account.signMessage({ message: declaration(policy.origin, account.address, issued) })
    await call(site, '/api/bot-declaration', { body: { account: account.address, bot: true, issued, signature } })
    return true
  } catch (e) {
    if (!(e instanceof Refused && e.code === 'not_an_author')) console.error(`could not say this account is a bot yet: ${e.message}`)
    return false
  }
}

/** The chain's Board and the newest block its index has accepted, from the host's status. */
export async function chainOf(site, chainId) {
  const status = (await call(site, '/api/status')).answer
  const chain = status.chains.find((c) => c.id === chainId)
  if (!chain) throw new Error(`the host does not serve chain ${chainId}`)
  return { id: chain.id, contract: chain.contract, accepted: chain.index?.at?.checkpoint?.block ?? '0' }
}

/**
 * The signed request the relayer submits. One signature is one post: never
 * sign twice for the same text. Without `nonce`, a random one is used; the
 * Board's nonces are bitmaps, so any unused 256-bit number works.
 */
export async function sign(account, chain, { bytes, parent = null, nonce = BigInt(toHex(crypto.getRandomValues(new Uint8Array(32)))) }) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 55 * 60)
  const message = {
    author: account.address,
    contentHash: keccak256(bytes),
    parentId: parent ? BigInt(parent.id) : 0n,
    replyGate: zeroAddress,
    nonce,
    deadline,
  }
  const sig = await account.signTypedData({
    domain: { name: 'Board', version: '1', chainId: chain.id, verifyingContract: chain.contract },
    types: {
      Post: [
        { name: 'author', type: 'address' }, { name: 'contentHash', type: 'bytes32' },
        { name: 'parentId', type: 'uint64' }, { name: 'replyGate', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Post',
    message,
  })
  return { ...message, parentId: String(message.parentId), nonce: String(nonce), deadline: String(deadline), sig, gateData: '0x' }
}

/**
 * Send a signed request until the relayer names its transaction. An unknown
 * outcome is asked again with the same request, which can never post twice.
 * Returns the transaction hash, or null when this nonce was already spent.
 */
export async function send(site, chainId, request, { name, tries = 20 } = {}) {
  const query = name ? `?${new URLSearchParams({ name })}` : ''
  for (let attempt = 1; ; attempt++) {
    try {
      return (await call(site, `/api/relay/${chainId}/post${query}`, { body: request })).answer.tx_hash
    } catch (e) {
      if (e instanceof Refused && e.code === 'nonce_spent') return null
      // A decline (daily_quota, not_eligible, ...) is not asked again here.
      const decline = e instanceof Refused && e.outcome === 'refused' && e.retryAfter === null
      if (decline || attempt >= tries) throw e
      await sleep(e.retryAfter ?? Math.min(60_000, 2_000 * attempt))
    }
  }
}

/** The message a request posted: same author, body and parent, at or after `fromBlock`. */
export async function lookup(site, chainId, request, fromBlock) {
  let cursor = null
  for (;;) {
    const page = (await call(site, `/api/chains/${chainId}/lookup`, {
      body: { author: request.author, content_hash: request.contentHash, parent: request.parentId, from_block: fromBlock, cursor, limit: 1 },
    })).answer
    if (page.items[0] || !page.next) return page.items[0] ?? null
    cursor = page.next
  }
}

/**
 * Upload the post's bytes until the host has stored them. `202` means held
 * only in memory until the message is accepted, so it is asked again.
 * `proof` is `{ txHash }` or `{ messageId }`.
 */
export async function upload(site, chainId, bytes, proof, { tries = 60 } = {}) {
  const anchor = proof.txHash ? `tx_hash=${proof.txHash}` : `message_id=${proof.messageId}`
  // A transaction sent moments ago may not be known yet; an interrupted upload is sent again.
  const again = ['transaction_not_found', 'body_not_held', 'upload_incomplete', 'upload_too_slow']
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const { status, answer } = await call(site, `/api/publish?chain_id=${chainId}&${anchor}`, { bytes })
      if (status === 200) return answer
      await sleep(5_000)
    } catch (e) {
      if (!temporary(e) && !again.includes(e.code)) throw e
      await sleep(e.retryAfter ?? Math.min(30_000, 2_000 * attempt))
    }
  }
  throw new Error('the host has not stored the bytes yet')
}

/** The posted message, once its transaction has a receipt. */
export async function landed(site, chainId, txHash, { tries = 60 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const receipt = await call(site, `/api/chains/${chainId}/transaction/${txHash}`).then((r) => r.answer, (e) => {
      if (temporary(e)) return null
      throw e
    })
    if (receipt?.status === 'reverted') throw new Error(`transaction ${txHash} reverted`)
    const posted = receipt?.events?.find((event) => event.kind === 'posted')
    if (posted) return posted.message
    await sleep(3_000)
  }
  throw new Error(`no receipt for ${txHash} yet`)
}

/** Saved posts, one file each under `posts/`: `.json` until finished, then `.done`. */
export function store(dir) {
  const posts = join(dir, 'posts')
  const file = (nonce, end = 'json') => join(posts, `${nonce}.${end}`)
  return {
    async save(op) { await mkdir(posts, { recursive: true }); await writeWhole(file(op.request.nonce), op) },
    /** Saved or finished: either way, not to be signed again. */
    async has(nonce) {
      const names = await readdir(posts).catch(() => [])
      return names.includes(`${nonce}.json`) || names.includes(`${nonce}.done`)
    },
    async done(op) { await rename(file(op.request.nonce), file(op.request.nonce, 'done')).catch(() => {}) },
    async unfinished() {
      const names = (await readdir(posts).catch(() => [])).filter((n) => n.endsWith('.json'))
      return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(posts, n), 'utf8'))))
    },
  }
}

/** Sign `text` as a new post, or a reply when `parent` (a record from the host) is given, and save it. */
export async function prepare(site, chainId, account, text, parent = null, { saved = null, nonce } = {}) {
  const chain = await chainOf(site, chainId)
  const bytes = envelope(text)
  const op = { chainId, fromBlock: chain.accepted, bytes: toHex(bytes), request: await sign(account, chain, { bytes, parent, nonce }), txHash: null }
  await saved?.save(op)
  return op
}

/**
 * Take a saved post as far as it goes: sent, its bytes stored, its message
 * found. Safe to repeat. When it throws, the saved post stays as it is.
 */
export async function finish(site, op, { name, saved = null } = {}) {
  const bytes = hexToBytes(op.bytes)
  if (!op.txHash) {
    const txHash = await send(site, op.chainId, op.request, { name })
    if (txHash === null) {
      // The nonce is spent, by this request earlier or another answer to the same mention.
      const record = await lookup(site, op.chainId, op.request, op.fromBlock)
      if (!record) throw new Error('its nonce is spent, and no post with these bytes is indexed (yet)')
      await upload(site, op.chainId, bytes, { messageId: record.id })
      await saved?.done(op)
      return record
    }
    op.txHash = txHash
    await saved?.save(op)
  }
  await upload(site, op.chainId, bytes, { txHash: op.txHash })
  const message = await landed(site, op.chainId, op.txHash)
  await saved?.done(op)
  return message
}

/** Post `text` (a reply when `parent` is given) and return the new message. */
export async function post(site, chainId, account, text, parent = null, { name, saved = null } = {}) {
  return finish(site, await prepare(site, chainId, account, text, parent, { saved }), { name, saved })
}

/** Try each unfinished saved post once more, with its saved signature. */
export async function resume({ site, name, state = './blohard-bot' }) {
  const saved = store(state)
  for (const op of await saved.unfinished()) {
    try {
      console.log(`finished ${op.request.nonce} as message ${(await finish(site, op, { name, saved })).id}`)
    } catch (e) {
      console.error(`${op.request.nonce} still needs attention: ${e.message}`)
    }
  }
}

/**
 * Every notification newer than message `after`, oldest first: replies to,
 * mentions of and quotes of `address`. Pages back all the way to `after`.
 */
export async function notificationsAfter(site, chainId, address, after) {
  const found = []
  let cursor = null
  for (;;) {
    const { items, next } = (await call(site, `/api/chains/${chainId}/notifications`, { body: { account: address, cursor, limit: 50 } })).answer
    for (const record of items) {
      if (BigInt(record.id) <= after) return found.reverse()
      found.push(record)
    }
    if (!next) return found.reverse()
    cursor = next
  }
}

/** The newest page of replies to, mentions of and quotes of `address`. */
export async function notifications(site, chainId, address) {
  return (await call(site, `/api/chains/${chainId}/notifications`, { body: { account: address, cursor: null, limit: 20 } })).answer.items
}

/** A record's text, checked against the hash the chain recorded; null until this host has it. */
export async function textOf(site, chainId, record, { maxBytes = 64 * 1024 } = {}) {
  const response = await fetch(`${site}/api/content/${record.content_hash}?chain_id=${chainId}&message_id=${record.id}`, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok || !response.body) return null
  // Read a piece at a time and stop past the limit, whatever the length header says.
  const reader = response.body.getReader(), pieces = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) { await reader.cancel(); return null }
    pieces.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const piece of pieces) { bytes.set(piece, at); at += piece.length }
  if (keccak256(bytes) !== record.content_hash) return null
  const text = new TextDecoder().decode(bytes)
  return text.startsWith(HEADER) ? text.slice(HEADER.length) : null
}

/**
 * Answer every new mention once, then wait and look again, until `signal`
 * aborts. `state.json` keeps the last notification handled and the mentions
 * waiting for their text, so mentions that arrive while the bot is down are
 * answered when it returns. An answer it cannot finish is reported and left
 * for `resume`.
 */
export async function run({ site, chainId, key, account = privateKeyToAccount(key), answer, name, state = './blohard-bot', every = 30_000, signal }) {
  const saved = store(state), memory = join(state, 'state.json')
  const remember = async (value) => { await mkdir(state, { recursive: true }); await writeWhole(memory, value) }
  const ours = (record) => record.author.toLowerCase() === account.address.toLowerCase()
  const waiting = (await saved.unfinished()).length
  if (waiting) console.error(`${waiting} saved posts need attention: run \`node bot.mjs resume\``)
  // One declaration at a time, in the background, so answering never waits on it.
  let declared = false, declaring = null
  const tryDeclaring = () => {
    if (declared || declaring) return
    declaring = declare(site, account).then((ok) => { declared = ok }).finally(() => { declaring = null })
  }
  tryDeclaring()
  let failures = 0
  while (!signal?.aborted) {
    try {
      const known = JSON.parse(await readFile(memory, 'utf8').catch(() => 'null'))
      // A first run answers nothing older than now.
      const memo = known ?? { after: (await notifications(site, chainId, account.address))[0]?.id ?? '0', waiting: [] }
      if (!known) await remember(memo)
      const fresh = await notificationsAfter(site, chainId, account.address, BigInt(memo.after))
      // Mentions only: answering every reply would let two bots talk forever.
      const mentions = fresh.filter((r) => r.reference?.kind === 'mention' && !ours(r))
      const queue = [...memo.waiting, ...mentions.map((record) => ({ record, since: Date.now() }))]
      memo.waiting = []
      if (fresh.length) memo.after = fresh.at(-1).id
      const ready = []
      for (const { record, since } of queue) {
        const nonce = replyNonce(account.address, chainId, record.id)
        if (await saved.has(nonce)) continue // answered already
        const text = await textOf(site, chainId, record).catch(() => null)
        // A mention whose text has not arrived waits, without holding up the others, for a day.
        if (text === null) { if (Date.now() - since < 24 * 3600_000) memo.waiting.push({ record, since }); continue }
        let said
        try { said = await answer(text, record) } catch (e) { console.error(`answer() failed for ${record.id}: ${e.message}`) }
        if (said !== undefined) ready.push(await prepare(site, chainId, account, said, record, { saved, nonce }))
      }
      // Answers are saved first, then the mark moves past what they answer.
      await remember(memo)
      for (const op of ready) {
        try {
          console.log(`answered ${op.request.parentId} with ${(await finish(site, op, { name, saved })).id}`)
          tryDeclaring()
        } catch (e) {
          console.error(`the answer to ${op.request.parentId} needs attention (${e.message}): run \`node bot.mjs resume\``)
        }
      }
      failures = 0
    } catch (e) {
      failures++
      console.error(`this round failed, trying again: ${e.message}`)
      await sleep(Math.min(10 * 60_000, every * 2 ** Math.min(failures, 5)))
      continue
    }
    await sleep(every)
  }
}

// Change this: what the bot says when mentioned.
async function answer(text) {
  return `you said ${JSON.stringify(text.slice(0, 200))}`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { SITE = 'https://blohard.social', CHAIN = '8453', KEY, NAME, STATE } = process.env
  if (process.argv[2] === 'resume') await resume({ site: SITE, name: NAME, state: STATE })
  else {
    if (!KEY) throw new Error('set KEY to the bot account\'s private key')
    await run({ site: SITE, chainId: Number(CHAIN), key: KEY, answer, name: NAME, state: STATE })
  }
}

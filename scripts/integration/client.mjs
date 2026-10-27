// Real application modules against real contracts, host and relayer. Only the
// browser's IndexedDB and injected wallet are supplied by Node; HTTP is real.
import assert from 'node:assert/strict'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { createServer } from 'vite'
import { keccak256, stringToHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { withStack, waitFor } from './stack.mjs'

await withStack(async (stack) => {
  const fetchOriginal = globalThis.fetch, now = Date.now
  const globals = new Map(['indexedDB', 'location', 'localStorage'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  const database = new IDBFactory(), apps = [], routes = []
  const author = mnemonicToAccount(stack.mnemonic, { addressIndex: 1 })
  const recipient = mnemonicToAccount(stack.mnemonic, { addressIndex: 2 })
  let clockOffset = 0, app, serial = 0, picture = 0
  Date.now = () => now() + clockOffset
  const storage = new Map()
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) }
  globalThis.indexedDB = database
  globalThis.IDBKeyRange = IDBKeyRange
  globalThis.location = { origin: stack.site, hash: '' }
  const rpc = (method, params = []) => stack.reader.request({ method, params })

  async function openApp() {
    // A fresh module graph discards all tab-local caches and operation owners.
    // The same IndexedDB survives, as it does when reopening the application.
    if (app) await app.server.close()
    globalThis.fetch = fetchOriginal
    const server = await createServer({ root: stack.web, logLevel: 'warn', cacheDir: `${stack.dir}/vite-${++serial}`,
      server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' })
    apps.push(server)
    const load = (name) => server.ssrLoadModule(`/src/${name}`)
    const calls = [], walletCalls = []
    app = { server, load, calls, walletCalls, onResponse: null, beforeRequest: null }
    const current = app
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? input, stack.site)
      const call = { path: url.pathname, query: url.searchParams, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null }
      if (url.origin === stack.site) {
        calls.push(call)
        routes.push(call)
        await current.beforeRequest?.(call)
      }
      const response = await fetchOriginal(typeof input === 'string' ? url : input, init)
      call.status = response.status
      if (url.origin === stack.site) await current.onResponse?.(call, response)
      return response
    }
    const { Wallet } = await load('lib/wallet.svelte.ts')
    const provider = {
      on() {}, removeListener() {},
      async request({ method, params = [] }) {
        walletCalls.push(method)
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [author.address]
        if (method === 'eth_signTypedData_v4') return author.signTypedData(JSON.parse(params[1]))
        return rpc(method, params)
      },
    }
    app.wallet = new Wallet(provider)
    await app.wallet.connect()
    app.store = await load('lib/store.ts')
    app.api = await load('lib/api.ts')
    app.pending = await load('features/publishing/pending.ts')
    app.posting = await load('features/publishing/posting.ts')
    app.relay = await load('features/publishing/relay.ts')
    const { host } = await load('lib/host.svelte.ts')
    const { relayStatus } = await load('lib/relay-status.ts')
    host.status = await app.store.getStatus()
    host.relay = await relayStatus()
    app.chain = host.status.chains[0]
    const { Publications } = await load('features/publishing/publications.svelte.ts')
    // Drive retries explicitly. The unit suite owns backoff timing; this suite
    // checks the work those retries perform against actual service state.
    app.publications = new Publications(() => () => {})
    return app
  }
  async function prepare(text, { attachment = false, parentId = 0n, sponsored = false, replyGate } = {}) {
    const records = []
    if (attachment) {
      const { encode } = await app.load('lib/envelope.ts')
      // A valid one-pixel GIF, with a distinct palette for each publication.
      // Sharing an earlier stored attachment would hide a broken restart retry.
      const gif = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=', 'base64'))
      gif[13] = ++picture
      const bytes = encode('image/gif', gif), hash = app.store.hashOf(bytes)
      records.push({ kind: 'attachment', name: 'pixel.gif', mediaType: 'image/gif', bytes, hash, status: 'pending' })
      text += `\n\n![pixel](record:${hash})`
    }
    records.unshift(app.posting.bodyRecord(text))
    const post = app.pending.newPendingPost(app.chain.id, author.address, records)
    const operation = app.publications.get(post)
    const { DraftBox } = await app.load('features/publishing/draft-box.svelte.ts')
    const box = new DraftBox()
    box.edit({ text, mentions: {}, attachments: records.slice(1) })
    return { post, records, operation, send: () => operation.publish({ chain: app.chain, wallet: app.wallet, parentId, sponsored, replyGate }, box) }
  }
  async function posts(contentHash) {
    const logs = await stack.reader.getContractEvents({ address: stack.board.address, abi: stack.board.abi,
      eventName: 'Posted', fromBlock: 0n, toBlock: 'latest' })
    return logs.filter((log) => log.args.contentHash === contentHash)
  }
  async function accepted(block) {
    await waitFor(async () => {
      const { at } = await app.api.snapshots(app.chain)
      return at.checkpoint && BigInt(at.checkpoint.block) >= block
    }, `index accepted block ${block}`)
  }
  async function stored(records) {
    for (const record of records) {
      const content = await app.store.fetchContent(record.hash)
      assert.equal(content.ok, true, `stored ${record.kind}`)
      assert.deepEqual(content.bytes, record.bytes)
    }
    assert.deepEqual(await app.pending.listPending(), [], 'recovery bytes released only after storage')
  }
  async function resumeOnly() {
    await openApp()
    const saved = await app.pending.listPending()
    assert.equal(saved.length, 1)
    return app.publications.get(saved[0])
  }
  async function pendingWallet(text) {
    await rpc('evm_setAutomine', [false])
    const prepared = await prepare(text, { attachment: true })
    let observed = false
    app.onResponse = async (call, response) => {
      if (!observed && call.path.includes('/transaction/') && (await response.clone().json()).status === 'pending') {
        observed = true
        clockOffset += 121_000 // Skip the client's wait, not the node's state or its answer.
      }
    }
    await assert.rejects(prepared.send(), /transaction has not landed yet/)
    app.onResponse = null
    assert.ok(observed)
    assert.ok(prepared.post.txHash)
    assert.equal(prepared.post.messageId, null)
    assert.ok(prepared.post.records.every((r) => r.status === 'held'))
    assert.equal(app.walletCalls.filter((m) => m === 'eth_sendTransaction' || m === 'wallet_sendTransaction').length, 1)
    return prepared
  }

  try {
    await openApp()
    // 1. Lose a successful relayer answer, discard the tab, recover saved bytes.
    const lost = await prepare('integration: lost relayer response', { attachment: true, sponsored: true })
    app.beforeRequest = async (call) => {
      if (!call.path.endsWith('/post')) return
      const [saved] = await app.pending.listPending()
      assert.deepEqual(saved.signed, call.body, 'signature saved before submission')
      assert.equal(saved.records.length, 2)
    }
    await rpc('evm_setAutomine', [false])
    stack.dropNextRelayAnswer()
    await assert.rejects(lost.send(), (error) => error instanceof app.relay.RelayUnknown)
    assert.ok(stack.dropped)
    assert.equal(lost.post.txHash, null)
    assert.equal((await app.pending.listPending()).length, 1)
    let resumed = await resumeOnly()
    const signed = resumed.post.signed
    assert.equal((await resumed.retry(app.chain)).done, undefined, 'unmined publication stays pending')
    assert.ok(resumed.post.txHash, 'application recovery recovered the hash from the journal')
    assert.ok(app.calls.some((c) => c.path.endsWith('/post')), 'recovery asked the relayer before mining')
    const again = await app.relay.relayPost(app.chain.id, signed)
    assert.equal(resumed.post.txHash, again.tx_hash, 'journal repeat returns one transaction')
    await rpc('evm_mine'); await rpc('evm_setAutomine', [true])
    await waitFor(async () => (await posts(lost.post.bodyHash)).length === 1, 'relayed post mined')
    await accepted((await posts(lost.post.bodyHash))[0].blockNumber)
    assert.equal((await resumed.retry(app.chain)).done, true)
    assert.equal((await posts(lost.post.bodyHash)).length, 1)
    assert.equal(app.walletCalls.some((m) => m.includes('sendTransaction') || m.includes('signTypedData')), false, 'recovery never signs or sends through the wallet')
    await stored(lost.records)
    console.log('ok: real publication saves, survives a lost answer and fresh tab, and stores both records exactly once on chain')

    // 2. Replace an unmined wallet transaction at the same nonce.
    await openApp()
    const sped = await pendingWallet('integration: wallet speed-up')
    const original = await stack.reader.getTransaction({ hash: sped.post.txHash })
    const replacement = await rpc('eth_sendTransaction', [{ from: author.address, to: original.to, data: original.input,
      nonce: `0x${original.nonce.toString(16)}`, gas: `0x${original.gas.toString(16)}`,
      maxFeePerGas: `0x${((original.maxFeePerGas ?? original.gasPrice) * 2n + 1_000_000_000n).toString(16)}`,
      maxPriorityFeePerGas: `0x${((original.maxPriorityFeePerGas ?? 0n) * 2n + 1_000_000_000n).toString(16)}` }])
    assert.notEqual(replacement, sped.post.txHash)
    await rpc('evm_mine'); await rpc('evm_setAutomine', [true])
    const receipt = await stack.reader.getTransactionReceipt({ hash: replacement })
    resumed = await resumeOnly()
    await accepted(receipt.blockNumber)
    app.beforeRequest = async (call) => {
      if (call.path !== '/api/publish') return
      const [saved] = await app.pending.listPending()
      assert.equal(saved.txHash, replacement, 'replacement saved before uploading')
      assert.equal(String(saved.messageId), call.query.get('message_id'))
    }
    assert.equal((await resumed.retry(app.chain)).done, true)
    assert.equal(resumed.post.txHash, replacement)
    const replacementPosts = await posts(sped.post.bodyHash)
    assert.equal(replacementPosts.length, 1)
    assert.equal(resumed.post.messageId, replacementPosts[0].args.id)
    assert.ok(app.calls.some((c) => c.path.endsWith('/lookup')))
    assert.equal(app.walletCalls.some((m) => m.includes('sendTransaction')), false)
    await stored(sped.records)
    console.log('ok: real same-nonce wallet speed-up resolves through the index after a fresh tab')

    // 3. RAM-held bodies are lost on a hard host restart, then recovered from IndexedDB.
    await openApp()
    const held = await pendingWallet('integration: host restart with held bytes')
    const uploads = app.calls.filter((c) => c.path === '/api/publish')
    assert.equal(uploads.length, 2)
    assert.ok(uploads.every((c) => c.status === 202))
    for (const record of held.records) assert.equal((await app.store.fetchContent(record.hash)).reason, 'missing', 'held bytes are not served')
    await stack.restartHost()
    for (const record of held.records) assert.equal((await app.store.fetchContent(record.hash)).reason, 'missing', 'held bytes were not durable')
    await rpc('evm_mine'); await rpc('evm_setAutomine', [true])
    const landed = await stack.reader.getTransactionReceipt({ hash: held.post.txHash })
    resumed = await resumeOnly()
    await accepted(landed.blockNumber)
    assert.equal((await resumed.retry(app.chain)).done, true)
    await stored(held.records)
    console.log('ok: host SIGKILL loses holding, while fresh-tab recovery restores body and attachment')

    // 4. Real indexed reply + mention is one notification; wallet-paid deletion removes it.
    clockOffset = 0
    await openApp()
    const target = await stack.wallet.writeContract({ account: recipient, address: stack.board.address, abi: stack.board.abi,
      functionName: 'post', args: [app.store.hashOf(app.posting.bodyRecord('recipient root').bytes), 0n, '0x0000000000000000000000000000000000000000', '0x'] })
    const targetReceipt = await stack.reader.waitForTransactionReceipt({ hash: target })
    await accepted(targetReceipt.blockNumber)
    const roots = await stack.reader.getContractEvents({ address: stack.board.address, abi: stack.board.abi, eventName: 'Posted', fromBlock: targetReceipt.blockNumber, toBlock: targetReceipt.blockNumber })
    const body = app.posting.bodyRecord(`integration: hello account://${recipient.address}`)
    const { post } = await app.load('lib/board.ts')
    const reply = await post(app.wallet.provider, author.address, app.chain, {
      contentHash: body.hash, parentId: roots[0].args.id, })
    const { findNotifications } = await app.load('features/notifications/notifications.ts')
    const firstPage = await findNotifications([app.chain], recipient.address)
    assert.deepEqual(firstPage.items.map((r) => [r.post.id, r.kind]), [[reply.id, 'reply']])
    assert.equal((await app.store.publish(body.bytes, app.chain.id, { messageId: reply.id })).held, false)
    await waitFor(async () => {
      const page = await findNotifications([app.chain], recipient.address)
      assert.equal(page.items.length, 1, 'reply and mention never duplicate')
      return page.items[0].post.id === reply.id && page.items[0].kind === 'mention'
    }, 'body reference indexed')
    const sendsBeforeModeration = app.walletCalls.filter((m) => m.includes('sendTransaction')).length
    const { moderate } = await app.load('features/messages/moderation.ts')
    const retired = await fetchOriginal(`${stack.site}/api/relay/${app.chain.id}/moderate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(retired.status, 404, 'the retired moderation endpoint is absent')
    let result
    globalThis.indexedDB = undefined
    try { result = await moderate(app.wallet, app.chain, reply.id, 'delete') }
    finally { globalThis.indexedDB = database }
    assert.ok(result.txHash)
    assert.ok(!app.calls.some((c) => c.path.endsWith('/moderate')), 'new moderation never uses the relayer')
    assert.equal(app.walletCalls.filter((m) => m.includes('sendTransaction')).length, sendsBeforeModeration + 1, 'the reader pays for moderation even when posts are sponsored')
    await accepted(result.block)
    assert.equal((await findNotifications([app.chain], recipient.address)).items.length, 0)
    console.log('ok: real notification union, late body association, refresh and paid moderation')

    // 5. Every route the client reads, answered by the real host and read through the client's own decoders.
    await openApp()
    const { loadFeed, peekFeed } = await app.load('features/streams/feed.ts')
    const sessions = new Map()
    const { readThread, replySlice } = await app.load('features/streams/replies.ts')
    const { readMessage, resolveQuote } = await app.load('lib/messages.ts')
    const { checkReply, post: paidPost } = await app.load('lib/board.ts')
    const { listMembers, contains } = await app.load('lib/registry.ts')
    const { transaction } = await app.load('lib/transactions.ts')
    const { sponsorEligibility } = await app.load('features/publishing/relay.ts')
    assert.equal((await sponsorEligibility(app.chain.id, author.address)).eligible, true, 'sponsored posting eligibility remains available independently of moderation')
    const rootId = roots[0].args.id, zero = '0x0000000000000000000000000000000000000000'
    const { record: rootRecord } = await readMessage(app.chain, rootId)
    // A paid quote of the recipient's root; its body arrives after the post and is associated later.
    const quoteBody = app.posting.bodyRecord(`integration: quoting

post://${app.chain.id}/${rootId}?commit=${rootRecord.commitment}`)
    const quoted = await paidPost(app.wallet.provider, author.address, app.chain, { contentHash: quoteBody.hash, parentId: 0n, })
    const landedQuote = await transaction(app.chain, quoted.txHash)
    assert.equal(landedQuote.status, 'success')
    await accepted(BigInt(landedQuote.block))
    assert.equal((await app.store.publish(quoteBody.bytes, app.chain.id, { messageId: quoted.id })).held, false)
    await waitFor(async () => {
      const page = await app.api.references(app.chain, recipient.address)
      return page.items.some((r) => app.api.integer(r.id) === quoted.id && r.reference?.kind === 'quote')
    }, 'quote reference indexed')
    assert.equal((await resolveQuote(app.chain, rootId, rootRecord.commitment))?.id, rootId)
    await assert.rejects(readMessage(app.chain, rootId, 0, `0x${'00'.repeat(32)}`), 'a wrong pin never resolves')
    const leads = (page) => page.rows.map((r) => r.lead.id)
    const home = { kind: 'timeline', viewer: recipient.address }
    const timeline = await loadFeed(app.chain, home)
    assert.ok(leads(timeline).includes(rootId) && leads(timeline).includes(quoted.id), 'timeline shows both roots')
    assert.ok(!leads(timeline).includes(reply.id), 'a deleted reply is not a timeline row')
    const byAuthor = await loadFeed(app.chain, { kind: 'author', address: author.address })
    assert.ok(leads(byAuthor).includes(quoted.id) && !leads(byAuthor).includes(rootId))
    assert.ok(leads(await loadFeed(app.chain, { kind: 'following', includeRepliesToViewer: true, authors: [author.address], viewer: recipient.address })).includes(quoted.id))
    const toReader = timeline.rows.filter((r) => r.lead.parentId !== 0n && r.lead.parentAuthor.toLowerCase() === recipient.address.toLowerCase())
    assert.deepEqual(toReader.map((r) => r.lead.id), [], 'the reader\'s feed lists no deleted reply to them')
    // The stack seeds the host list with the first four derived accounts; the deployer owns it and is not on it.
    const outsider = await stack.wallet.writeContract({ address: stack.board.address, abi: stack.board.abi,
      functionName: 'post', args: [app.store.hashOf(app.posting.bodyRecord('outsider root').bytes), 0n, zero, '0x'] })
    await accepted((await stack.reader.waitForTransactionReceipt({ hash: outsider })).blockNumber)
    const curatedOnly = await loadFeed(app.chain, { kind: 'timeline', curatedOnly: true }, { limit: 50 })
    const everyone = await loadFeed(app.chain, { kind: 'timeline' }, { limit: 50 })
    assert.equal(leads(everyone).length, leads(curatedOnly).length + 1, 'the curated timeline leaves out exactly the outsider')
    assert.ok(leads(curatedOnly).includes(quoted.id) && leads(curatedOnly).includes(rootId))
    const outsiderView = await loadFeed(app.chain, { kind: 'timeline', curatedOnly: true, viewer: stack.account.address }, { limit: 50 })
    assert.deepEqual(leads(outsiderView), leads(curatedOnly), 'an unlisted reader has no own-post exception in Curated')
    assert.equal(await peekFeed(app.chain, home), 1, 'the outsider root is new since the home page')
    const later = await stack.wallet.writeContract({ account: recipient, address: stack.board.address, abi: stack.board.abi,
      functionName: 'post', args: [app.store.hashOf(app.posting.bodyRecord('recipient again').bytes), 0n, zero, '0x'] })
    await accepted((await stack.reader.waitForTransactionReceipt({ hash: later })).blockNumber)
    assert.equal(await peekFeed(app.chain, home), 2, 'two new roots through changes')
    const thread = await readThread(sessions, app.chain, rootId)
    assert.equal(thread.record.id, rootId)
    const slice = await replySlice(app.chain, thread.replies, rootId, 20)
    assert.deepEqual(slice.list, [], "a deleted reply leaves its parent's list")
    assert.equal(thread.replies.counts.get(rootId), 0, 'and its count')
    assert.equal(await checkReply(app.chain, rootId, author.address), zero, 'admission answers the effective gate')
    const list = { registry: stack.registry.address, owner: stack.account.address, id: keccak256(stringToHex("load-test")) }
    assert.equal(app.chain.curated, true, "the host enables local curation")
    const listKey = { registry: list.registry, owner: list.owner, list: list.id }
    const snapshot = await app.api.snapshots(app.chain, [rootId, quoted.id], [author.address], [{ list: listKey, member: author.address }, { list: listKey, member: stack.account.address }])
    assert.deepEqual(snapshot.items.map((r) => app.api.integer(r.id)), [rootId, quoted.id])
    assert.deepEqual(snapshot.memberships, [true, false])
    assert.equal(snapshot.accounts.length, 1)
    const members = await listMembers(app.chain, list)
    assert.ok(members.includes(author.address.toLowerCase()) && members.length === 4, 'the seeded list pages through the index')
    const { hasMembers } = await app.load('lib/registry.ts')
    assert.equal(await hasMembers(app.chain, list), true, 'one indexed member identifies a nonempty list')
    assert.equal(await hasMembers(app.chain, { ...list, owner: author.address }), false, 'an empty owner list is distinguished without walking members')
    assert.equal(await contains(app.chain, list, author.address), true)
    const absent = await app.api.requestPath(`/api/names/${author.address.toLowerCase()}`)
    assert.equal(absent.name, null, 'a host without a name chain answers an absent name')
    const { resolveRecipient } = await app.load('features/keys/recipient.ts')
    await assert.rejects(resolveRecipient('alice.eth'), e => e.status === 503 && e.code === 'name_unavailable')
    for (const name of ['alice..eth', 'alice.b', 'alice.base.e', 'alice.com']) {
      await assert.rejects(app.api.requestPath(`/api/names/resolve/${name}`), e => e.status === 400 && e.code === 'invalid_name')
    }
    // The profile writes through the connected wallet and updates from its
    // receipt, independently of sponsored posting and index catch-up.
    const { saveAuthorGate } = await app.load('features/account/author-gate.ts')
    const { gates } = await app.load('lib/gates.svelte.ts')
    const { TOMBSTONE, setAuthorGate } = await app.load('lib/board.ts')
    await gates.ensureAuthor(app.chain, author.address)
    await saveAuthorGate(app.wallet, app.chain, author.address, 'deactivated')
    assert.equal(gates.author(app.chain, author.address), TOMBSTONE)
    await waitFor(async () => {
      const result = await app.api.snapshots(app.chain, [], [author.address])
      return result.accounts[0]?.gate === TOMBSTONE
    }, 'the profile deactivation reaches the accepted index')
    const restored = await setAuthorGate(app.wallet.provider, author.address, app.chain, zero)
    gates.settleAuthor(app.chain, author.address, zero, restored)
    assert.equal(gates.author(app.chain, author.address), zero, 'deactivation remains reversible')
    console.log('ok: profile deactivation is confirmed, indexed and reversible')
    await waitFor(async () => (await app.store.getStatus()).chains[0].blocking, 'verified blocklist gate published')
    app.chain = (await app.store.getStatus()).chains[0]
    const { savePostReplyGate } = await app.load('features/account/post-reply-rule.ts')
    for (const sponsored of [false, true]) {
      const publication = await prepare(`explicit reply rule ${sponsored}`, { sponsored, replyGate: app.chain.blocking.gate })
      await publication.send()
      const id = publication.post.messageId
      assert.ok(id !== null)
      assert.equal((await stack.reader.readContract({ ...stack.board, functionName: 'replyGate', args: [id] })).toLowerCase(), app.chain.blocking.gate)
      if (sponsored) assert.equal(publication.post.signed.replyGate, app.chain.blocking.gate)
      await accepted((await stack.reader.waitForTransactionReceipt({ hash: publication.post.txHash })).blockNumber)
      await savePostReplyGate(app.wallet, app.chain, { id, author: author.address, parentId: 0n }, zero)
      assert.equal(gates.message(app.chain, id), zero)
      assert.equal(await stack.reader.readContract({ ...stack.board, functionName: 'replyGate', args: [id] }), zero)
    }
    console.log('ok: paid and sponsored posts carry their own reply rule, and paid edits restore account default')
    {
      // A blocked author can answer a reply to their own post, through paid and signed publication.
      const rootResponse = await prepare('right of response: original post')
      await rootResponse.send()
      const boardWrite = async (account, functionName, args) => {
        const hash = await stack.wallet.writeContract({ account, ...stack.board, functionName, args })
        const receipt = await stack.reader.waitForTransactionReceipt({ hash })
        assert.equal(receipt.status, 'success')
        await accepted(receipt.blockNumber)
        return receipt
      }
      const block = await stack.wallet.writeContract({ account: recipient, ...stack.registry,
        functionName: 'add', args: [recipient.address, keccak256(stringToHex(app.chain.blocklist.list)), [author.address]] })
      await accepted((await stack.reader.waitForTransactionReceipt({ hash: block })).blockNumber)
      const targetBody = app.posting.bodyRecord('right of response: a reply that blocks its parent author')
      await boardWrite(recipient, 'post', [targetBody.hash, rootResponse.post.messageId, app.chain.blocking.gate, '0x'])
      const target = (await posts(targetBody.hash))[0].args.id
      await app.store.publish(targetBody.bytes, app.chain.id, { messageId: target })
      assert.equal(await checkReply(app.chain, target, author.address), zero)
      const { gating } = await app.load('features/messages/gating.svelte.ts')
      const responses = []
      for (const sponsored of [false, true]) {
        const response = await prepare(`right of response: ${sponsored ? 'sponsored' : 'paid'}`, { parentId: target, sponsored })
        await response.send()
        responses.push(response.post.messageId)
        const record = (await readMessage(app.chain, response.post.messageId)).record
        assert.equal(record.parentId, target)
        assert.equal(record.parentAuthor.toLowerCase(), recipient.address.toLowerCase())
        assert.equal(await gating.check(app.chain, record, record.parentAuthor), 'shown', 'protection bypasses blocklist folding')
        await assert.rejects(stack.reader.simulateContract({ account: recipient, ...stack.board,
          functionName: 'setReplyGate', args: [record.id, '0x0000000000000000000000000000000000000002'] }), /ProtectedResponse/)
      }
      const terminal = '0x0000000000000000000000000000000000000001'
      await boardWrite(recipient, 'setAuthorGate', [terminal])
      await boardWrite(recipient, 'setReplyGate', [target, zero])
      assert.equal(await checkReply(app.chain, target, author.address), zero, 'account deactivation cannot defeat protection')
      await assert.rejects(checkReply(app.chain, target, stack.account.address), /simulation refused/, 'an unrelated author still faces the ordinary gate')
      await boardWrite(recipient, 'setReplyGate', [target, terminal])
      await assert.rejects(checkReply(app.chain, target, author.address), /simulation refused/, 'explicit target deletion wins')
      await assert.rejects(stack.reader.simulateContract({ account: recipient, ...stack.board,
        functionName: 'setReplyGate', args: [responses[0], '0x0000000000000000000000000000000000000002'] }), /ProtectedResponse/, 'deleting the target does not revoke removal protection')
      const deletedThread = await readThread(sessions, app.chain, target)
      assert.deepEqual((await replySlice(app.chain, deletedThread.replies, target, 20)).list.map(r => r.id), responses,
        'the deleted post owns its surviving replies at its direct address')
      console.log('ok: paid and sponsored protected responses, blocked-author folding, ordinary refusal, deletion and immutable removal protection')

    }
    // The browser's signed edit reaches the real host, survives restart, and
    // immediately governs the separate relayer reading the same file.
    const { saveHostList, readHostPolicy } = await app.load('lib/host-policy.ts')
    const adminWallet = {
      account: stack.account.address, ensureChain: async () => {},
      provider: { request: async ({ method, params }) => {
        if (method === 'eth_accounts') return [stack.account.address]
        if (method === 'personal_sign') return stack.account.signMessage({ message: { raw: params[0] } })
        throw new Error(`unexpected admin wallet call ${method}`)
      } },
    }
    clockOffset = 0
    await saveHostList(adminWallet, 'blocked', 'add', [recipient.address])
    const blockedAnswer = await fetch(`${stack.site}/api/relay/${app.chain.id}/eligibility/${recipient.address}`)
    assert.equal(blockedAnswer.status, 403)
    assert.equal((await blockedAnswer.json()).code, 'host_blocked')
    const remaining = await app.api.feed(app.chain, { any: [{}] })
    assert.ok(remaining.items.every(m => m.author.toLowerCase() !== recipient.address.toLowerCase()))
    await stack.restartHost()
    assert.ok((await readHostPolicy()).blocked.includes(recipient.address.toLowerCase()))
    await saveHostList(adminWallet, 'blocked', 'remove', [recipient.address])
    assert.equal((await readHostPolicy()).blocked.length, 0)
    console.log('ok: signed host lists, blocked feed and sponsorship, durable restart and unblock')

    // The admin takes a stored body down from the app: the real host refuses it
    // to the app's own loader, shows the list only to the admin's signature,
    // keeps it across a restart, and serves the body again once restored.
    const { readTakedowns, saveTakedowns } = await app.load('lib/host-policy.ts')
    const { fetchContent } = await app.load('lib/store.ts')
    const reported = lost.post.bodyHash.toLowerCase()
    assert.equal((await fetchContent(reported)).ok, true)
    const before = await readTakedowns(adminWallet)
    assert.deepEqual(before.hashes, [])
    const taken = await saveTakedowns(adminWallet, before.revision, 'add', [reported])
    assert.deepEqual(taken.hashes, [reported])
    assert.equal((await fetchContent(reported)).reason, 'taken_down')
    await stack.restartHost()
    assert.equal((await fetchContent(reported)).reason, 'taken_down', 'still taken down after a restart')
    assert.deepEqual((await readTakedowns(adminWallet)).hashes, [reported])
    assert.ok(!JSON.stringify(await readHostPolicy()).includes(reported.slice(2)), 'never published')
    await saveTakedowns(adminWallet, taken.revision, 'remove', [reported])
    assert.equal((await fetchContent(reported)).ok, true, 'served again once restored')
    console.log('ok: signed takedowns refuse content to the app, survive a restart and restore')

    // The settings switch's declaration, built by the app and signed by an
    // account that has posted, is accepted by the real host and survives restart.
    const { declareBot } = await app.load('lib/host-policy.ts')
    const { host: appHost } = await app.load('lib/host.svelte.ts')
    const authorWallet = {
      account: author.address, ensureChain: async () => {},
      provider: { request: async ({ method, params }) => {
        if (method === 'eth_accounts') return [author.address]
        if (method === 'personal_sign') return author.signMessage({ message: { raw: params[0] } })
        throw new Error(`unexpected author wallet call ${method}`)
      } },
    }
    await declareBot(authorWallet, true)
    assert.equal(appHost.bot(author.address), 'declared')
    await stack.restartHost()
    const declared = await readHostPolicy()
    assert.ok(declared.declared_bots.some(a => a.toLowerCase() === author.address.toLowerCase()), 'the declaration survives restart')
    await saveHostList(adminWallet, 'bots', 'add', [recipient.address])
    assert.equal(appHost.bot(recipient.address), 'labelled')
    await declareBot(authorWallet, false)
    assert.equal(appHost.bot(author.address), null)
    console.log('ok: signed bot declarations and admin bot labels on the real host')

    const seen = new Set(routes.filter((c) => c.path.startsWith('/api/')).map((c) => c.path
      .replace(/^\/api\/chains\/\d+\//, '/api/chains/{chain}/')
      .replace(/^\/api\/relay\/\d+\//, '/api/relay/{chain}/')
      .replace(/^\/api\/names\/resolve\/[^/]+$/, '/api/names/resolve/{name}')
      .replace(/\/0x[0-9a-fA-F]+$/, '/{hex}')
      .replace(/\/\d+$/, '/{id}')))
    const documented = ['/api/status', '/api/host-policy', '/api/bot-declaration', '/api/host-policy/takedowns', '/api/host-policy/takedowns/read', '/api/publish', '/api/content/{hex}', '/api/names/{hex}', '/api/names/resolve/{name}', '/api/relay/status', '/api/relay/{chain}/eligibility/{hex}', '/api/relay/{chain}/post',
      ...['message/{id}', 'feed', 'replies', 'notifications', 'references', 'state', 'list', 'lookup', 'changes', 'admission', 'post-estimate', 'transaction/{hex}'].map((r) => `/api/chains/{chain}/${r}`)]
    assert.deepEqual(documented.filter((r) => !seen.has(r)), [], 'every client route was answered by the real services')
    assert.deepEqual([...seen].filter((r) => !documented.includes(r)), [], 'no undocumented route was used')
    console.log('ok: every client route answered by the real host in the shape the client decodes')
  } finally {
    Date.now = now
    globalThis.fetch = fetchOriginal
    await Promise.all(apps.map((server) => server.close()))
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})

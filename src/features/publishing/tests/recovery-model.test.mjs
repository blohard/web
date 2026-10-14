// Small independent models exercise sequences, not just isolated outcomes.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, makePost, sign, posted, txHash, hash } from '../../../../scripts/host-harness.mjs'
import { seeded } from '../../../../scripts/seeded.mjs'
const { recoverPost, resolvePendingId } = await load('features/publishing/recovery.ts')
const { savePending, listPending } = await load('features/publishing/pending.ts')
beforeEach(install)
after(teardown)

for (let seed = 1; seed <= 16; seed++) test(`pending recovery model seed ${seed}`, async () => {
  const next = seeded(seed), trace = []
  let post = makePost(true)
  sign(post)
  post.fromBlock = 1n
  await savePending(post)
  const signed = structuredClone(post.signed)
  const bytes = new Map(post.records.map((r) => [r.hash, r.bytes.slice()]))
  const model = { hash: null, id: null, paused: false, remaining: [...bytes.keys()] }
  let minedHash = null, minedLog = null
  // Status and outcome are deliberately independent. In particular a proxy
  // 403 without an outcome is unknown; a relayer-authored 503 is temporary,
  // and so is a 429 with Retry-After, while one without (a spent quota) is not.
  const answers = [[200, null], [403, 'refused'], [409, 'refused'], [429, 'refused', 2], [429, 'refused'],
    [503, 'refused'], [403, 'unknown'], [503, null], [504, 'unknown'], [0, null]]
  try {
    for (let step = 0; step < 40; step++) {
      const final = step === 39, mined = step >= 25
      if (step === 25) minedHash = model.hash ?? txHash
      const [status, outcome, retryAfter = null] = answers[next(answers.length)]
      const manual = next(3) === 0, readFails = !final && next(4) === 0
      const held = !final && next(3) === 0
      const failedHash = final ? null : [...bytes.keys(), null][next(3)]
      const reload = next(3) === 0
      if (reload) [post] = await listPending()
      mock.relayStatus = status; mock.relayOutcome = outcome; mock.relayRetryAfter = retryAfter
      mock.relayHash = mined ? minedHash : hash((32 + next(32)).toString(16))
      mock.head++
      if (step === 25) minedLog = { ...posted(post), transactionHash: minedHash }
      mock.lookupError = readFails; mock.receiptError = readFails; mock.receiptMissing = !mined
      mock.held = held; mock.uploadErrorHash = failedHash
      mock.logs = mined ? [minedLog] : []
      trace.push({ step, reload, mined, manual, readFails, status, outcome, held, failedHash, hash: mock.relayHash })

      // Chain evidence settles identity independently of a refusal. A hash
      // is remembered only from an actual answer, never from a failed read.
      if (model.id === null && mined && !readFails) {
        model.id = 7n
        model.hash ??= minedHash
      }
      let sends = 0
      if (model.id === null) {
        if (manual) model.paused = false
        if (!model.paused) {
          sends = 1
          if (status === 200) model.hash = mock.relayHash
          else if (outcome === 'refused') model.paused = !(status === 503 || (status === 429 && retryAfter !== null))
        }
      }
      if (model.hash || model.id !== null) {
        const remaining = []
        let bodyFailed = false
        for (const h of model.remaining) {
          const failed = h === failedHash
          if (bodyFailed || failed || held || model.id === null) remaining.push(h)
          if (h === post.bodyHash && failed) bodyFailed = true
        }
        model.remaining = remaining
      }
      mock.calls = []
      const result = await recoverPost(mock.chain, post, manual)
      const done = model.id !== null && model.remaining.length === 0
      assert.equal(!!result.done, done, 'completion needs chain evidence and every byte stored')
      assert.equal(post.txHash, model.hash)
      assert.equal(post.messageId, model.id)
      assert.equal(!!post.relayPaused, model.paused)
      const relays = mock.calls.filter((c) => c.method === 'relay')
      assert.equal(relays.length, sends, 'refusal pauses only automatic resubmission')
      for (const request of relays) assert.deepEqual(request.signed, signed, 'no replacement signature')
      assert.ok(mock.calls.every((c) => !c.method.startsWith('eth_') && !c.method.startsWith('wallet:')), 'recovery never sends from the wallet')
      const saved = await listPending()
      assert.equal(saved.length, done ? 0 : 1)
      if (done) break
      assert.equal(saved[0].txHash, model.hash)
      assert.equal(saved[0].messageId, model.id)
      assert.equal(!!saved[0].relayPaused, model.paused)
      assert.deepEqual(saved[0].signed, signed)
      assert.deepEqual(saved[0].records.map((r) => r.hash), model.remaining, 'only confirmed stored bytes may disappear')
      for (const record of saved[0].records) assert.deepEqual(record.bytes, bytes.get(record.hash), 'retry bytes are immutable')
    }
    assert.deepEqual(await listPending(), [], 'restoring service eventually finishes recovery')
  } catch (error) {
    error.message += `\nseed ${seed}\n${JSON.stringify(trace, null, 2)}`
    throw error
  }
})

for (let seed = 1; seed <= 8; seed++) test(`recovery search cursor model seed ${seed}`, async () => {
  const next = seeded(seed), trace = []
  let post = makePost(), expectedFrom = 100n
  post.walletSubmitted = true; post.fromBlock = expectedFrom
  mock.head = 100n
  await savePending(post)
  try {
    for (let step = 0; step < 30; step++) {
      mock.head += BigInt(next(10))
      mock.lookupError = next(3) === 0
      if (next(2)) [post] = await listPending()
      trace.push(`${step}: head ${mock.head}, failed ${mock.lookupError}, from ${expectedFrom}`)
      const requestedFrom = expectedFrom
      mock.calls = []
      if (mock.lookupError) await assert.rejects(resolvePendingId(mock.chain, post), /lookup unavailable/)
      else {
        assert.equal(await resolvePendingId(mock.chain, post), null)
        expectedFrom = mock.head + 1n
      }
      assert.equal(post.fromBlock, expectedFrom)
      assert.equal((await listPending())[0].fromBlock, expectedFrom)
      assert.deepEqual(mock.calls.filter((c) => c.method === 'lookup').map((c) => c.from_block), [String(requestedFrom)])
    }
    mock.lookupError = false; mock.head++
    mock.logs = [posted(post)]
    assert.equal(await resolvePendingId(mock.chain, post), 7n, 'new post is not skipped by earlier empty scans')
  } catch (error) {
    error.message += `\nseed ${seed}\n${trace.join('\n')}`
    throw error
  }
})

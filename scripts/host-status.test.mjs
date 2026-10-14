import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, install, teardown } from './harness.mjs'

const { HostStatus } = await load('lib/host-status.svelte.ts')
const { host } = await load('lib/host.svelte.ts')
after(teardown)

let jobs
beforeEach(() => { install(); host.status = null; jobs = [] })
const schedule = (run, delay) => {
  const job = { run, delay }
  jobs.push(job)
  return () => { jobs = jobs.filter((j) => j !== job) }
}
const fire = async () => {
  const job = jobs.shift()
  assert.ok(job, 'a read is scheduled')
  job.run()
  await new Promise((resolve) => setTimeout(resolve, 0))
}
const chain = (extra = {}) => ({ id: 84532, contract: '0x00000000000000000000000000000000000000b0', blocking: null, closed_gate: null, key_gates: null, ...extra })
const gate = '0x00000000000000000000000000000000000000ce'

test('a first status read that fails is tried again until the host answers', async () => {
  const answers = [new Error('host restarting'), new Error('still restarting'), { chains: [chain()] }]
  const status = new HostStatus(async () => {
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next
  }, schedule)
  const first = []
  status.start((s) => first.push(s))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(status.error.message, 'host restarting')
  assert.deepEqual(jobs.map((j) => j.delay), [2_000])
  await fire()
  assert.deepEqual(jobs.map((j) => j.delay), [5_000], 'the waits grow')
  await fire()
  assert.equal(status.error, null)
  assert.equal(host.status.chains[0].id, 84532)
  assert.equal(first.length, 1)
  assert.equal(jobs.length, 0, 'nothing pending, nothing more to ask')
})

test('try again asks at once instead of at the next wait', async () => {
  let reads = 0
  const status = new HostStatus(async () => {
    if (++reads === 1) throw new Error('down')
    return { chains: [chain()] }
  }, schedule)
  status.start(() => {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  status.retry()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(reads, 2)
  assert.equal(status.error, null)
  assert.equal(jobs.length, 0, 'the waiting read was cancelled')
})

test('gates still validating are read again and filled in on the chain the page already shows', async () => {
  const answers = [
    { chains: [chain({ gates_pending: true })] },
    new Error('a blip'),
    { chains: [chain({ gates_pending: false, closed_gate: gate, blocking: { gate, registry: gate, list: 'blocked' } })] },
  ]
  const status = new HostStatus(async () => {
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next
  }, schedule)
  status.start(() => {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  const shown = host.status.chains[0]
  assert.deepEqual(jobs.map((j) => j.delay), [15_000])
  await fire()
  assert.equal(status.error, null, 'a failed recheck keeps what the host said')
  assert.deepEqual(jobs.map((j) => j.delay), [30_000])
  await fire()
  assert.equal(host.status.chains[0], shown, 'the same chain object, so no view reloads')
  assert.equal(shown.closed_gate, gate)
  assert.equal(shown.blocking.gate, gate)
  assert.equal(shown.gates_pending, false)
  assert.equal(jobs.length, 0)
})

test('stopping cancels the next read', async () => {
  const status = new HostStatus(async () => { throw new Error('down') }, schedule)
  const stop = status.start(() => {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(jobs.length, 1)
  stop()
  assert.equal(jobs.length, 0)
})

const { readRelay } = await load('lib/host-status.svelte.ts')
const { relayStatus } = await load('lib/relay-status.ts')

test('the relayer status says none only for a host without one; a failure is asked again', async () => {
  const fetch = globalThis.fetch
  const answers = [new Response('restarting', { status: 503 }), new Response(JSON.stringify({ chains: [{ id: 84532 }] }), { status: 200, headers: { 'content-type': 'application/json' } })]
  globalThis.fetch = async (url) => { assert.equal(String(url), '/api/relay/status'); return answers.shift() }
  try {
    host.relay = null
    const stop = readRelay(relayStatus, schedule)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(host.relay, null)
    assert.deepEqual(jobs.map((j) => j.delay), [5_000], 'a relayer restarting is asked again')
    await fire()
    assert.equal(host.relay.chains[0].id, 84532)
    assert.equal(jobs.length, 0)
    stop()
    globalThis.fetch = async () => new Response('', { status: 404 })
    assert.equal(await relayStatus(), null, 'a host without a relayer')
  } finally { globalThis.fetch = fetch }
})

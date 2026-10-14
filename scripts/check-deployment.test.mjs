import assert from 'node:assert/strict'
import test from 'node:test'
import { checkDeployment } from './check-deployment.mjs'
const a = `0x${'11'.repeat(20)}`, b = `0x${'22'.repeat(20)}`, c = `0x${'33'.repeat(20)}`
const build = { chains: [8453, 84532], market: a, devFund: b }
const status = () => ({ keyrings: [{ chain: 84532, market: a }], chains: [
  { id: 84532, blocking: { gate: b }, key_gates: { holders: a, holders_blocklist: c } },
] })
test('deployment check rejects mismatched and incompletely verified host setups', () => {
  assert.doesNotThrow(() => checkDeployment(build, status()))
  for (const mutate of [
    s => { s.keyrings[0].market = b }, s => { s.keyrings[0].chain = 8453 }, s => { delete s.keyrings },
    s => { delete s.chains[0].blocking }, s => { delete s.chains[0].key_gates.holders },
    s => { delete s.chains[0].key_gates.holders_blocklist }, s => { s.chains[0].id = 8453 },
    s => { s.chains.push(s.chains[0]) },
  ]) {
    const s = status(); mutate(s)
    assert.throws(() => checkDeployment(build, s))
  }
  assert.throws(() => checkDeployment({ ...build, devFund: null }, status()))
  assert.throws(() => checkDeployment({ ...build, market: 'invalid' }, status()))
  assert.throws(() => checkDeployment({ ...build, chains: [8453] }, status()))
})
test('disabled keys require both build and host to agree', () => {
  const disabled = { chains: [8453, 84532], market: null, devFund: null }
  assert.doesNotThrow(() => checkDeployment(disabled, { chains: [] }))
  assert.throws(() => checkDeployment(disabled, status()))
  assert.throws(() => checkDeployment(build, { chains: [] }))
})

test('both chains verify independently even with the same market address', () => {
  const s = status()
  s.keyrings.push({ chain: 8453, market: a })
  s.chains.push({ ...s.chains[0], id: 8453 })
  assert.doesNotThrow(() => checkDeployment(build, s))
  s.chains[1].key_gates = { holders: a }
  assert.throws(() => checkDeployment(build, s), /verified/)
  s.chains[1].key_gates = s.chains[0].key_gates
  s.keyrings[1].market = b
  assert.throws(() => checkDeployment(build, s), /markets differ/)
})

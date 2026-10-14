// Exercise pin rejection and late body discovery through the deployed local host.
import assert from 'node:assert/strict'
import { decodeEventLog, keccak256, zeroAddress } from 'viem'
import { sleep } from './support.mjs'

export async function verifyQuotes({ site, chain, board, wallet, reader }) {
  const api = async (path, body) => {
    const response = await fetch(`${site}/api/chains/${chain}/${path}`, body === undefined ? { signal: AbortSignal.timeout(5000) } : {
      signal: AbortSignal.timeout(5000),
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const answer = await response.json()
    assert.equal(response.status, 200, JSON.stringify(answer))
    return answer
  }
  async function wait(test) {
    for (let n = 0; n < 150; n++) { const result = await test(); if (result) return result; await sleep(100) }
    throw new Error('quote indexing did not finish')
  }
  async function post(text) {
    const bytes = Buffer.from(`version/1 text/plain\n${text}\n`)
    const hash = await wallet.writeContract({ address: board.address, abi: board.abi, functionName: 'post',
      args: [keccak256(bytes), 0n, zeroAddress, '0x'] })
    const receipt = await reader.waitForTransactionReceipt({ hash })
    const event = receipt.logs.map((log) => {
      try { return decodeEventLog({ abi: board.abi, ...log }) } catch { return null }
    }).find((event) => event?.eventName === 'Posted')
    assert.ok(event)
    const id = event.args.id.toString()
    await wait(async () => (await fetch(`${site}/api/chains/${chain}/message/${id}`, { signal: AbortSignal.timeout(5000) })).ok)
    return { id, bytes }
  }
  async function upload(post) {
    const response = await fetch(`${site}/api/publish?chain_id=${chain}&message_id=${post.id}`, { method: 'POST', body: post.bytes, signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200, await response.text())
  }
  const target = await post('quote commitment test target')
  await upload(target)
  const image = (await api(`message/${target.id}`)).message
  const good = await post(`post://${chain}/${target.id}?commit=${image.commitment}`)
  const wrong = await post(`post://${chain}/${target.id}?commit=0x${'00'.repeat(32)}`)
  const legacy = await post(`post://${chain}/${target.id}`)
  await upload(wrong); await upload(legacy)
  const before = await api('references', { account: image.author })
  assert.ok(!before.items.some((item) => [good.id, wrong.id, legacy.id].includes(item.id)))
  await upload(good)
  const after = await wait(async () => {
    const answer = await api('references', { account: image.author })
    return answer.items.some((item) => item.id === good.id) && answer
  })
  assert.ok(!after.items.some((item) => [wrong.id, legacy.id].includes(item.id)))
  assert.equal(after.items.find((item) => item.id === good.id).reference.target.commit, image.commitment)
  const changes = await api('changes', { generation: before.at.generation, after: before.at.sequence, scope: { account: image.author } })
  assert.ok(changes.references.some((item) => item.id === good.id), 'late body appears in incremental notifications')
  assert.ok(!changes.references.some((item) => [wrong.id, legacy.id].includes(item.id)))
  const invalid = await fetch(`${site}/api/chains/${chain}/message/${target.id}?commit=0x${'00'.repeat(32)}`, { signal: AbortSignal.timeout(5000) })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error, 'commitment_mismatch')
  console.log('Quote checks passed: mismatched pin rejected, unpinned reference ignored, valid late body indexed.')
}

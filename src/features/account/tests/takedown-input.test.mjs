import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../../scripts/harness.mjs'

const { parseTakedownInput, attachmentHashes } = await load('features/account/takedown-input.ts')
after(teardown)
const hash = (b) => `0x${b.repeat(32)}`

test('a pasted post link names its chain and post; a hash or content link names the hash', () => {
  assert.deepEqual(parseTakedownInput('https://blohard.social/p/8453/12'), { kind: 'post', chainId: 8453, id: 12n })
  assert.deepEqual(parseTakedownInput('https://blohard.social/#/p/84532/7?commit=0xab'), { kind: 'post', chainId: 84532, id: 7n })
  assert.deepEqual(parseTakedownInput(hash('AB')), { kind: 'hash', hash: hash('ab') })
  assert.deepEqual(parseTakedownInput(`https://blohard.social/api/content/${hash('cd')}`), { kind: 'hash', hash: hash('cd') })
  for (const text of ['', 'hello', '/p/0/1', '/p/8453/0', `${hash('ab')}ff`]) {
    assert.equal(parseTakedownInput(text), null, text)
  }
})

test('every distinct record a text names, in order, wherever it sits in the text', () => {
  const text = `see record:${hash('01')} and ![a](record:${hash('02').toUpperCase().replace('0X', '0x')})\n${'x'.repeat(5000)} record:${hash('01')} record:${hash('03')}`
  assert.deepEqual(attachmentHashes(text), [hash('01'), hash('02'), hash('03')])
  assert.deepEqual(attachmentHashes(`record:${hash('04')}ff`), [], 'a longer hex run is not a hash')
})

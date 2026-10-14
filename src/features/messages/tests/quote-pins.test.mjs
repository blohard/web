// Pins identify the immutable message, across composition and navigation.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../../scripts/harness.mjs'

after(teardown)
const syntax = await load('lib/reference-syntax.ts')
const { draft, quoteLine } = await load('features/publishing/draft.svelte.ts')
globalThis.location = { ...globalThis.location, hash: '' }
const { parse, href } = await load('features/navigation/router.svelte.ts')
const pin = `0x${'ab'.repeat(32)}`, other = `0x${'cd'.repeat(32)}`
const q = { chainId: 810337, id: 42n, commit: pin }
const uri = `post://810337/42?commit=${pin}`

test('the client encoding matches the independent Solidity pin vector', async () => {
  const { commitment } = await load('lib/api.ts')
  assert.equal(commitment({ author: `0x${'11'.repeat(20)}`, parentId: 7n, timestamp: 0xabcdef01, contentHash: `0x${'22'.repeat(32)}` }),
    '0x4db098ca2d19724366861cb45ccdc8f5ba82751be711c2d37aaa8bcb6daf56c7')
})

test('post references consume the entire token, without downgrading a malformed pin', () => {
  assert.deepEqual(syntax.parsePostReference(uri), q)
  assert.deepEqual(syntax.parsePostReference('post://810337/42'), { chainId: 810337, id: 42n })
  for (const invalid of [uri + '.', uri + '&extra=1', uri + '?x', uri + '#x', uri.replace(pin, pin.toUpperCase()),
    'post://0/42', 'post://01/42', 'post://1/0', 'post://1/042', 'post://9007199254740992/1',
    'post://1/18446744073709551616', 'post://1/2?commit=bad']) {
    assert.equal(syntax.parsePostReference(invalid), null, invalid)
  }
  // A token ends at a closing bracket; a trailing full stop is part of it, and so makes it invalid.
  assert.deepEqual(syntax.textReferences(uri + ') more'), [uri])
  assert.deepEqual(syntax.textReferences(uri + '. more'), [uri + '.'])
  assert.equal(syntax.parseAccountReference(`account://0x${'11'.repeat(20)}extra`), null)
})

test('the eight-reference budget counts malformed tokens and repetitions too', () => {
  const body = `${Array(7).fill('post://bad').join(' ')} ${uri} account://bad`
  assert.equal(syntax.textReferences(body).length, 8)
  assert.equal(syntax.textReferences(body, 9).length, 9)
  assert.equal(syntax.textReferences(body)[7], uri)
})

test('a saved quote is byte-identical through navigation, failed submission and retry', () => {
  draft.clear()
  const stop = draft.onPress(() => {})
  const supplied = { ...q }
  draft.add(supplied)
  supplied.commit = other
  assert.equal(quoteLine(draft.quotes[0]), uri, 'the draft owns its captured pin')
  const sent = draft.begin()
  draft.fail(sent)
  stop()
  const back = draft.onPress(() => {})
  assert.equal(quoteLine(draft.quotes[0]), uri)
  assert.throws(() => draft.add({ ...q, commit: other }), /commitment/)
  assert.equal(quoteLine(draft.quotes[0]), uri)
  const retry = draft.begin()
  assert.equal(quoteLine(draft.quotes[0]), uri)
  assert.equal(draft.finish(retry), true)
  back()
})

test('thread links preserve pins, and malformed query strings cannot open an unpinned thread', () => {
  const link = href.thread(q.chainId, q.id, q.commit)
  assert.deepEqual(parse(link), { kind: 'thread', ...q, reply: false })
  assert.deepEqual(parse(href.reply(q.chainId, q.id, q.commit)), { kind: 'thread', ...q, reply: true })
  assert.equal(parse(href.reply(q.chainId, q.id)).reply, true)
  for (const suffix of ['?commit=bad', `?commit=${pin}&commit=${other}`, `?commit=${pin}?oops`]) {
    assert.equal(parse(`/p/810337/42${suffix}`).kind, 'unknown', suffix)
  }
})

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../scripts/harness.mjs'

const { PostList } = await load('shared/post-list.svelte.ts')
after(teardown)
const settle = () => new Promise(resolve => setImmediate(resolve))
const node = order => ({ order, compareDocumentPosition: other => order > other.order ? 2 : 4 })

test('out-of-order mounts and completions reveal only the ready prefix', async () => {
  const list = new PostList(), nodes = [node(1), node(2), node(3), node(4)]
  const ready = [true, false, true, false], shown = []
  for (const i of [3, 1, 0, 2]) list.register(nodes[i], () => ready[i], () => shown.push(i))
  await settle()
  assert.deepEqual(shown, [0])
  assert.equal(list.first, nodes[1])
  ready[3] = true
  ready[0] = false // A row already on screen keeps its place.
  list.changed()
  await settle()
  assert.deepEqual(shown, [0])
  ready[1] = true
  list.changed()
  await settle()
  assert.deepEqual(shown, [0, 1, 2, 3])
  assert.equal(list.first, null)
})

test('removing the first pending row releases later rows and ignores its late answer', async () => {
  const list = new PostList(), next = node(2), shown = []
  const pending = list.register(node(1), () => false, () => assert.fail())
  list.register(next, () => true, () => shown.push(next))
  await settle()
  pending.destroy()
  list.changed()
  await settle()
  assert.deepEqual(shown, [next])
  assert.equal(list.first, null)
})

test('newly mounted nested content participates before a ready row is revealed', async () => {
  const list = new PostList(), row = node(1), checks = [() => true]
  let bodyReady = false, shown = false
  list.register(row, () => checks.every(check => check()), () => { shown = true })
  checks.push(() => bodyReady)
  await settle()
  assert.equal(list.first, row)
  assert.equal(shown, false)
  bodyReady = true
  list.changed()
  await settle()
  assert.equal(shown, true)
})

test('an open branch can reveal its own ready prefix while only the earliest wait has the indicator', async () => {
  const list = new PostList(), branch = {}, first = node(1), nested = node(3), shown = []
  let ready = false
  list.register(first, () => ready, () => shown.push('post'))
  list.register(node(2), () => true, () => shown.push('first reply'), branch)
  list.register(nested, () => false, () => assert.fail(), branch)
  list.register(node(4), () => true, () => shown.push('next post'))
  await settle()
  assert.deepEqual(shown, ['first reply'])
  assert.equal(list.first, first)
  assert.equal(list.pageRowsPending, true)
  ready = true
  list.changed()
  await settle()
  assert.deepEqual(shown, ['first reply', 'post', 'next post'])
  assert.equal(list.first, nested)
  assert.equal(list.pageRowsPending, false)
})

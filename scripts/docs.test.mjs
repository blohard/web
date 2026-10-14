import test from 'node:test'
import assert from 'node:assert/strict'
import { DOCS, render, rewriteLink, slug } from './docs.mjs'

test('heading anchors follow the repository convention', () => {
  const seen = new Map()
  assert.equal(slug('5.4 Why there is no pin against gate swaps', seen), '54-why-there-is-no-pin-against-gate-swaps')
  assert.equal(slug('The `replyGate` rule', seen), 'the-replygate-rule')
  assert.equal(slug('Terminology', seen), 'terminology')
  assert.equal(slug('Terminology', seen), 'terminology-1', 'a repeated heading gets a suffix')
})

test('the spec stays on site; contract and deployment links use the pinned public repository', () => {
  assert.equal(rewriteLink('./SPEC.md#4-the-board'), '/design.html#4-the-board')
  assert.match(rewriteLink('src/IBoard.sol'), /^https:\/\/github\.com\/blohard\/protocol\/blob\/[0-9a-f]{40}\/src\/IBoard\.sol$/)
  const contractRevision = rewriteLink('src/IBoard.sol').split('/')[6]
  assert.equal(rewriteLink('deployments.json'), `https://github.com/blohard/protocol/blob/${contractRevision}/deployments.json`)
  assert.equal(rewriteLink('https://blohard.social'), 'https://blohard.social')
  assert.equal(rewriteLink('#terms'), '#terms')
})

test('the protocol page keeps headings, tables and working public source links', () => {
  const md = '# Title\n\n## Messages\n\nSee [the interface](src/IBoard.sol) and [deployments](deployments.json).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
  const html = render(DOCS[0], md, ', commit abc1234, 2026-09-09')
  assert.match(html, /<h2 id="messages">Messages<\/h2>/)
  assert.match(html, /href="https:\/\/github\.com\/blohard\/protocol\/blob\/[0-9a-f]{40}\/src\/IBoard\.sol"/)
  assert.match(html, /href="https:\/\/github\.com\/blohard\/protocol\/blob\/[0-9a-f]{40}\/deployments\.json"/)
  assert.match(html, /<table>/)
  assert.match(html, /<span class="here">design<\/span>/)
  assert.match(html, /rendered from SPEC\.md in the blohard\/protocol repository, commit abc1234/)
})

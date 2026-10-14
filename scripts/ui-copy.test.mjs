import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { copyIssues } from './ui-copy.mjs'

test('literal UI copy uses lowercase and simple punctuation', () => {
  const root = new URL('../src/', import.meta.url)
  // Skip dot-files such as macOS `._` metadata left by copying a checkout.
  const issues = readdirSync(root, { recursive: true })
    .filter(f => f.endsWith('.svelte') && !f.split('/').some(part => part.startsWith('.')))
    .flatMap(file => copyIssues(readFileSync(new URL(file, root), 'utf8')).map(issue => `${file}:${issue}`))
  assert.deepEqual(issues, [])
})

test('copy check inspects rendered text and accessible labels, not code or technical attributes', () => {
  assert.equal(copyIssues('<p>Oops: try again; not-now — please</p>').length, 1)
  for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
    assert.equal(copyIssues(`<input ${attr}="Oops" />`).length, 1)
  }
  assert.deepEqual(copyIssues(`<script>const value = 'Do: this';</script>
    <p class="Mixed-Case" id="Mixed-ID">Base Sepolia · ENS · ETH · MetaMask · Coinbase Wallet</p>
    <a href="https://example.com/A-B">link</a><pre>Code: With-Dashes;</pre>
    <p>{value}</p><svg viewBox="0 0 20 20"><path d="M1-2" /></svg>`), [])
  assert.equal(copyIssues('<p>ENSURE this</p>').length, 1, 'proper names do not allow arbitrary capitalized words')
})


test('word hyphens and the pronoun I are allowed, separator dashes are not', () => {
  assert.deepEqual(copyIssues('<p>keys I hold · built-in browser · on-chain · smart-contract wallets · account-key market · Base-based · peer-to-peer</p>'), [])
  for (const text of ['one - two', 'one--two', 'one–two', 'one—two', '-one', 'one-', 'one: two', 'one; two', 'IKEA', 'Initial']) {
    assert.equal(copyIssues(`<p>${text}</p>`).length, 1, text)
  }
})

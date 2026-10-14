import { parse } from 'svelte/compiler'

// Product names, conventional units and the pronoun I keep their spelling. Code examples and
// expressions are deliberately outside this literal-copy check.
const names = /\b(?:I|Base Sepolia|Base|Basenames?|ENS|ETH|RPC|URL|MetaMask|Coinbase Wallet)\b/g
const attributes = new Set(['title', 'aria-label', 'placeholder', 'alt'])
export function copyIssues(source) {
  const issues = []
  function check(node) {
    const text = node.data.replace(/(?<=[a-zA-Z])-(?=[a-zA-Z])/g, ' ').replace(names, '')
    if (/[A-Z:;\u2013\u2014-]/.test(text)) {
      const line = source.slice(0, node.start).split('\n').length
      issues.push(`${line}: ${node.data.trim()}`)
    }
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (['script', 'style', 'pre', 'code'].includes(node.name)) return
    if (node.type === 'Text') { check(node); return }
    if (node.type === 'Attribute') {
      if (attributes.has(node.name) && Array.isArray(node.value)) {
        for (const part of node.value) if (part.type === 'Text') check(part)
      }
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (['expression', 'attributes', 'instance', 'module', 'css'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
    node.attributes?.forEach(visit)
  }
  visit(parse(source, { modern: true }).fragment)
  return issues
}

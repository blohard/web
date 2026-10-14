// Keep the public bot guide's body encoding and hash vector accurate.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { keccak256, toHex } from 'viem'

const guide = await readFile(new URL('../public/bots.md', import.meta.url), 'utf8')
const after = (label) => guide.match(new RegExp(`${label}\\s+\`(0x[0-9a-fA-F]+)\``))[1]

test("the guide's body test vector matches its encoding and hash", () => {
  const bytes = new TextEncoder().encode('version/1 text/plain\nhello from a script')
  assert.equal(toHex(bytes), after('bytes'))
  assert.equal(keccak256(bytes), after('content hash'))
})

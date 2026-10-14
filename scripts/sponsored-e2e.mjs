// End-to-end check of sponsorship on the load-test stack: a member posts
// through the relayer, then deletes the post with a wallet-paid send.
// Signs with a key derived from an owner-readable-only test mnemonic file.
//
//   MNEMONIC_FILE=… RPC=http://127.0.0.1:8546 RELAY=http://127.0.0.1:8082 BOARD=0x… CHAIN_ID=810338 \
//   REGISTRY=0x… LIST_OWNER=0x… LIST=sponsored node scripts/sponsored-e2e.mjs
//
// The first derived account (indices 0 to MAX_INDEX) that is on the sponsor
// list is the member.
import { stat, readFile } from 'node:fs/promises'
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, parseEventLogs, stringToBytes } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { boardDomain, POST_TYPES } from '../src/lib/signing.js'

const env = (name, fallback) => process.env[name] ?? fallback ?? (() => { throw new Error(`set ${name}`) })()
const RPC = env('RPC', 'http://127.0.0.1:8546')
const RELAY = env('RELAY', 'http://127.0.0.1:8082')
const BOARD = env('BOARD')
const CHAIN_ID = Number(env('CHAIN_ID', '810338'))
const REGISTRY = env('REGISTRY')
const LIST_OWNER = env('LIST_OWNER')
const LIST = env('LIST', 'sponsored')
const MAX_INDEX = Number(env('MAX_INDEX', '40'))

const info = await stat(env('MNEMONIC_FILE'))
if (!info.isFile() || (info.mode & 0o077)) throw new Error('the mnemonic file must be readable only by its owner (chmod 600)')
const mnemonic = (await readFile(process.env.MNEMONIC_FILE, 'utf8')).trim()

const chain = { id: CHAIN_ID, name: 'e2e', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }
const pub = createPublicClient({ chain, transport: http(RPC) })
const domain = boardDomain({ id: CHAIN_ID, contract: BOARD })
const zero = '0x0000000000000000000000000000000000000000'
const TOMBSTONE = '0x0000000000000000000000000000000000000001'
const boardAbi = parseAbi([
  'event Posted(address indexed author, uint64 indexed parentId, address indexed parentAuthor, uint64 id, bytes32 contentHash, address replyGate)',
  'event ReplyGateChanged(uint64 indexed id, address oldGate, address newGate)',
  'function setReplyGate(uint64 id, address gate)',
  'function effectiveGate(uint64 id) view returns (address)',
  'function authorGate(address author) view returns (address)',
])
const registryAbi = parseAbi(['function contains(address owner, bytes32 listId, address member) view returns (bool)'])
const listId = keccak256(stringToBytes(LIST))

let failures = 0
const expect = (label, got, want) => {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${got}${ok ? '' : ` (expected ${want})`}`)
}
const isMember = (address) => pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'contains', args: [LIST_OWNER, listId, address] })

let member = null
for (let i = 0; i <= MAX_INDEX && !member; i++) {
  const account = mnemonicToAccount(mnemonic, { addressIndex: i })
  if (await isMember(account.address)) member = account
}
if (!member) throw new Error(`no derived account up to index ${MAX_INDEX} is on the list ${LIST}`)

const nonce = () => BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`)
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600)
const post = (path, body) => fetch(`${RELAY}/api/relay/${CHAIN_ID}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (res) => ({ status: res.status, json: await res.json().catch(() => ({})) }))

// A post to delete, through the relayer.
const wallet = createWalletClient({ account: member, chain, transport: http(RPC) })
const body = `version/1 text/plain\nsponsored moderation check ${Date.now()}\n`
const postMessage = { author: member.address, contentHash: keccak256(stringToBytes(body)), parentId: 0n, replyGate: zero, nonce: nonce(), deadline: deadline() }
const postSig = await wallet.signTypedData({ domain, types: POST_TYPES, primaryType: 'Post', message: postMessage })
const posted = await post('post', { author: member.address, contentHash: postMessage.contentHash, parentId: '0', replyGate: zero, nonce: postMessage.nonce.toString(), deadline: postMessage.deadline.toString(), sig: postSig, gateData: '0x' })
expect('member post relayed', posted.status, 200)
if (posted.status !== 200) {
  console.log(posted.json)
  process.exit(1)
}
const postReceipt = await pub.waitForTransactionReceipt({ hash: posted.json.tx_hash })
const [postedLog] = parseEventLogs({ abi: boardAbi, eventName: 'Posted', logs: postReceipt.logs })
const id = postedLog.args.id
console.log('posted message', id.toString(), 'in tx', posted.json.tx_hash)

const hash = await wallet.writeContract({ address: BOARD, abi: boardAbi, functionName: 'setReplyGate', args: [id, TOMBSTONE] })
const receipt = await pub.waitForTransactionReceipt({ hash })
expect('wallet-paid deletion mined', receipt.status, 'success')
const [changed] = parseEventLogs({ abi: boardAbi, eventName: 'ReplyGateChanged', logs: receipt.logs })
expect('the gate event names the message', changed?.args.id, id)
expect('the message is now retracted', (await pub.readContract({ address: BOARD, abi: boardAbi, functionName: 'effectiveGate', args: [id] })).toLowerCase(), TOMBSTONE)

console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)

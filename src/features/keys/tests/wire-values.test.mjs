import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { getAddress } from 'viem'
import { load, install, teardown, mock, address, hash } from '../../../../scripts/harness.mjs'
const { readKeyActivity } = await load('features/keys/key-activity.ts')
const { readKeyNotifications } = await load('features/keys/key-notifications.svelte.ts')
const { readKeyringPage } = await load('features/keys/keyring-balances.ts')
beforeEach(install)
after(teardown)
const market = address('77'), account = address('22'), party = address('ab')
const checkpoint = { block: '18446744073709551615', hash: hash('AB') }
const position = { block: checkpoint.block, log: 0xffff_ffff }
const common = { position, timestamp: 0xffff_ffff, transaction: hash('AB') }

test('key endpoints preserve checksum output, hash casing and maximum wire integers', async () => {
  globalThis.fetch = async () => Response.json({ market, checkpoint, next: null, items: [
    { ...common, event: { kind: 'activated', creator: party, amount: 0 } },
  ] })
  const activity = (await readKeyActivity(mock.chain, market)).items[0]
  assert.equal(activity.creator, getAddress(party))
  assert.equal(activity.transaction, common.transaction)
  assert.equal(activity.block, BigInt(position.block))
  assert.equal(activity.log, position.log)
  globalThis.fetch = async () => Response.json({ market, checkpoint, active: true, next: null, truncated: false,
    items: [{ ...common, kind: 'trade', trader: party, buy: true, amount: 0xffff_ffff }] })
  const notice = (await readKeyNotifications(mock.chain, market, account)).items[0]
  assert.equal(notice.trader, getAddress(party)); assert.equal(notice.amount, 0xffff_ffff)
  assert.equal(notice.transaction, common.transaction)
  globalThis.fetch = async () => Response.json({ market, view: 'holding', active: true, own_balance: 0xffff_ffff,
    total: 2, entries: [{ address: party, balance: 0xffff_ffff }], next: party, checkpoint })
  const page = await readKeyringPage(mock.chain, account, market, 'holding', null, 1)
  assert.equal(page.entries[0].address, getAddress(party)); assert.equal(page.next, getAddress(party))
  assert.equal(page.checkpoint.hash, checkpoint.hash)
})

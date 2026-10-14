// Contract events -> live host index -> production client decoders.
import assert from 'node:assert/strict'
import { build, createServer } from 'vite'
import { readFile, mkdir, rename } from 'node:fs/promises'
import { checkDeployment } from '../check-deployment.mjs'
import { mnemonicToAccount } from 'viem/accounts'
import { withStack, waitFor } from './stack.mjs'

await withStack(async (stack) => {
  const originalFetch = globalThis.fetch
  const server = await createServer({ root: stack.web, logLevel: 'warn',
    server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' })
  globalThis.fetch = (input, init) => originalFetch(typeof input === 'string' ? new URL(input, stack.site) : input, init)
  try {
    const load = name => server.ssrLoadModule(`/src/${name}`)
    const { getStatus } = await load('lib/store.ts')
    const { readKeyring } = await load('features/keys/keyring.ts')
    const { readKeyringPage } = await load('features/keys/keyring-balances.ts')
    const { readKeyNotifications } = await load('features/keys/key-notifications.svelte.ts')
    await waitFor(async () => {
      const status = await getStatus()
      return status.chains[0].blocking && status.chains[0].key_gates?.holders_blocklist
    }, 'key gates verified')
    const status = await getStatus(), chain = status.chains[0], market = stack.market
    assert.equal(status.keyrings[0].market.toLowerCase(), market.address.toLowerCase())
    assert.equal(chain.key_gates.holders.toLowerCase(), stack.holders.address.toLowerCase())
    assert.equal(chain.key_gates.holders_blocklist.toLowerCase(), stack.combined.address.toLowerCase())
    // Use Vite's emitted metadata, not the shell's current environment, for the
    // pre-publication check. Only disposable Anvil addresses enter this build.
    const variables = { VITE_ACCOUNT_KEYS_ADDRESS: market.address, VITE_ACCOUNT_KEYS_DEV_FUND: stack.account.address }
    const saved = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]))
    try {
      Object.assign(process.env, variables)
      await build({ root: stack.web, envDir: false, logLevel: 'error',
        build: { outDir: `${stack.dir}/web-dist`, emptyOutDir: true } })
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const built = JSON.parse(await readFile(`${stack.dir}/web-dist/deployment.json`, 'utf8'))
    checkDeployment(built, status)
    assert.throws(() => checkDeployment({ ...built, market: stack.board.address }, status), /markets differ/)
    const creator = mnemonicToAccount(stack.mnemonic, { addressIndex: 1 })
    const buyer = mnemonicToAccount(stack.mnemonic, { addressIndex: 2 })
    const recipient = mnemonicToAccount(stack.mnemonic, { addressIndex: 3 })
    const call = (functionName, args) => stack.reader.readContract({ ...market, functionName, args })
    const deadline = (await stack.reader.getBlock()).timestamp + 3600n
    async function send(account, functionName, args, value = 0n) {
      const hash = await stack.wallet.writeContract({ ...market, account, functionName, args, value })
      const receipt = await stack.reader.waitForTransactionReceipt({ hash })
      assert.equal(receipt.status, 'success')
      await stack.reader.request({ method: 'anvil_mine', params: ['0xc'] })
      await waitFor(async () => {
        try { return (await readKeyringPage(chain, creator.address, market.address, 'holders', null)).checkpoint.block >= receipt.blockNumber }
        catch (error) { if (error.status === 503) return false; throw error }
      }, `key index accepted ${functionName}`)
      return receipt
    }
    const quote = await call('quoteAtSupply', [0n, 2n])
    await send(creator, 'activate', [2n, quote.total, deadline], quote.total)
    assert.equal((await readKeyring(chain, creator.address, market.address)).active, true)
    assert.equal((await readKeyringPage(chain, creator.address, market.address, 'holders', null)).ownBalance, 2)
    const buyQuote = await call('quoteBuy', [creator.address, 3n])
    const bought = await send(buyer, 'buy', [creator.address, 3n, buyQuote.total, deadline], buyQuote.total)
    const transferQuote = await call('quoteTransfer', [creator.address, 2n])
    const moved = await send(buyer, 'transfer', [creator.address, recipient.address, 2n, transferQuote.total, deadline], transferQuote.total)
    const sellQuote = await call('quoteSell', [creator.address, 1n])
    const sold = await send(recipient, 'sell', [creator.address, 1n, sellQuote.total, deadline])
    async function check() {
      const ring = await readKeyring(chain, creator.address, market.address)
      assert.deepEqual(ring.holders.sort(), [buyer.address, recipient.address].sort())
      assert.deepEqual(ring.holding, [])
      // Read one row at a time to exercise real cursors, not just the first page.
      const first = await readKeyringPage(chain, creator.address, market.address, 'holders', null, 1)
      assert.equal(first.ownBalance, 2)
      assert.equal(first.total, 2)
      assert.ok(first.next)
      const second = await readKeyringPage(chain, creator.address, market.address, 'holders', first.next, 1)
      assert.equal(second.next, null)
      assert.deepEqual([...first.entries, ...second.entries].map(e => [e.address, e.balance]),
        [buyer.address, recipient.address].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map(a => [a, 1]))
      for (const holder of [buyer, recipient]) {
        const page = await readKeyringPage(chain, holder.address, market.address, 'holding', null)
        assert.equal(page.active, false)
        assert.deepEqual(page.entries, [{ address: creator.address, balance: 1 }])
        assert.deepEqual((await readKeyring(chain, holder.address, market.address)).holding, [creator.address])
      }
      const page = await readKeyNotifications(chain, market.address, creator.address, null, 1)
      assert.ok(page.next)
      assert.deepEqual(page.items.map(n => [n.trader, n.buy, n.amount, n.transaction]), [[recipient.address, false, 1, sold.transactionHash]])
      const older = await readKeyNotifications(chain, market.address, creator.address, page.next, 1)
      assert.equal(older.next, null)
      assert.deepEqual(older.items.map(n => [n.trader, n.buy, n.amount, n.transaction]), [[buyer.address, true, 3, bought.transactionHash]])
      // The recipient hears about the keys sent to them, with no market of their own.
      const gifts = await readKeyNotifications(chain, market.address, recipient.address)
      assert.deepEqual(gifts.items.map(n => [n.kind, n.from, n.creator, n.amount, n.transaction]),
        [['key-received', buyer.address, creator.address, 2, moved.transactionHash]])
      for (const notice of [...page.items, ...older.items]) {
        assert.equal(BigInt(notice.timestamp), (await stack.reader.getBlock({ blockNumber: notice.block })).timestamp)
      }
    }
    await check()
    await stack.restartHost()
    await waitFor(async () => {
      try { await readKeyringPage(chain, creator.address, market.address, 'holders', null); return true }
      catch (error) { if (error.status === 503) return false; throw error }
    }, 'restored key index ready')
    await check()
    // Exercise the operator rebuild procedure against disposable data. Keep the
    // Board journal and content stores in place, and preserve the old keyring.
    await stack.restartHost(async () => {
      await mkdir(`${stack.dir}/quarantined-keyring`)
      for (const suffix of ['data', 'offsets-blobs', 'offsets-metadata']) {
        const name = `keyring-${chain.id}-${market.address.toLowerCase()}_${suffix}`
        await rename(`${stack.dir}/data/${name}`, `${stack.dir}/quarantined-keyring/${name}`)
      }
    })
    await waitFor(async () => {
      try { await readKeyringPage(chain, creator.address, market.address, 'holders', null); return true }
      catch (error) { if (error.status === 503) return false; throw error }
    }, 'rebuilt key index ready')
    await check()
    console.log('ok: account keys activate, buy, transfer, sell, page and survive restart through production decoders')
  } finally {
    globalThis.fetch = originalFetch
    await server.close()
  }
}, { accountKeys: true })

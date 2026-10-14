// The bots guide's reference script (public/bots/bot.mjs), run against the
// local stack exactly as a bot author would run it: post, mention, answer a
// mention, repeat a request safely and read refusal codes. Never the live site.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mnemonicToAccount } from 'viem/accounts'
import { withStack, waitFor } from './stack.mjs'
import * as bot from '../../public/bots/bot.mjs'

// Anvil mines at once: run the bot's polling and retry waits at a tenth.
bot.pause.scale = 0.1

await withStack(async (stack) => {
  const { site } = stack, chainId = stack.chain.id
  // The stack sponsors mnemonic accounts 1 to 4; account 10 is not on the list.
  const alice = mnemonicToAccount(stack.mnemonic, { addressIndex: 1 })
  const bob = mnemonicToAccount(stack.mnemonic, { addressIndex: 2 })
  const stranger = mnemonicToAccount(stack.mnemonic, { addressIndex: 10 })

  const first = await bot.post(site, chainId, alice, 'hello from a script')
  assert.equal(first.author.toLowerCase(), alice.address.toLowerCase())
  const { relayer } = await (await fetch(`${site}/api/relay/status`)).json()
  const sent = await stack.reader.getTransaction({ hash: first.transaction })
  assert.equal(sent.from.toLowerCase(), relayer.toLowerCase(), 'the relayer pays, not the author')
  await waitFor(async () => (await bot.textOf(site, chainId, first)) === 'hello from a script', 'the post body is served')

  // A repeated request is answered with the same transaction, before and after it lands.
  const chain = await bot.chainOf(site, chainId)
  const bytes = bot.envelope('said once')
  const request = await bot.sign(alice, chain, { bytes })
  const hash = await bot.send(site, chainId, request)
  assert.equal(await bot.send(site, chainId, request), hash, 'a repeat names the same transaction')
  await bot.upload(site, chainId, bytes, { txHash: hash })
  await bot.landed(site, chainId, hash)
  assert.equal(await bot.send(site, chainId, request), hash, 'so does a repeat after it landed')

  // A bot answers its mentions, and only once each.
  const answered = []
  const stop = new AbortController()
  const running = bot.run({
    site, chainId, account: alice, every: 500, signal: stop.signal, state: await mkdtemp(join(tmpdir(), 'blohard-bot-')),
    answer: async (text, record) => { answered.push(record.id); return `you said ${text.length} characters` },
  })
  await new Promise((resolve) => setTimeout(resolve, 1_000)) // let it record what it has already seen
  const asking = await bot.post(site, chainId, bob, `hi ${bot.mention('alice', alice.address)}`)
  const replyOf = async () => (await bot.notifications(site, chainId, bob.address)).find((r) => r.parent === asking.id && r.author.toLowerCase() === alice.address.toLowerCase())
  await waitFor(replyOf, 'the bot answers the mention', 60_000)
  const said = `you said ${`hi ${bot.mention('alice', alice.address)}`.length} characters`
  // A body is served once the host accepts its message, a moment after the receipt.
  await waitFor(async () => (await bot.textOf(site, chainId, await replyOf())) === said, 'the answer is served')
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  stop.abort()
  await running
  assert.deepEqual(answered, [asking.id], 'one answer per mention, none to anything older')
  // It said it is a bot, in the text the real host checks, so readers see a robot by its name.
  const { host_policy: policy } = await (await fetch(`${site}/api/status`)).json()
  assert.ok(policy.declared_bots.some((a) => a.toLowerCase() === alice.address.toLowerCase()), 'the bot declares itself')

  // A signature the author did not make is refused before anything is sent.
  const forged = await bot.sign(alice, chain, { bytes: bot.envelope('forged') })
  forged.sig = forged.sig.slice(0, -2) + (forged.sig.endsWith('1b') ? '1c' : '1b')
  const tampered = await bot.send(site, chainId, forged).catch((e) => e)
  assert.ok(tampered instanceof bot.Refused, String(tampered))
  assert.equal(tampered.outcome, 'refused')
  assert.equal(tampered.status, 403, tampered.message)

  // Refusals carry a code: an account the relayer does not sponsor is declined.
  const declined = await bot.send(site, chainId, await bot.sign(stranger, chain, { bytes: bot.envelope('not sponsored') })).catch((e) => e)
  assert.ok(declined instanceof bot.Refused, String(declined))
  assert.equal(declined.code, 'not_eligible')
  assert.equal(declined.outcome, 'refused')
  console.log('ok: the reference bot posts, answers a mention once, declares itself, repeats safely and reads refusal codes')
})

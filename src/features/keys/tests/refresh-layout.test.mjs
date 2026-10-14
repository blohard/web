import assert from 'node:assert/strict'
import { after, test } from 'node:test'
process.env.VITE_ACCOUNT_KEYS_ADDRESS = '0x1111111111111111111111111111111111111111'
process.env.VITE_ACCOUNT_KEYS_DEV_FUND = '0x3333333333333333333333333333333333333333'
const { load, install, teardown, mock, author, renderComponent } = await import('../../../../scripts/harness.mjs')
const { Resource } = await load('shared/resource.svelte.ts')
const { wallet } = await load('lib/wallet.svelte.ts')
after(teardown)

// Exercise the real templates with a retained result and a read still pending.
for (const component of ['features/keys/KeyMarket.svelte', 'features/keys/AccountKeys.svelte']) {
  test(`${component} keeps loaded account content during refresh`, async t => {
    install()
    const previous = wallet.account
    wallet.account = author
    t.after(() => { wallet.account = previous })
    const original = Resource.prototype.value
    let pending = false
    t.mock.method(Resource.prototype, 'value', function (...args) {
      if (!args.length) {
        this.pending = pending
        return { active: true, supply: 10n, holdings: 2n, fees: 1n }
      }
      return original.apply(this, args)
    })

    const props = { chain: { ...mock.chain, id: 84532 }, creator: author }
    const before = await renderComponent(component, props)
    pending = true
    const during = await renderComponent(component, props)
    assert.match(before, /keys in circulation/)
    assert.match(during, /keys in circulation/)
    assert.doesNotMatch(during, /loading account keys…|checking your account keys…/)
    assert.equal(during, before, 'an unchanged refresh must preserve the rendered content')
  })
}

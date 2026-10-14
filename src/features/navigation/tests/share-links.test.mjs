import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { load, teardown } from '../../../../scripts/harness.mjs'
const originalWindow = globalThis.window, originalHistory = globalThis.history, originalElement = globalThis.Element
const events = new EventTarget()
events.scrollTo = () => {}
globalThis.window = events
globalThis.location = new URL('https://client.invalid/p/8453/42')
const entries = [{ url: location.href, state: null }]
let cursor = 0
globalThis.history = {
  get state() { return entries[cursor].state },
  replaceState(state, _, url) {
    entries[cursor].state = state
    if (url !== undefined) {
      globalThis.location = new URL(url, location)
      entries[cursor].url = location.href
    }
  },
  pushState(state, _, url) {
    entries.splice(cursor + 1)
    globalThis.location = new URL(url, location)
    entries.push({ url: location.href, state }); cursor++
  },
  back() { if (cursor > 0) { cursor--; restore() } },
  forward() { if (cursor + 1 < entries.length) { cursor++; restore() } },
}
function restore() {
  globalThis.location = new URL(entries[cursor].url)
  window.dispatchEvent(new Event('popstate'))
  window.dispatchEvent(new Event('hashchange'))
}
after(async () => { globalThis.window = originalWindow; globalThis.history = originalHistory; globalThis.Element = originalElement; await teardown() })
const { parse, parseLocation, href, router } = await load('features/navigation/router.svelte.ts')

test('share links open threads, including pinned replies; old hashes do not', () => {
  const commit = `0x${'ab'.repeat(32)}`
  assert.equal(href.thread(8453, 42n), '/p/8453/42')
  assert.equal(href.thread(8453, 42n, commit), `/p/8453/42?commit=${commit}`)
  assert.deepEqual(parseLocation('/p/8453/42'), { kind: 'thread', chainId: 8453, id: 42n, reply: false })
  assert.deepEqual(parseLocation('/p/8453/42', `?reply&commit=${commit}`), { kind: 'thread', chainId: 8453, id: 42n, commit, reply: true })
  for (const old of ['#/m/8453/42', '#/p/8453/42']) assert.equal(parse(old).kind, 'unknown', old)
  assert.deepEqual(parseLocation('/p/8453/42', '', '#/'), { kind: 'home' })
  for (const path of ['/p/0/1', '/p/8453/0', '/p/8453/18446744073709551616', '/p/no/1', '/p/8453/42?commit=bad']) {
    assert.equal(parse(path).kind, 'unknown', path)
  }
})

 test('clean-path navigation preserves visits through Back, Forward, replies and Home', () => {
  assert.equal(router.route.id, 42n)
  const firstVisit = router.visit
  router.go('/p/8453/43')
  assert.equal(router.route.id, 43n)
  const nextVisit = router.visit
  history.back()
  assert.equal(router.route.id, 42n)
  assert.equal(router.visit, firstVisit)
  history.forward()
  assert.equal(router.route.id, 43n)
  assert.equal(router.visit, nextVisit)
  router.go('/p/8453/43?reply')
  assert.equal(router.route.reply, true)
  assert.equal(router.visit, nextVisit)
  router.home()
  assert.equal(location.pathname, '/')
  assert.equal(router.route.kind, 'home')
  assert.equal(router.homeTop, null)
  history.back()
  assert.equal(router.route.id, 43n)
  assert.equal(router.route.reply, true)
})

test('profile share URLs resolve to the profile; old hashes do not', () => {
  const address = `0x${'12'.repeat(20)}`
  const path = `/u/84532/${address}`
  assert.equal(href.user(84532, address), path)
  assert.deepEqual(parseLocation(path), { kind: 'user', chainId: 84532, address })
  assert.equal(parse(`#/u/84532/${address}`).kind, 'unknown')
  for (const bad of ['/u/0/' + address, '/u/84532/not-an-address', '/u/9007199254740993/' + address]) {
    assert.equal(parseLocation(bad.split('?')[0], bad.includes('?') ? '?extra' : '').kind, 'unknown', bad)
  }
  router.go(path)
  assert.equal(router.route.kind, 'user')
  const visit = router.visit
  router.go('/p/84532/1')
  history.back()
  assert.equal(router.route.kind, 'user')
  assert.equal(router.visit, visit)
  router.home()
  assert.equal(location.pathname, '/')
  assert.equal(router.route.kind, 'home')
})

test('about pages use clean permalinks and navigate without losing the page', () => {
  assert.equal(href.about(), '/about')
  assert.equal(href.keysAbout(84532), '/keys/84532/about')
  assert.deepEqual(parseLocation('/about'), { kind: 'about' })
  assert.equal(href.about('moderation'), '/about?section=moderation')
  assert.deepEqual(parseLocation('/about', '?section=moderation'), { kind: 'about', section: 'moderation' })
  assert.deepEqual(parseLocation('/about', '?section=%3Cb%3E'), { kind: 'about' }, 'a section is only a page id')
  assert.equal(parse('#/about').kind, 'unknown')
  assert.deepEqual(parseLocation('/keys/84532/about'), { kind: 'keys', chainId: 84532, about: true })
  assert.equal(parse('#/keys/84532/about').kind, 'unknown')
  router.go(href.about('moderation'))
  assert.deepEqual(router.route, { kind: 'about', section: 'moderation' })
  assert.equal(location.pathname + location.search, '/about?section=moderation')
  router.go(href.about())
  assert.equal(router.route.kind, 'about')
  router.go(href.keysAbout(84532))
  assert.deepEqual(router.route, { kind: 'keys', chainId: 84532, about: true })
  history.back()
  assert.equal(router.route.kind, 'about')
  router.home()
  assert.equal(location.pathname, '/')
})

test('profile market permalinks select the keys tab and preserve browser history', () => {
  const address = `0x${'12'.repeat(20)}`
  const path = href.userKeys(84532, address)
  assert.equal(path, `/u/84532/${address}/keys`)
  assert.deepEqual(parseLocation(path), { kind: 'user', chainId: 84532, address, keys: true })
  assert.equal(parseLocation(path + '/extra').kind, 'unknown')
  router.go(href.user(84532, address))
  router.go(path)
  assert.equal(router.route.keys, true)
  history.back()
  assert.equal(router.route.keys, undefined)
  history.forward()
  assert.equal(router.route.keys, true)
})

test('share routes ignore tracking parameters without relaxing post pin validation', () => {
  for (const path of ['/p/8453/42', '/u/84532/0x' + '22'.repeat(20), '/about', '/keys/84532/about']) {
    assert.deepEqual(parseLocation(path, '?fbclid=abc&utm_source=newsletter&unknown=a&unknown=b'), parseLocation(path))
  }
  const pin = '0x' + '11'.repeat(32)
  assert.deepEqual(parseLocation('/p/8453/42', `?fbclid=x&commit=${pin}&reply`), parseLocation('/p/8453/42', `?commit=${pin}&reply`))
  for (const query of ['?fbclid=x&commit=bad', `?commit=${pin}&commit=${pin}`, '?reply=bad&fbclid=x']) {
    assert.equal(parseLocation('/p/8453/42', query).kind, 'unknown')
  }
})


test('profile replies have their own URL and visit, restored by Back and Forward', () => {
  const address = `0x${'12'.repeat(20)}`
  const path = href.userReplies(84532, address)
  assert.equal(path, `/u/84532/${address}/replies`)
  assert.deepEqual(parseLocation(path), { kind: 'user', chainId: 84532, address, replies: true })
  assert.deepEqual(parseLocation(path, '?utm_source=share'), parseLocation(path))
  for (const bad of [path + '/extra', path.replace('/replies', '/posts'), path.replace('84532', '0')]) {
    assert.equal(parseLocation(bad).kind, 'unknown')
  }
  router.go(href.user(84532, address))
  const posts = router.visit
  posts.state('bookmark', () => ({ y: 500 }))
  router.go(path)
  const replies = router.visit
  assert.notEqual(posts, replies)
  assert.equal(router.page, `user/84532/${address}/replies`)
  replies.state('bookmark', () => ({ y: 900 }))
  router.go(path)
  assert.equal(router.visit, replies, 'pressing the selected tab does not leave it')
  router.go(href.userKeys(84532, address))
  history.back()
  assert.equal(router.route.replies, true)
  assert.equal(router.visit, replies)
  assert.equal(router.visit.state('bookmark', () => null).y, 900)
  history.back()
  assert.equal(router.route.replies, undefined)
  assert.equal(router.visit, posts)
  assert.equal(router.visit.state('bookmark', () => null).y, 500)
  history.forward()
  assert.equal(router.route.replies, true)
  assert.equal(router.visit, replies)
})

// Exercise the router's real delegated link handler, including modified clicks.
globalThis.Element = class {
  constructor(path, attributes) { this.href = new URL(path, location).href; this.attributes = attributes; this.target = attributes.target ?? '' }
  closest(selector) { return selector === 'a' ? this : null }
  getAttribute(name) { return name === 'href' ? this.href : this.attributes[name] ?? null }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name) }
}
function clickProfileLink(path, options = {}, attributes = { 'data-page-tab': '' }) {
  const event = new Event('click', { cancelable: true })
  Object.assign(event, { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, options)
  Object.defineProperty(event, 'target', { value: new Element(path, attributes) })
  window.dispatchEvent(event)
  return event
}

test('profile tab clicks replace one visit: Back leaves the profile and Forward returns to its last tab', () => {
  const address = `0x${'34'.repeat(20)}`
  router.go('/p/84532/888')
  const source = router.visit
  source.state('bookmark', () => ({ y: 1200 }))
  router.go(href.user(84532, address))
  const profile = router.visit
  const count = entries.length, index = cursor, marker = { ...history.state.blohard }
  const streams = profile.state('streams', () => new Map([['posts', { y: 500, limit: 40 }]]))
  for (const path of [href.userReplies(84532, address), href.userKeys(84532, address), href.user(84532, address), href.userReplies(84532, address)]) {
    assert.equal(clickProfileLink(path).defaultPrevented, true)
    assert.equal(location.pathname, path)
    assert.equal(entries.length, count, 'a tab adds no Back step')
    assert.equal(cursor, index)
    assert.deepEqual(history.state.blohard, marker, 'the visit marker stays fixed')
    assert.equal(router.visit, profile)
    assert.equal(profile.page, router.page, 'the retained visit names the currently selected tab')
    assert.equal(profile.state('streams', () => null), streams)
  }
  clickProfileLink(href.userReplies(84532, address))
  assert.equal(entries.length, count, 'the selected tab adds no step either')
  router.go('/p/84532/889')
  history.back()
  assert.equal(router.route.replies, true)
  assert.equal(router.visit, profile)
  history.back()
  assert.equal(router.visit, source)
  assert.equal(router.visit.state('bookmark', () => null).y, 1200)
  history.forward()
  assert.equal(router.route.replies, true)
  assert.equal(router.visit, profile)
  assert.deepEqual(profile.state('streams', () => null).get('posts'), { y: 500, limit: 40 })
})

test('only marked links within the same profile replace history', () => {
  const address = `0x${'56'.repeat(20)}`
  const other = `0x${'78'.repeat(20)}`
  router.go(href.user(84532, address))
  for (const [path, attributes] of [
    [href.userReplies(84532, address), {}],
    [href.userKeys(84532, other), { 'data-page-tab': '' }],
    [href.user(8453, other), { 'data-page-tab': '' }],
    ['/p/8453/999', { 'data-page-tab': '' }],
  ]) {
    const before = cursor, visit = router.visit
    assert.equal(clickProfileLink(path, {}, attributes).defaultPrevented, true)
    assert.equal(cursor, before + 1)
    assert.notEqual(router.visit, visit)
  }
})

test('profile tabs retain native modified-click and new-window behavior', () => {
  const address = `0x${'90'.repeat(20)}`
  router.go(href.user(84532, address))
  const before = location.href, index = cursor
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.equal(clickProfileLink(href.userReplies(84532, address), options).defaultPrevented, false)
  }
  assert.equal(clickProfileLink(href.userKeys(84532, address), {}, { 'data-page-tab': '', target: '_blank' }).defaultPrevented, false)
  assert.equal(location.href, before)
  assert.equal(cursor, index)
})


test('keyring tab URLs replace the entry without scrolling while profile navigation remains a Back step', t => {
  const address = `0x${'34'.repeat(20)}`
  const profile = href.userKeys(84532, address)
  router.go(profile)
  const source = router.visit
  assert.equal(clickProfileLink(href.keyring(84532, address), {}, {}).defaultPrevented, true)
  const keyring = router.visit, count = entries.length
  const scroll = t.mock.method(window, 'scrollTo')
  for (const path of [href.keyHolders(84532, address), href.keyring(84532, address), href.keyHolders(84532, address)]) {
    assert.equal(clickProfileLink(path).defaultPrevented, true)
    assert.equal(location.pathname, path)
    assert.equal(entries.length, count)
    assert.equal(router.visit, keyring)
    assert.deepEqual(parseLocation(location.pathname), router.route, 'reload selects the same tab')
    assert.equal(scroll.mock.callCount(), 0, 'switching keyring tabs leaves scrolling alone')
  }
  history.back()
  assert.equal(router.visit, source)
  assert.equal(location.pathname, profile)
  history.forward()
  assert.equal(router.visit, keyring)
  assert.equal(router.route.holders, true)
  const index = cursor
  assert.equal(clickProfileLink(href.keyring(84532, address), { ctrlKey: true }).defaultPrevented, false)
  assert.equal(cursor, index)
  clickProfileLink(href.keyring(84532, `0x${'56'.repeat(20)}`))
  assert.equal(cursor, index + 1, 'a different account starts a visit')
})

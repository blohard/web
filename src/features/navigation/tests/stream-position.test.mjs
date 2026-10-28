import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, teardown } from '../../../../scripts/harness.mjs'

const { rememberStream, streamPosition } = await load('features/navigation/stream-position.ts')
const { feedKey } = await load('features/streams/feed.ts')
const { leavePage, rememberPosition } = await load('features/navigation/page-position.ts')
const { Visits } = await load('features/navigation/visits.ts')
const { holdInView, revealWhen } = await load('features/navigation/scroll.ts')
after(teardown)

// Model layout and browser scroll clamping without a browser or a running host.
function browser(t) {
  const originals = new Map(['window', 'document', 'history', 'location', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const listeners = new Map(), frames = new Map(), observers = new Set()
  let serial = 0
  const win = {
    scrollY: 0, height: 20_000, timeouts: [],
    scrollTo({ top }) { this.scrollY = Math.max(0, Math.min(top, this.height - 600)) },
    scrollBy({ top }) { this.scrollTo({ top: this.scrollY + top }) },
    setTimeout(fn, ms) { this.timeouts.push({ fn, ms }); return this.timeouts.length },
    clearTimeout(id) { if (id) this.timeouts[id - 1] = null },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn) },
    dispatchEvent(event) { input(event.type) },
  }
  globalThis.window = win
  globalThis.document = { body: {}, querySelector: () => ({ getBoundingClientRect: () => ({ height: 40 }) }) }
  // Each entry is a path, query and hash, as share links and app hashes spell them.
  const entries = [{ url: new URL('https://app.invalid/'), state: { other: 'preserved' } }]
  let index = 0
  const push = (url, state) => { entries.splice(index + 1); entries.push({ url, state }); index++ }
  const moved = () => { input('popstate'); input('hashchange') }
  globalThis.history = {
    scrollRestoration: 'auto',
    get state() { return entries[index].state },
    replaceState(state, _, url) {
      entries[index].state = state
      if (url !== undefined) entries[index].url = new URL(url, entries[index].url)
    },
    pushState(state, _, url) { push(new URL(url, entries[index].url), state) },
    back() { if (index > 0) { index--; moved() } },
    forward() { if (index + 1 < entries.length) { index++; moved() } },
  }
  globalThis.location = {
    origin: 'https://app.invalid',
    get pathname() { return entries[index].url.pathname },
    get search() { return entries[index].url.search },
    get hash() { return entries[index].url.hash },
    set hash(hash) {
      const url = new URL(entries[index].url)
      url.hash = hash
      if (url.hash !== entries[index].url.hash) push(url, null)
    },
  }
  globalThis.ResizeObserver = class {
    constructor(fn) { this.fn = fn; observers.add(this) }
    observe() {}
    disconnect() { observers.delete(this) }
  }
  globalThis.requestAnimationFrame = (fn) => { frames.set(++serial, fn); return serial }
  globalThis.cancelAnimationFrame = (id) => frames.delete(id)
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  const node = {
    isConnected: true, spacing: 300, preceding: 0,
    querySelectorAll() {
      return Array.from({ length: 40 }, (_, i) => ({ dataset: { feedRow: `${i}` }, getAttribute: () => `${i}`, isConnected: true,
        getBoundingClientRect: () => ({ top: (i + node.preceding) * node.spacing - win.scrollY, bottom: (i + node.preceding + 1) * node.spacing - win.scrollY }),
      }))
    },
  }
  const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn() }
  const resize = () => { for (const o of observers) o.fn(); flush() }
  const input = (name) => { for (const fn of listeners.get(name) ?? []) fn() }
  const target = (top) => {
    const element = {
      top, isConnected: true, focused: 0, querySelector: () => null,
      getBoundingClientRect: () => ({ top: element.top - win.scrollY }),
      focus(options) { assert.equal(options.preventScroll, true); element.focused++; document.activeElement = element },
    }
    return element
  }
  return { win, node, flush, resize, input, observers, listeners, target, store: new Map() }
}

test('returning restores the expanded stream and its row offset as content grows', (t) => {
  const b = browser(t), key = 'chain/board/following'
  const first = rememberStream(b.node, { positions: b.store, key, limit: 20 })
  assert.equal(b.win.scrollY, 0)
  first.update({ positions: b.store, key, limit: 40 })
  b.win.scrollY = 3_125
  leavePage() // router saves before it scrolls to the next page
  b.win.scrollY = 0
  first.destroy()
  assert.deepEqual(streamPosition(key, b.store), { limit: 40, y: 3_125, row: '10', offset: -125 })

  // Initially the remounted cards are short loading placeholders.
  b.node.spacing = 30; b.win.height = 1_200
  const back = rememberStream(b.node, { positions: b.store, key, limit: 40 })
  b.flush()
  assert.equal(b.win.scrollY, 425)
  // Five rows arriving above it and delayed bodies must not change which row is being read.
  b.node.preceding = 5; b.node.spacing = 300; b.win.height = 20_000
  b.resize()
  assert.equal(b.win.scrollY, 4_625)
  assert.equal(b.node.querySelectorAll()[10].getBoundingClientRect().top, -125)
  back.destroy()
  assert.equal(b.observers.size, 0)
  assert.ok([...b.listeners.values()].every((set) => set.size === 0))
})

test('each pressed refresh scrolls to the top even with the same conversation; other updates keep position', (t) => {
  const b = browser(t), key = 'chain/board/pressed'
  const base = { positions: b.store, key, limit: 20 }
  const stream = rememberStream(b.node, base)
  b.win.scrollY = 3_000
  const refreshed = { ...base, arrived: {} }
  stream.update(refreshed)
  assert.equal(b.win.scrollY, 0, 'a refresh with new replies or no new rows still goes to the top')
  b.win.scrollY = 2_000
  stream.update(refreshed)
  assert.equal(b.win.scrollY, 2_000, 'rendering the same result again does not repeat the scroll')
  stream.update(base)
  assert.equal(b.win.scrollY, 2_000, 'local reloads stay in place')
  stream.update({ ...base, limit: 40 })
  assert.equal(b.win.scrollY, 2_000, 'show more stays in place')
  stream.update({ ...base, arrived: {} })
  assert.equal(b.win.scrollY, 0, 'a second press works with the same first conversation')
  b.win.scrollY = 2_500
  stream.destroy()

  const back = rememberStream(b.node, base)
  b.flush()
  assert.equal(b.win.scrollY, 2_500)
  back.update({ ...base, arrived: {} })
  assert.equal(b.win.scrollY, 0)
  b.node.spacing = 400
  b.resize()
  assert.equal(b.win.scrollY, 0, 'refresh stops the old bookmark restoration')
  back.destroy()
  assert.equal(b.observers.size, 0)
})

test('cards added above the one being read leave it where it is, and a browser that anchored by itself is left alone', (t) => {
  const b = browser(t)
  b.win.scrollY = 1_000
  // The card under the header is row 3 (its bottom is 200 pixels down); two posts arrive above it.
  const hold = holdInView(b.node, 'data-feed-row')
  b.node.preceding = 2
  hold()
  assert.equal(b.win.scrollY, 1_600)
  assert.equal(b.node.querySelectorAll()[3].getBoundingClientRect().top, -100, 'row 3 is where it was')
  // Nothing moved this time (the browser anchored the scroll itself): no correction.
  const again = holdInView(b.node, 'data-feed-row')
  again()
  assert.equal(b.win.scrollY, 1_600)
})

test('Home resumes its visit; pressing it again scrolls without refreshing', async (t) => {
  const b = browser(t)
  const { router } = await load('features/navigation/router.svelte.ts?home-press')
  const visit = router.visit
  b.win.scrollY = 3_000
  router.home()
  assert.equal(b.win.scrollY, 0)
  assert.equal(router.visit, visit, 'no duplicate history entry on Home')
  const first = router.homeTop
  router.home()
  assert.notEqual(router.homeTop, first)

  router.go('/p/1/7'); b.input('popstate')
  assert.equal(router.homeTop, null)
  router.home(); b.input('hashchange')
  assert.equal(router.route.kind, 'home')
  assert.notEqual(router.visit, visit, 'the sidebar resumes Home in its own history entry')
  assert.deepEqual(router.homeTop, { shown: false, folded: false }, 'the returning feed consumes the Home reset')
  history.back()
  assert.equal(router.route.kind, 'thread')
  history.forward()
  assert.equal(router.route.kind, 'home')
  assert.equal(router.homeTop, null, 'history navigation restores instead')
})

test('Home cancels a stream restore, scrolls even without new rows, and is consumed before tab remounts', (t) => {
  const b = browser(t), key = 'chain/board/home-press'
  const first = rememberStream(b.node, { positions: b.store, key, limit: 40, head: 'same' })
  b.win.scrollY = 3_000
  first.destroy()
  const topRequest = { shown: false }
  const home = rememberStream(b.node, { positions: b.store, key, limit: 40, head: 'same', topRequest })
  b.flush(); b.resize()
  assert.equal(b.win.scrollY, 0, 'a fresh Home visit cancels its pending bookmark restoration')
  assert.equal(topRequest.shown, true)
  b.win.scrollY = 2_000
  home.update({ positions: b.store, key, limit: 40, head: 'same', topRequest })
  assert.equal(b.win.scrollY, 2_000, 'ordinary updates do not repeat the press')
  home.update({ positions: b.store, key, limit: 40, head: 'same', topRequest: { shown: false } })
  assert.equal(b.win.scrollY, 0, 'another Home press works without new rows')
  b.win.scrollY = 1_500
  home.destroy()
  const tab = rememberStream(b.node, { positions: b.store, key, limit: 40, head: 'same', topRequest })
  b.flush()
  assert.equal(b.win.scrollY, 1_500, 'returning to a tab restores; the Home press was consumed')
  tab.destroy()
  assert.equal(b.observers.size, 0)
})

test('user scrolling stops restoration; another stream starts at the top', (t) => {
  const b = browser(t), key = 'chain/board/everyone'
  const first = rememberStream(b.node, { positions: b.store, key, limit: 40 })
  b.win.scrollY = 2_500
  first.destroy()
  b.win.scrollY = 0
  const back = rememberStream(b.node, { positions: b.store, key, limit: 40 })
  b.flush()
  assert.equal(b.win.scrollY, 2_500)
  b.input('wheel')
  b.win.scrollY = 2_000
  b.node.spacing = 400
  b.resize()
  assert.equal(b.win.scrollY, 2_000, 'late bodies cannot fight the reader')
  back.destroy()
  const other = rememberStream(b.node, { positions: b.store, key: 'another-chain/board/everyone', limit: 20 })
  assert.equal(b.win.scrollY, 0)
  assert.equal(streamPosition('another-chain/board/everyone', b.store), undefined)
  other.destroy()
})

test('the ten-second budget starts with the first restore, which a hidden tab has not run yet', (t) => {
  const b = browser(t), key = 'chain/board/hidden'
  const first = rememberStream(b.node, { positions: b.store, key, limit: 20 })
  b.win.scrollY = 900
  first.destroy()
  b.win.scrollY = 0
  const back = rememberStream(b.node, { positions: b.store, key, limit: 20 })
  assert.equal(b.win.timeouts.length, 0, 'no frame has run, so no budget is ticking')
  b.flush()
  assert.equal(b.win.scrollY, 900)
  assert.deepEqual(b.win.timeouts.filter(Boolean).map((x) => x.ms), [10_000])
  back.destroy()
  assert.equal(b.win.timeouts.filter(Boolean).length, 0, 'cleared with the rest')
})

test('leaving again before content settles preserves the original bookmark', (t) => {
  const b = browser(t), key = 'chain/board/profile'
  const first = rememberStream(b.node, { positions: b.store, key, limit: 60 })
  b.win.scrollY = 5_025
  first.destroy()
  const original = streamPosition(key, b.store)
  b.win.scrollY = 0; b.node.spacing = 10; b.win.height = 600
  const back = rememberStream(b.node, { positions: b.store, key, limit: 60 })
  b.flush()
  assert.equal(b.win.scrollY, 0)
  leavePage()
  back.destroy()
  assert.deepEqual(streamPosition(key, b.store), original)
})

test('routing saves before scrolling, while equivalent routes and the reply box keep their position', async (t) => {
  const b = browser(t), key = 'navigation/feed'
  // A fresh router instance installs its browser listener against this fake window.
  const { router } = await load('features/navigation/router.svelte.ts?scroll-navigation')
  assert.equal(history.scrollRestoration, 'manual')
  const stream = rememberStream(b.node, { positions: b.store, key, limit: 40 })
  b.win.scrollY = 1_825
  location.hash = '#/'
  b.input('hashchange')
  assert.equal(b.win.scrollY, 1_825, 'home and #/ are the same page')
  assert.equal(streamPosition(key, b.store), undefined)
  router.go('/p/1/7')
  assert.equal(streamPosition(key, b.store).y, 1_825)
  assert.equal(b.win.scrollY, 0, 'a new thread opens at the top')
  stream.destroy()
  b.win.scrollY = 500
  router.go('/p/1/7?reply')
  assert.equal(b.win.scrollY, 500, 'opening a reply box does not navigate away')
})

test('opening a reply keeps its parent visible when both fit, and the reply visible when the parent grows', (t) => {
  const b = browser(t), parent = b.target(500), reply = b.target(700)
  b.win.innerHeight = 900
  let parentHeight = 200
  parent.getBoundingClientRect = () => ({ top: parent.top - b.win.scrollY, height: parentHeight })
  reply.getBoundingClientRect = () => ({ top: reply.top - b.win.scrollY, height: 180 })
  reply.previousElementSibling = parent
  const action = revealWhen(reply, { key: 9n, anchor: 'above' })
  b.flush()
  assert.equal(parent.getBoundingClientRect().top, 52, 'both cards fit below the header')
  assert.equal(reply.getBoundingClientRect().top, 252)
  assert.equal(reply.focused, 1, 'the addressed reply keeps keyboard focus')

  parentHeight = 1_000; reply.top = parent.top + parentHeight
  b.resize()
  assert.equal(reply.getBoundingClientRect().top, 52, 'late content cannot bury the addressed reply')
  b.input('wheel')
  b.win.scrollY = 700
  action.update({ key: 9n, anchor: 'above' })
  b.resize()
  assert.equal(b.win.scrollY, 700, 'refresh leaves the reader where they scrolled')
  action.destroy()
})

test('a keyboard opening under a revealed reply moves the reply above it', (t) => {
  const b = browser(t), parent = b.target(500), reply = b.target(700)
  const keyboard = new Map()
  b.win.innerHeight = 900
  b.win.visualViewport = {
    height: 900, offsetTop: 0,
    addEventListener(name, fn) { keyboard.set(fn, name) },
    removeEventListener(_, fn) { keyboard.delete(fn) },
  }
  parent.getBoundingClientRect = () => ({ top: parent.top - b.win.scrollY, height: 200 })
  reply.getBoundingClientRect = () => ({ top: reply.top - b.win.scrollY, height: 180 })
  reply.previousElementSibling = parent
  const action = revealWhen(reply, { key: 9n, anchor: 'above' })
  b.flush()
  assert.equal(parent.getBoundingClientRect().top, 52, 'without a keyboard both cards fit below the header')
  // The keyboard takes the lower half; the window keeps its height.
  b.win.visualViewport.height = 400
  for (const [fn, name] of keyboard) if (name === 'resize') fn()
  b.flush()
  assert.equal(reply.getBoundingClientRect().top, 52, 'the reply sits just below the header, above the keyboard')
  action.destroy()
  assert.equal(keyboard.size, 0, 'the follow stops listening to the keyboard')
})

test('reply focuses the editor again on another press, follows late content, and stops on input', (t) => {
  const b = browser(t), box = b.target(4_000), editor = b.target(4_020)
  box.querySelector = (selector) => { assert.equal(selector, 'textarea'); return editor }
  const action = revealWhen(box, { key: 1, focus: 'textarea' })
  b.flush()
  assert.equal(editor.focused, 1)
  assert.equal(editor.getBoundingClientRect().top, 52, 'below the sticky header')
  editor.top += 600
  b.resize()
  assert.equal(editor.getBoundingClientRect().top, 52, 'late content cannot push the editor away')
  assert.equal(editor.focused, 1, 'layout changes do not re-focus or move the caret')
  b.input('keydown')
  b.win.scrollY = 300
  editor.top += 500
  action.update({ key: 1, focus: 'textarea' })
  b.resize()
  assert.equal(b.win.scrollY, 300, 'refresh and late images leave the reader alone')
  action.update({ key: 2, focus: 'textarea' })
  b.flush()
  assert.equal(editor.focused, 2, 'reply works even with the box already open')
  assert.equal(editor.getBoundingClientRect().top, 52)
  action.destroy()
  assert.equal(b.observers.size, 0)
})

test('an explicit quote wins over both an outstanding restore and a feed that mounts later', (t) => {
  const b = browser(t), key = 'quote/feed'
  const first = rememberStream(b.node, { positions: b.store, key, limit: 60 })
  b.win.scrollY = 5_000
  first.destroy()
  const back = rememberStream(b.node, { positions: b.store, key, limit: 60 })
  // The quote press arrives before the restore's first animation frame.
  back.update({ positions: b.store, key, limit: 60, restore: false })
  const box = b.target(100), action = revealWhen(box, { key: 1 })
  b.flush()
  assert.equal(b.win.scrollY, 48)
  back.destroy()
  // The feed might not finish loading until after the reveal has stopped.
  b.input('wheel')
  const late = rememberStream(b.node, { positions: b.store, key, limit: 60, restore: false })
  b.resize()
  assert.equal(b.win.scrollY, 48)
  assert.equal(streamPosition(key, b.store).limit, 60, 'the expanded rows are still remembered')
  action.destroy(); late.destroy()
})

test('an explicitly requested card is revealed once, without a move on refresh', (t) => {
  const b = browser(t), card = b.target(9_000)
  const action = revealWhen(card, { key: null })
  b.flush()
  assert.equal(b.win.scrollY, 0, 'ordinary cards do not move the page')
  action.update({ key: 101n })
  b.flush()
  assert.equal(card.getBoundingClientRect().top, 52)
  assert.equal(card.focused, 1)
  b.input('wheel')
  b.win.scrollY = 1_000
  action.update({ key: 101n })
  b.resize()
  assert.equal(b.win.scrollY, 1_000, 'retaining the card during refresh does not reveal it twice')
  action.destroy()
})

test('a cancelled reveal never focuses a page that was left, and a new ancestor supersedes the previous one', (t) => {
  const b = browser(t), parent = b.target(1_000), grandparent = b.target(300)
  const old = revealWhen(parent, { key: 12n })
  old.destroy()
  b.flush()
  assert.equal(parent.focused, 0)
  const next = revealWhen(grandparent, { key: 7n })
  b.flush()
  assert.equal(grandparent.getBoundingClientRect().top, 52)
  b.win.timeouts.find(Boolean).fn()
  b.win.scrollY = 900
  grandparent.top += 600
  b.resize()
  assert.equal(b.win.scrollY, 900, 'the time budget also ends following')
  next.destroy()
  assert.equal(b.observers.size, 0)
  assert.ok([...b.listeners.values()].every((set) => set.size === 0))
})

test('quoting is an event: every press reaches the listening page, a press before it mounted arrives once, the quote itself is added once', async () => {
  const { draft } = await load('features/publishing/draft.svelte.ts')
  draft.clear()
  const q = { chainId: 1, id: 9n, commit: `0x${'ab'.repeat(32)}` }
  draft.add(q) // pressed on a thread page, before home is mounted
  const presses = []
  const stop = draft.onPress((p) => presses.push(p))
  assert.deepEqual(presses, [], 'delivered after the subscription settles, not inside it')
  await new Promise((r) => queueMicrotask(r))
  assert.equal(presses.length, 1, 'the press made before anyone listened arrives once')
  draft.add(q) // pressed again with home on screen
  assert.equal(presses.length, 2, 'a repeat press focuses the composer again')
  assert.equal(draft.quotes.length, 1, 'without duplicating the quote')
  stop()
  draft.add(q)
  assert.equal(presses.length, 2, 'nothing reaches a page that left')
  const later = []
  const stopLater = draft.onPress((p) => later.push(p))
  await new Promise((r) => queueMicrotask(r))
  assert.equal(later.length, 1, 'the press made meanwhile waits for the next page, once')
  stopLater()
  await new Promise((r) => queueMicrotask(r))
  assert.equal(later.length, 1)
  draft.clear()
})

test('a home post that finishes after a newer draft, or a quote added since, clears nothing', async () => {
  const { draft } = await load('features/publishing/draft.svelte.ts')
  const stop = draft.onPress(() => {})
  draft.clear()
  draft.edit({ text: 'first', mentions: {}, attachments: [] })
  const sent = draft.version
  assert.equal(draft.holds(sent), true, 'nothing changed since the send')
  draft.edit({ text: 'second', mentions: {}, attachments: [] })
  assert.equal(draft.holds(sent), false, 'a newer text is not the sent draft')
  const again = draft.version
  draft.add({ chainId: 1, id: 5n, commit: `0x${'ab'.repeat(32)}` })
  assert.equal(draft.holds(again), false, 'a quote added since counts too')
  const withQuote = draft.version
  draft.add({ chainId: 1, id: 5n, commit: `0x${'ab'.repeat(32)}` })
  assert.equal(draft.version, withQuote, 'the same quote again changes nothing')
  draft.remove({ chainId: 1, id: 6n })
  assert.equal(draft.version, withQuote, 'removing a quote that is not there changes nothing')
  draft.begin()
  draft.clear()
  assert.equal(draft.sending, false, 'the post landed: the composer is unlocked')
  stop()
})

test('Back and Forward restore their visit; a fresh link and a browser reload start new ones', async (t) => {
  const b = browser(t)
  const { router } = await load('features/navigation/router.svelte.ts?back-visits')
  assert.equal(history.state.other, 'preserved')
  const go = (hash) => { router.go(hash); b.input('hashchange') }
  const profile = '/u/1/0x1111111111111111111111111111111111111111'
  go(profile)
  const profileVisit = router.visit
  profileVisit.state('profile/board', () => ({ tab: 'posts' }), value => value).tab = 'replies'
  go('/p/1/7')
  const threadVisit = router.visit
  threadVisit.state('thread/board', () => ({ ancestors: [6n], branches: new Map([[8n, { limit: 40, open: { 9: true } }]]) }), value => value)
  go('/p/1/7?reply')
  assert.equal(router.visit, threadVisit, 'reply is an action in the same visit')
  go('/p/1/8')
  history.back()
  assert.equal(router.visit, threadVisit)
  assert.deepEqual(router.visit.state('thread/board', () => null, value => value).ancestors, [6n])
  assert.equal(router.visit.state('thread/board', () => null, value => value).branches.get(8n).limit, 40)
  history.back() // remove ?reply, same mounted page
  assert.equal(router.visit, threadVisit)
  history.back()
  assert.equal(router.visit, profileVisit)
  assert.equal(router.visit.state('profile/board', () => null, value => value).tab, 'replies')
  history.forward()
  assert.equal(router.visit, threadVisit)
  history.back()
  go('/p/1/7')
  assert.notEqual(router.visit, threadVisit, 'a new link to that URL is a fresh thread')
  assert.equal(router.visit.state('thread/board', () => null, value => value), null)
  history.back()
  assert.equal(router.visit, profileVisit)

  const reloaded = await load('features/navigation/router.svelte.ts?back-reloaded')
  assert.equal(reloaded.router.visit.state('profile/board', () => null, value => value), null, 'history markers contain no saved UI state')
})

test('old visits are bounded and revisiting an evicted entry starts with default UI state', () => {
  const visits = new Visits(2)
  visits.current.state('thread', () => ({ open: true }), value => value)
  const oldest = visits.entry
  visits.move(null, false)
  const middle = visits.current, middleEntry = visits.entry
  visits.move(null, false)
  assert.equal(visits.move(middleEntry, false), middle)
  assert.equal(visits.move(oldest, false).state('thread', () => null, value => value), null)
})

test('a thread bookmark follows a nested reply when the restored branch arrives later', (t) => {
  const b = browser(t)
  let saved
  const first = rememberPosition(b.node, { attribute: 'data-thread-card', save: (p) => { saved = p } })
  b.win.scrollY = 3_125
  leavePage(); first.destroy()
  assert.equal(saved.row, '10')
  const query = b.node.querySelectorAll
  b.node.querySelectorAll = () => query().slice(0, 2) // root arrived, branch still loading
  b.win.height = 800; b.win.scrollY = 0
  const back = rememberPosition(b.node, { saved, attribute: 'data-thread-card', save: (p) => { saved = p } })
  b.flush()
  assert.equal(b.win.scrollY, 200, 'initial position is clamped while replies load')
  b.node.querySelectorAll = query; b.win.height = 20_000; b.node.preceding = 2
  b.resize()
  assert.equal(query()[10].getBoundingClientRect().top, -125)
  b.input('wheel'); back.destroy()
})

test('profile visits keep separate tab bookmarks and shown lengths', (t) => {
  const b = browser(t), key = 'chain/board/profile-replies'
  const original = new Map(), fresh = new Map()
  const first = rememberStream(b.node, { key, limit: 40, positions: original })
  b.win.scrollY = 2_000
  leavePage(); first.destroy()
  const next = rememberStream(b.node, { key, limit: 20, positions: fresh })
  assert.equal(b.win.scrollY, 0)
  next.destroy()
  assert.equal(streamPosition(key, original).limit, 40)
  assert.equal(streamPosition(key, fresh).limit, 20)
  const back = rememberStream(b.node, { key, limit: 40, positions: original })
  b.flush()
  assert.equal(b.win.scrollY, 2_000)
  back.destroy()
})

test('a stream torn down without notice keeps the last position it saw', (t) => {
  const b = browser(t), key = 'chain/board/switched-tab'
  const first = rememberStream(b.node, { positions: b.store, key, limit: 20 })
  b.win.scrollY = 700
  b.input('scroll')
  b.node.isConnected = false // the tab switch remounted the feed before its action was destroyed
  first.destroy()
  assert.deepEqual(streamPosition(key, b.store), { limit: 20, y: 700, row: null, offset: 0 })
  assert.ok([...b.listeners.values()].every((set) => set.size === 0), 'the scroll listener went with it')
  b.node.isConnected = true
  const back = rememberStream(b.node, { positions: b.store, key, limit: 20 })
  b.flush()
  assert.equal(b.win.scrollY, 700)
  back.destroy()
})

test('the reply box belongs to the page: Back, Forward or a fresh link return to it with its draft, another page has its own, and a completion may clear only what it sent', async (t) => {
  const b = browser(t)
  // The box lives on the router's pages, so the test drives the same router instance the box reads.
  const { replying } = await load('features/publishing/replying.svelte.ts')
  const { emptyDraft } = await load('features/publishing/draft-box.svelte.ts')
  const { router } = await load('features/navigation/router.svelte.ts')
  const go = (hash) => { router.go(hash); b.input('hashchange') }
  const draft = (text) => ({ ...emptyDraft(), text })
  go('/p/1/7')
  replying.open(1, 9n)
  const box = replying.box()
  const sent = box.reply.edit(draft('half a thou'))
  box.reply.begin() // the reply is on its way: a box mounted again for it stays locked
  assert.equal(box.is(1, 9n), true)
  assert.equal(box.press, 1)
  replying.open(1, 9n)
  assert.equal(box.press, 2, 'a repeat press focuses again')
  assert.equal(box.reply.draft.text, 'half a thou', 'and keeps the draft')
  go('/p/1/8')
  assert.equal(replying.box().is(1, 9n), false, 'another page has no box')
  history.back()
  assert.equal(replying.box(), box, 'Back returns to the box')
  assert.equal(box.reply.draft.text, 'half a thou', 'and its draft')
  go('#/')
  assert.notEqual(replying.box(), box)
  go('/p/1/7')
  assert.equal(replying.box().reply.draft.text, 'half a thou', 'so does a fresh link to the page')
  assert.equal(box.shown, 0, 'no reveal has run yet')
  box.shown = box.press
  replying.open(1, 9n)
  assert.equal(box.press > box.shown, true, 'a third press asks for a reveal again')

  // The reader moves on while the reply is sending and writes another one there.
  go('/p/1/8')
  const other = replying.box()
  other.open(1, 11n)
  const theirs = other.reply.edit(draft('something else'))
  const sentDraft = box.reply
  assert.equal(sentDraft.holds(sent), true, 'the box the reply was sent from still holds that submission')
  box.close()
  assert.equal(box.is(1, 9n), false)
  assert.equal(sentDraft.draft.text, '', 'and dropped the sent text')
  assert.equal(sentDraft.sending, false, 'and unlocked')
  assert.equal(other.is(1, 9n), false, "the other page's box is not it")
  assert.equal(other.reply.draft.text, 'something else')
  assert.equal(other.reply.holds(theirs), true)
  other.close()
  assert.equal(other.is(1, 11n), false)

  // A draft written under the same post after sending is not the sent one either.
  other.open(1, 11n)
  const first = other.reply.edit(draft('one'))
  other.reply.edit(draft('two'))
  assert.equal(other.reply.holds(first), false, 'a newer draft under the same post is kept')
  assert.equal(other.reply.draft.text, 'two')
  other.reply.begin()
  other.open(1, 10n)
  assert.equal(other.reply.draft.text, '', 'a box under another card starts empty')
  assert.equal(other.reply.sending, false, 'and unlocked: what is on its way belongs to the other card')

  // Interleaved chains can have the same message id; they still own different drafts.
  other.open(2, 10n)
  assert.equal(other.is(1, 10n), false)
  assert.equal(other.is(2, 10n), true)
})

test('leaving a page saves every mounted stream before navigation moves the viewport', (t) => {
  const b = browser(t), saved = []
  const first = rememberPosition(b.node, { attribute: 'data-feed-row', restore: false, save: (position) => saved.push(position) })
  const second = rememberPosition(b.node, { attribute: 'data-feed-row', restore: false, save: (position) => saved.push(position) })
  b.win.scrollY = 3125
  leavePage()
  b.win.scrollY = 0
  first.destroy(); second.destroy()
  assert.equal(saved.length, 2)
  assert.ok(saved.every((position) => position.y === 3125))
})

test('home keeps one bookmark store per visit, so a stream scrolled after a chain switch is restored by Back', async (t) => {
  const b = browser(t)
  const { router } = await load('features/navigation/router.svelte.ts?home-chain-switch')
  const { placeOf } = await load('features/navigation/visit-position.ts')
  const go = (hash) => { router.go(hash); b.input('hashchange') }
  go('#/')
  const homeVisit = router.visit
  // Home's feed mounts under chain A and takes the visit's one store; the stream keys name their chain and contract.
  const store = placeOf(homeVisit).streams
  const chainA = { id: 1, contract: '0x' + '11'.repeat(20) }, chainB = { id: 2, contract: '0x' + '22'.repeat(20) }
  const filter = { kind: 'timeline' }
  assert.notEqual(feedKey(chainA, filter), feedKey(chainB, filter))
  store.set(feedKey(chainA, filter), { y: 300, row: '3', offset: 0, limit: 20 })
  // The chain selector switches to B with Home still mounted; B's stream is scrolled and bookmarks itself in the same store.
  store.set(feedKey(chainB, filter), { y: 900, row: '5', offset: 0, limit: 40 })
  go('#/m/2/5')
  assert.notEqual(router.visit, homeVisit)
  history.back()
  assert.equal(router.visit, homeVisit, 'Back returns to the home visit')
  // The feed remounts under chain B and asks the visit for its store: the same one, with B\'s bookmark in it.
  const again = placeOf(router.visit).streams
  assert.equal(again, store)
  assert.deepEqual(streamPosition(feedKey(chainB, filter), again), { y: 900, row: '5', offset: 0, limit: 40 })
  assert.equal(streamPosition(feedKey(chainA, filter), again).limit, 20, 'and A\'s, for when the selector goes back')
  // A fresh navigation home is a new visit with an empty store: the streams start at the top.
  go('#/m/2/5')
  go('#/')
  assert.notEqual(router.visit, homeVisit)
  assert.equal(placeOf(router.visit).streams.size, 0)
})

test('the selected navigation rail link scrolls to the top; new pages and Back keep their rules', async (t) => {
  const b = browser(t), key = 'rail/feed'
  const { router } = await load('features/navigation/router.svelte.ts?rail')
  const go = (hash) => { router.go(hash); b.input('hashchange') }
  // Home is both / and #/.
  b.win.scrollY = 800
  router.nav('#/')
  assert.equal(b.win.scrollY, 800, 'the hash change has not arrived yet')
  b.input('hashchange')
  assert.equal(b.win.scrollY, 0, 'the same page under another address goes to its top')
  go('/p/1/7')
  b.win.scrollY = 1_500
  router.nav('/p/1/7')
  assert.equal(b.win.scrollY, 0, 'the page already shown goes to its top')
  b.win.scrollY = 500
  go('/p/1/7?reply')
  assert.equal(b.win.scrollY, 500, 'an ordinary same-page link still leaves the place alone')

  const stream = rememberStream(b.node, { positions: b.store, key, limit: 40 })
  b.win.scrollY = 2_000
  router.nav('#/following'); b.input('hashchange')
  assert.equal(streamPosition(key, b.store).y, 2_000, 'the page left is saved before the scroll')
  assert.equal(b.win.scrollY, 0)
  stream.destroy()
  history.back()
  assert.equal(router.route.kind, 'thread')
  const back = rememberStream(b.node, { positions: b.store, key, limit: 40 })
  b.flush()
  assert.equal(b.win.scrollY, 2_000, 'Back returns to the place being read')
  back.destroy()
})

test('a long page keeps its place per visit: a fresh visit starts at the top and Back restores', async (t) => {
  const b = browser(t)
  // The router moves between visits; here the test does, on the router the pages read.
  const { router } = await load('features/navigation/router.svelte.ts')
  const { rememberPage, returning, visitPlace } = await load('features/navigation/visit-position.ts')
  const visits = new Visits()
  router.visit = visits.current
  const first = visits.entry
  const page = rememberPage(b.node, 'data-person')
  assert.equal(returning(), false)
  b.win.scrollY = 3_125
  leavePage(); page.destroy()
  assert.equal(visitPlace().position.row, '10')

  router.visit = visits.move(null, false)
  assert.equal(returning(), false, 'a new visit has nothing to return to')
  b.win.scrollY = 900
  const fresh = rememberPage(b.node, 'data-person')
  assert.equal(b.win.scrollY, 0)
  leavePage(); fresh.destroy()

  router.visit = visits.move(first, false)
  assert.equal(returning(), true)
  b.win.scrollY = 0
  const again = rememberPage(b.node, 'data-person')
  b.flush()
  assert.equal(b.win.scrollY, 3_125)
  b.input('wheel'); again.destroy()

  // Fixed text has no rows to follow: the offset alone is restored.
  router.visit = visits.move(null, false)
  const text = visits.entry
  const about = rememberPage(b.node)
  b.win.scrollY = 1_234
  leavePage(); about.destroy()
  router.visit = visits.move(text, false)
  b.win.scrollY = 0
  const aboutAgain = rememberPage(b.node)
  b.flush()
  assert.equal(b.win.scrollY, 1_234)
  b.input('wheel'); aboutAgain.destroy()
  assert.equal(visitPlace().position.row, null)
})

test('sidebar returns restore the latest retained visit without another state cache', () => {
  const visits = new Visits(3, 'home')
  const home = visits.current
  const state = home.state('selection', () => ({ tab: 'keyring', side: 'holders' }), value => value)
  visits.move(null, false, 'profile')
  assert.notEqual(visits.move(null, false, 'home', true), home)
  assert.equal(visits.current.state('selection', () => null, value => value), state)
  const nextHome = visits.move(null, false, 'home')
  assert.notEqual(nextHome, home, 'ordinary links are still fresh visits')
  const latestState = nextHome.state('snapshot', () => ({ rows: [3] }), value => value)
  visits.move(null, false, 'profile', true)
  assert.equal(visits.move(null, false, 'home', true).state('snapshot', () => null, value => value), latestState, 'most recent visit wins')
  visits.move(null, false, 'other')
  visits.move(null, false, 'another')
  visits.move(null, false, 'last')
  assert.notEqual(visits.move(null, false, 'home', true), nextHome, 'evicted visits start fresh')
  assert.notEqual(new Visits(3, 'home').current, home, 'a reload retains nothing')
})

test('sidebar returns keep shown rows but start at the top without changing Back entries', async (t) => {
  const b = browser(t), key = 'chain/board/following'
  const { placeOf } = await load('features/navigation/visit-position.ts')
  const visits = new Visits(10, 'home'), original = visits.current, oldEntry = visits.entry
  const oldPlace = placeOf(original)
  oldPlace.position = { y: 3125, row: '10', offset: -125 }
  const first = rememberStream(b.node, { positions: oldPlace.streams, key, limit: 40 })
  b.win.scrollY = 3125
  leavePage(); first.destroy()
  visits.move(null, false, 'thread')
  const resumed = visits.move(null, false, 'home', true), newEntry = visits.entry
  const nextPlace = placeOf(resumed)
  b.win.scrollY = 0
  const next = rememberStream(b.node, { positions: nextPlace.streams, key, limit: 40 })
  b.flush()
  assert.equal(b.win.scrollY, 0, 'sidebar starts at the top')
  assert.equal(nextPlace.position, undefined, 'long pages also start without a saved position')
  assert.equal(streamPosition(key, nextPlace.streams).limit, 40, 'loaded rows still resume without a refresh')
  b.node.spacing = 320; b.resize()
  assert.equal(b.win.scrollY, 0, 'delayed content cannot restore the old row')
  b.node.spacing = 300
  b.input('wheel')
  b.win.scrollY = 6225
  next.update({ positions: nextPlace.streams, key, limit: 60 })
  nextPlace.position = { y: 6225, row: '20', offset: -225 }
  leavePage(); next.destroy()
  const backPlace = placeOf(visits.move(oldEntry, false, 'home'))
  assert.equal(backPlace.position.y, 3125, 'the old page bookmark stays put')
  b.win.scrollY = 0
  const back = rememberStream(b.node, { positions: backPlace.streams, key, limit: 40 })
  b.flush()
  assert.equal(b.win.scrollY, 3125, 'Back restores the earlier stream position')
  assert.equal(streamPosition(key, backPlace.streams).limit, 40)
  b.input('wheel'); back.destroy()
  assert.equal(placeOf(visits.move(newEntry, false, 'home')).position.y, 6225)
  assert.equal(streamPosition(key, nextPlace.streams).limit, 60)
})

test('resumed visits copy tab choices but share retained data', () => {
  const visits = new Visits(10, 'home'), home = visits.current, entry = visits.entry
  const selection = home.state('selection', () => ({ tab: 'following' }), value => ({ ...value }))
  const snapshot = home.state('snapshot', () => ({ rows: [1, 2] }), value => value)
  visits.move(null, false, 'thread')
  const resumed = visits.move(null, false, 'home', true)
  const next = resumed.state('selection', () => null, value => value)
  assert.deepEqual(next, selection)
  next.tab = 'everyone'
  assert.equal(visits.move(entry, false, 'home').state('selection', () => null, value => value).tab, 'following')
  assert.equal(resumed.state('snapshot', () => null, value => value), snapshot)
})

test('the holders link starts its own visit and Back restores the previous keyring', async t => {
  const b = browser(t)
  const { router, href } = await load('features/navigation/router.svelte.ts?key-holders')
  const account = '0x' + '22'.repeat(20)
  const go = url => { router.go(url); b.input('hashchange') }
  go(href.keyring(84532, account))
  const holdingsVisit = router.visit
  holdingsVisit.state('selection', () => ({ side: 'holding', page: 2 }), value => value)
  go(href.keyHolders(84532, account))
  assert.equal(router.route.holders, true)
  assert.notEqual(router.visit, holdingsVisit)
  const holdersVisit = router.visit
  history.back()
  assert.equal(router.visit, holdingsVisit)
  assert.equal(router.visit.state('selection', () => null, value => value).page, 2)
  history.forward()
  assert.equal(router.visit, holdersVisit)
  assert.equal(router.route.holders, true)
})

test('the page arrow restores its destination in a new history entry that browser Back can undo', async t => {
  const { placeOf } = await load('features/navigation/visit-position.ts')
  const b = browser(t)
  const { router } = await load('features/navigation/router.svelte.ts?page-arrow-history')
  const go = url => { router.go(url); b.input('hashchange') }
  go('#/following')
  const source = router.visit
  placeOf(source).position = { y: 1200, row: '4', offset: 0 }
  placeOf(source).streams.set('feed', { y: 1200, row: '4', offset: 0, limit: 40 })
  go('/p/1/7')
  const thread = router.visit
  placeOf(thread).position = { y: 500, row: '9', offset: 0 }
  router.back()
  assert.equal(router.route.kind, 'following')
  const returned = router.visit
  assert.equal(placeOf(returned).position.y, 1200)
  history.back()
  assert.equal(router.route.kind, 'thread', 'browser Back undoes the page arrow')
  assert.equal(router.visit, thread)
  assert.equal(placeOf(thread).position.y, 500)
  history.forward()
  assert.equal(router.visit, returned)
  assert.notEqual(returned, source, 'the return has independent bookmarks')
  placeOf(returned).position.y = 2400
  placeOf(returned).streams.get('feed').y = 2400
  assert.equal(placeOf(source).position.y, 1200)
  assert.equal(placeOf(source).streams.get('feed').y, 1200)
  router.back()
  assert.equal(router.route.kind, 'home', 'repeated arrows follow the original route, not the browser stack')
})

test('the page arrow skips replaced profile tabs and restores the last selected tab', async t => {
  const b = browser(t)
  const { router, href } = await load('features/navigation/router.svelte.ts?page-arrow-tabs')
  const account = '0x' + '22'.repeat(20)
  router.go(href.user(1, account))
  router.go(href.userReplies(1, account), true)
  router.go(href.userKeys(1, account), true)
  router.go(href.thread(1, 7n))
  router.back()
  assert.equal(router.route.keys, true)
  router.back()
  assert.equal(router.route.kind, 'home')
  history.back()
  assert.equal(router.route.keys, true)
  history.back()
  assert.equal(router.route.id, 7n)
})

test('the arrow on a directly opened page adds Home so browser Back returns to the page', async t => {
  browser(t)
  history.replaceState(null, '', '/p/1/8')
  const { router } = await load('features/navigation/router.svelte.ts?page-arrow-direct')
  router.back()
  assert.equal(router.route.kind, 'home')
  history.back()
  assert.equal(router.route.id, 8n)
})

test('an evicted previous page does not invent a return destination', () => {
  const visits = new Visits(1, 'home', '/')
  visits.move(null, false, 'thread', false, '/p/1/7')
  assert.equal(visits.returnEntry(), null)
})

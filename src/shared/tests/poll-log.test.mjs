// The opt-in poll log: nothing until a browser switches it on, then each
// check's trigger and result, and a warning when a found count misses the button.
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { load, mock, install, teardown, feedPost, feedHistory, author } from '../../../scripts/host-harness.mjs'

const FLAG = 'blohard.debug.polls'
const stored = new Map()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: key => stored.has(key) ? stored.get(key) : null,
  setItem: (key, value) => { stored.set(key, String(value)) },
  removeItem: key => { stored.delete(key) },
} })
// One page for the whole file: the log adds its console reader to the first window it sees.
const savedWindow = globalThis.window, savedDocument = globalThis.document
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
const { notePoll } = await load('shared/poll-log.ts')
const { pollVisible } = await load('shared/visible-poll.ts')
const { refreshCue } = await load('shared/refresh-cue.svelte.ts')
const feed = await load('features/streams/feed.ts')
beforeEach(() => { install(); stored.clear() })
after(() => { globalThis.window = savedWindow; globalThis.document = savedDocument; teardown() })
const flush = () => new Promise(resolve => setImmediate(resolve))
const switchOn = () => stored.set(FLAG, 'true')

/** The entries written since this call, without the time column. */
function mark() {
  const tag = `mark ${Math.random()}`
  notePoll(tag)
  return () => {
    const lines = globalThis.window.blohardPolls().split('\n')
    return lines.slice(lines.findIndex(line => line.includes(tag)) + 1).map(line => line.split(' ').slice(1).join(' '))
  }
}

/** Interval and delayed timers the test fires by hand. */
function timers(t) {
  const saved = { setInterval, clearInterval, setTimeout, clearTimeout }
  t.after(() => Object.assign(globalThis, saved))
  const fired = { tick: null, delayed: [] }
  globalThis.setInterval = callback => { fired.tick = callback; return 1 }
  globalThis.clearInterval = () => { fired.tick = null }
  globalThis.setTimeout = (callback, ms) => { const timer = { callback, ms }; fired.delayed.push(timer); return timer }
  globalThis.clearTimeout = timer => { fired.delayed = fired.delayed.filter(d => d !== timer) }
  return fired
}
const visibility = state => {
  globalThis.document.visibilityState = state
  globalThis.document.dispatchEvent(new Event('visibilitychange'))
  globalThis.window.dispatchEvent(new Event(state === 'visible' ? 'focus' : 'blur'))
}

test('the log records nothing and adds nothing to the page until it is switched on', async t => {
  const fired = timers(t), warn = t.mock.method(console, 'warn', () => {})
  const stop = pollVisible(async () => 1, () => {}, () => {}, 30_000, true, 'home')
  t.after(stop)
  await flush()
  const cue = refreshCue.cueCount()
  cue.set(3); cue.stop()
  assert.equal(globalThis.window.blohardPolls, undefined)
  assert.equal(warn.mock.callCount(), 0)
  switchOn()
  const since = mark()
  fired.tick(); await flush()
  assert.deepEqual(since(), ['visible check started poller=home trigger=interval'])
  // Switching it off stops recording at once; the console reader keeps what it has.
  stored.delete(FLAG)
  fired.tick(); await flush()
  assert.deepEqual(since(), ['visible check started poller=home trigger=interval'])
})

test('each check names what started it, and hidden ticks leave no entries', async t => {
  switchOn()
  const fired = timers(t), since = mark()
  const answers = [Promise.resolve(0)]
  const stop = pollVisible(() => answers.shift() ?? Promise.resolve(0), () => {}, () => {}, 30_000, true, 'home')
  t.after(stop)
  await flush()
  visibility('hidden')
  fired.tick(); fired.tick(); await flush()
  // A failed return check is tried once more, five seconds later.
  answers.push(Promise.reject(new Error('host unreachable')))
  visibility('visible'); await flush()
  assert.equal(fired.delayed.length, 1)
  fired.delayed.shift().callback(); await flush()
  // A return while a check is running owes one more check once it settles.
  let finish
  answers.push(new Promise(resolve => { finish = resolve }))
  fired.tick()
  visibility('hidden'); visibility('visible')
  finish(0); await flush()
  // Every leave and return is logged, including a focus that arrives while a
  // check runs and so starts none: the log must tell it from an event that never came.
  assert.deepEqual(since(), [
    'visible check started poller=home trigger=opened',
    'hidden page left poller=home cause=visibilitychange',
    'hidden page left poller=home cause=blur',
    'visible page returned poller=home cause=visibilitychange running=false away=true recheck=false',
    'visible check started poller=home trigger=return cause=visibilitychange',
    'visible page returned poller=home cause=focus running=true away=false recheck=false',
    'visible check failed poller=home error=host unreachable',
    'visible check started poller=home trigger=retry',
    'visible check started poller=home trigger=interval',
    'hidden page left poller=home cause=visibilitychange',
    'hidden page left poller=home cause=blur',
    'visible page returned poller=home cause=visibilitychange running=true away=true recheck=false',
    'visible return during a check, checking again after it poller=home cause=visibilitychange',
    'visible page returned poller=home cause=focus running=true away=false recheck=true',
    'visible check started poller=home trigger=recheck',
  ])
})

test('the refresh count logs its changes and a departed view’s ignored count', () => {
  switchOn()
  const since = mark()
  const first = refreshCue.cueCount()
  first.set(2)
  const second = refreshCue.cueCount(1)
  first.set(4)
  refreshCue.clear()
  second.stop()
  assert.deepEqual(since(), [
    'visible refresh count changed from=0 to=2 by=its view',
    'visible refresh count changed from=2 to=1 by=a new view',
    'visible refresh count from a departed view ignored count=4',
    'visible refresh count changed from=1 to=0 by=refresh',
  ])
})

test('a count found while its stream is mounted again is reported, and kept for the next check', async t => {
  switchOn()
  const warn = t.mock.method(console, 'warn', () => {})
  const f = { kind: 'timeline', viewer: author }
  feedHistory([feedPost(1)])
  await (await feed.loadFeed(mock.chain, f)).countsReady
  const mount = options => {
    const cue = refreshCue.cueCount()
    const leave = feed.mountFeed(mock.chain, f, cue.set, options)
    return () => { leave(); cue.stop() }
  }
  let leave = mount()
  t.after(() => leave())
  feedHistory([feedPost(1), feedPost(2)])
  const fetch = globalThis.fetch
  t.after(() => { globalThis.fetch = fetch })
  let release, started
  const hold = new Promise(resolve => { release = resolve }), waiting = new Promise(resolve => { started = resolve })
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/changes')) { started(); await hold }
    return fetch(url, init)
  }
  const since = mark()
  const checking = feed.peekFeed(mock.chain, f)
  await waiting
  leave()
  leave = mount({ resume: true })
  release()
  assert.equal(await checking, 1)
  const reported = since().filter(line => line.includes('feed'))
  assert.deepEqual(reported, ['visible feed count not shown view=everyone count=1 why=the stream was mounted again during the check'])
  assert.equal(warn.mock.callCount(), 1)
  assert.equal(feed.feedCue(mock.chain, f), 1, 'the next check still finds the post')
})

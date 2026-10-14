import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const loader = await readFile(new URL('../../../../public/embed.js', import.meta.url), 'utf8')

test('embed height checks the frame origin even when data-host includes a path', () => {
  let message
  const frame = { style: {}, contentWindow: {} }
  const script = { src: 'https://example.org/embed.js', dataset: { host: 'https://example.org/blog/', post: '1/2' }, insertAdjacentElement() {} }
  runInNewContext(loader, {
    URL, console,
    document: { currentScript: script, createElement: () => frame },
    window: { addEventListener: (_, fn) => { message = fn } },
  })
  assert.equal(frame.src, 'https://example.org/blog/embed.html?chain=1&post=2')
  const event = { origin: 'https://example.org', source: frame.contentWindow, data: { type: 'blohard:height', height: 321.5 } }
  message(event)
  assert.equal(frame.style.height, '322px')
  for (const wrong of [
    { ...event, origin: 'https://stranger.org' },
    { ...event, source: {} },
    { ...event, data: { ...event.data, height: Infinity } },
    { ...event, data: { ...event.data, height: -1 } },
  ]) {
    frame.style.height = '100px'
    message(wrong)
    assert.equal(frame.style.height, '100px')
  }
})

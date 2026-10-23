// Hostile input through both the bounded segment reader and Svelte's actual
// server renderer. This uses the installed compiler, no DOM library or browser.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, renderComponent, teardown } from '../../../../scripts/harness.mjs'
import { seeded } from '../../../../scripts/seeded.mjs'
const { messageText } = await load('features/messages/message-text.ts')
after(teardown)
const hex = (n, width) => `0x${n.toString(16).padStart(width, '0')}`
const parse = text => messageText(text, { quotes: true })
const render = text => renderComponent('features/messages/MessageBody.svelte', { body: { kind: 'text', text }, chainId: 1, id: 2n, author: hex(1, 40) })

function auditSegments(segments) {
  assert.ok(segments.length <= 385, `too many elements: ${segments.length}`)
  for (const s of segments) {
    assert.ok(['text', 'link', 'mention', 'post', 'quote', 'record'].includes(s.kind))
    assert.ok(s.style === undefined || s.style === 'bold' || s.style === 'italic' || s.style === 'bold-italic')
    assert.equal('html' in s, false)
    if (s.kind === 'link') {
      const u = new URL(s.href)
      assert.ok(['http:', 'https:'].includes(u.protocol))
      assert.equal(u.username + u.password, '')
    }
  }
}

function auditHtml(html) {
  for (let i = html.indexOf('<'); i !== -1; i = html.indexOf('<', i + 1)) {
    if (html.startsWith('<!--', i)) { i = html.indexOf('-->', i) + 2; continue }
    const m = /^<(\/?)(a|span|div)((?:\s+[a-z][a-z0-9-]*(?:="[^"]*")?)*)>/.exec(html.slice(i))
    assert.ok(m, html.slice(i, i + 100))
    for (const a of m[3].matchAll(/([a-z][a-z0-9-]*)(?:="([^"]*)")?/g)) {
      assert.match(a[1], /^(?:class|href|target|rel|data-[a-z]+)$/)
      if (a[1] === 'href') assert.match(a[2], /^(?:https?:\/\/|#\/|\/u\/[1-9][0-9]*\/0x[a-fA-F0-9]{40}$|\/p\/[1-9][0-9]*\/[1-9][0-9]*(?:\?commit=0x[a-f0-9]{64})?$)/)
    }
    i += m[0].length - 1
  }
}

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<iframe src="https://example.com"></iframe>',
  '<style>body{display:none}</style>',
  '<a href="javascript:alert(1)">x</a>',
  '<div onclick="alert(1)">x</div>',
  '<details open ontoggle=alert(1)>',
  '<input onfocus=alert(1) autofocus>',
  '"><script>alert(1)</script>',
  '\'"--></style></script><script>alert(1)</script>',
  '<<script>script>alert(1)<</script>/script>',
  '<img src="x',
  '<a href="x" onmouseover="alert(1)">hover</a>',
  '<math><mtext></mtext></math>',
  '<!-- comment --><!DOCTYPE html><?php echo 1 ?><![CDATA[<script>]]>',
  '<base href="https://evil.example/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<form action="https://evil.example"><button>go</button></form>',
  '<object data="x"></object><embed src="x"><video src=x onerror=alert(1)>',
  '<textarea><script>alert(1)</script></textarea>',
  '<template><script>alert(1)</script></template>',
  '<a title="x" onmouseover=alert(1)>t</a>',
  '<ScRiPt>alert(1)</ScRiPt>',
  '<script\n>alert(1)</script\n>',
  '<script/x>alert(1)</script>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&#60;script&#62;alert(1)&#60;/script&#62;',
  '<javascript:alert(1)>',
  '[click](javascript:alert(1))',
  '[click](<javascript:alert(1)>)',
  '[click](JaVaScRiPt:alert(1))',
  '[click](java\tscript:alert(1))',
  '[click](data:text/html,<script>alert(1)</script>)',
  '[click](vbscript:msgbox(1))',
  '[click](https://example.com "title\\" onmouseover=\\"alert(1)")',
  '[click](https://example.com "title" onmouseover="alert(1)")',
  '[x](https://example.com/"><script>alert(1)</script>)',
  '[x](https://example.com/?a="&b=<>)',
  '![x](javascript:alert(1))',
  '![x](https://example.com/x.png" onerror="alert(1))',
  '![x" onerror="alert(1)](record:0x' + 'ab'.repeat(32) + ')',
  '[<b onmouseover=alert(1)>bold</b>](https://example.com)',
  '**<script>alert(1)</script>**',
  '*_<script>alert(1)</script>_*',
  '_*<img src=x onerror=alert(1)>*_',
  '`<script>alert(1)</script>`',
  '```html\n<script>alert(1)</script>\n```',
  '    <script>alert(1)</script>',
  '> <script>alert(1)</script>',
  '# <img src=x onerror=alert(1)>',
  '- <script>alert(1)</script>\n- [ ] <b onclick=alert(1)>task</b>',
  '| a | b |\n| --- | --- |\n| <script>alert(1)</script> | <img src=x onerror=alert(1)> |',
  '| a |\n| :-- |\n| x" onmouseover="alert(1) |',
  '<http://example.com/"onmouseover="alert(1)>',
  '<https://example.com/<script>>',
  'post://1/2?commit=0x"onmouseover="alert(1)',
  'post://1/2?commit=' + hex(2, 64) + '"onmouseover="alert(1)',
  'account://0x' + '12'.repeat(20) + '"onload="alert(1)',
  'account://0x' + '12'.repeat(20) + '<script>alert(1)</script>',
  'post://1/2<script>alert(1)</script>',
  `[x](post://1/2?commit=${hex(2, 64)}" onmouseover="alert(1))`,
  `[x](account://0x${'12'.repeat(20)}" onmouseover="alert(1))`,
  `![x](record:0x${'ab'.repeat(32)}" onerror="alert(1))`,
  '\u0000<script>alert(1)</script>\u0000',
  '\u202e<script>alert(1)</script>',
  '＜script＞alert(1)＜/script＞',
  '<scr\u0000ipt>alert(1)</script>',
  '\\<script>alert(1)</script>',
  '<a\thref\n=\n"javascript:alert(1)">x</a>',
  'x\n\n<div>\n\n**bold**\n\n</div>',
  '<p>paragraph</p><br/><hr/>',
]

const FRAGMENTS = [
  ...PAYLOADS.slice(0, 30),
  '<', '>', '"', "'", '`', '*', '_', '#', '|', '-', '!', '[', ']', '(', ')', '\\', '&', ';', '=',
  ' ', '  ', '\n', '\n\n', '\t', '---', '```', '~~~', '> ', '- ', '1. ', '- [ ] ', '<!--', '-->',
  'javascript:', 'data:', 'alert(1)', ' onerror=', ' onload=', 'href=', 'src=', 'script', '</', '/>',
  'post://1/', 'post://1/2?commit=', hex(7, 64), 'account://', '0x' + '12'.repeat(20), 'record:', '0x' + 'ab'.repeat(32),
  '![x](', '[x](', '<a href="', '&lt;', '&#60;', '&#x3c;', '\u0000', '\u202e', 'text', 'https://example.com/',
]

test('raw HTML and malicious attributes remain text through the actual Svelte renderer', async () => {
  for (const text of PAYLOADS) { auditSegments(parse(text)); auditHtml(await render(text)) }
  assert.ok((await render('<pre><script>alert(1)</script>')).includes('&lt;pre>&lt;script>alert(1)&lt;/script>'))
})

test('seeded hostile fragments never create extra element kinds or unsafe destinations', async () => {
  for (let seed = 1; seed <= 6; seed++) {
    const next = seeded(seed)
    for (let n = 0; n < 200; n++) {
      let text = ''
      const count = 1 + next(24)
      for (let i = 0; i < count; i++) text += FRAGMENTS[next(FRAGMENTS.length)]
      try { auditSegments(parse(text)); auditHtml(await render(text)) }
      catch (e) { assert.fail(`seed ${seed} case ${n}: ${e.message}, input ${JSON.stringify(text)}`) }
    }
  }
})

test('deep nesting, table padding and long link openers cannot expand into recursive markup', async () => {
  const table = '|a'.repeat(1000) + '|\n' + '|-'.repeat(1000) + '|\n' + '|x|\n'.repeat(1000)
  const corpus = [
    '*_'.repeat(20_000) + 'text' + '_*'.repeat(20_000),
    '*_both_* '.repeat(20_000),
    '<'.repeat(20_000), '['.repeat(1024 * 1024),
    '> '.repeat(5_000) + 'deep', '- '.repeat(2_400) + '<script>text</script>',
    '*a **b '.repeat(2_000) + 'end' + ' b** a*'.repeat(2_000),
    ('post://1/2?commit=' + hex(2, 64) + ' ').repeat(10_000),
    '<a '.repeat(10_000), table,
  ]
  const started = performance.now()
  for (const text of corpus) {
    const segments = parse(text)
    auditSegments(segments)
    const html = await render(text)
    assert.ok(!/<(?:table|td|blockquote|ul|li|pre|code)>/.test(html))
    // Escaping may grow bytes, but neither table cells nor recursive trees are generated.
    assert.ok(html.length < text.length * 6 + 100_000)
  }
  assert.deepEqual(parse(table), [{ kind: 'text', text: table, style: undefined }])
  const elapsed = performance.now() - started
  assert.ok(elapsed < 5_000, `hostile corpus took ${Math.round(elapsed)} ms`)
})

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { load, renderComponent, teardown } from '../../../../scripts/harness.mjs'
const { messageText } = await load('features/messages/message-text.ts')
const { router, href } = await load('features/navigation/router.svelte.ts')
const { bodyBytes } = await load('features/publishing/posting.ts')
const { interpret } = await load('lib/body.ts')
after(teardown)
const hash = n => `0x${n.toString(16).padStart(64, '0')}`
const address = '0x' + '12'.repeat(20)
const quote = n => `post://1/${n}?commit=${hash(n)}`
const picture = n => `![picture ${n}](record:${hash(n)})`
const parse = (text, options = {}) => messageText(text, { quotes: true, ...options })
const ofKind = (segments, kind) => segments.filter(s => s.kind === kind)
const shown = segments => segments.map(s => s.text ?? '').join('')
const html = text => renderComponent('features/messages/MessageBody.svelte', { body: { kind: 'text', text }, chainId: 1, id: 2n, author: address })

test('version one stores exact plain text, including literal HTML and formatting markers', () => {
  const text = '*bold*\n_italic_ <script>text</script>'
  const bytes = bodyBytes(text)
  assert.equal(new TextDecoder().decode(bytes), 'version/1 text/plain\n' + text)
  assert.deepEqual(interpret({ ok: true, bytes }), { kind: 'text', text })
})

test('single asterisks and underscores format spans; unsupported punctuation stays literal', () => {
  const text = 'hello *bold* and _italic_\n**double** ***triple*** word_inside_word'
  const segments = parse(text)
  assert.deepEqual(segments.filter(s => s.style).map(s => [s.text, s.style]), [
    ['bold', 'bold'], ['italic', 'italic'],
  ])
  assert.equal(shown(segments), 'hello bold and italic\n**double** ***triple*** word_inside_word')
  for (const literal of ['*unclosed', '_unclosed', '*line\nbreak*', '\\*escaped*', 'a*b*c', 'hello_there_', '* space*', '*space *', 'foo * bar * baz', '# heading\n> quote\n- list\n`code`']) {
    assert.equal(shown(parse(literal)), literal)
    assert.equal(parse(literal).some(s => s.style), false, literal)
  }
})

test('bold and italics combine in either order and keep surrounding styles', async () => {
  for (const text of ['*_foo_*', '_*foo*_']) {
    assert.deepEqual(parse(text), [{ kind: 'text', text: 'foo', style: 'bold-italic' }])
    assert.match((await html(text)).replace(/<!--.*?-->/gs, ''), /class="[^"]*\bbold\b[^"\n]*\bitalic\b[^"\n]*"[^>]*>foo<\/span>/)
  }
  assert.deepEqual(parse('*bold _both_ bold* and _italic *both* italic_').map(s => [s.text, s.style]), [
    ['bold ', 'bold'], ['both', 'bold-italic'], [' bold', 'bold'], [' and ', undefined],
    ['italic ', 'italic'], ['both', 'bold-italic'], [' italic', 'italic'],
  ])
  assert.deepEqual(parse('*bold _unfinished*').map(s => [s.text, s.style]), [['*bold _unfinished*', undefined]])
  for (const [text, expected] of [
    ['*_line\nbreak_*', '*_line\nbreak_*'], ['_*line\rbreak*_', '_*line\rbreak*_'],
    ['**_foo_**', '**foo**'], ['*_foo_*tail', '*foo*tail'], ['*_foo* bar_', '*foo* bar'],
  ]) {
    assert.equal(shown(parse(text)), expected)
    assert.equal(parse(text).some(s => s.style === 'bold-italic'), false, text)
  }
  assert.deepEqual(parse('*bold \\_literal\\_ bold*'), [{ kind: 'text', text: 'bold \\_literal\\_ bold', style: 'bold' }])
})

test('combined styles preserve link destinations and wrapped references', () => {
  for (const text of ['*_https://example.com/a_b_*', '_*https://example.com/a_b*_', '*outer _https://example.com/a_b_*']) {
    assert.deepEqual(ofKind(parse(text), 'link'), [{ kind: 'link', text: 'https://example.com/a_b', href: 'https://example.com/a_b', style: 'bold-italic' }])
  }
  assert.equal(ofKind(parse(`*_[alice](account://${address})_*`), 'mention')[0].style, 'bold-italic')
  for (const text of ['https://example.com/a_*', 'word*https://example.com/a*', '\\*https://example.com/a*']) {
    assert.equal(ofKind(parse(text), 'link')[0].style, undefined)
    assert.equal(shown(parse(text)), text)
  }
})

test('combined styles share the existing pair budget and leave the rest literal', () => {
  const input = Array(1000).fill('*_both_*').join(' ')
  const segments = parse(input)
  assert.equal(segments.filter(s => s.style === 'bold-italic').length, 32)
  assert.ok(shown(segments).endsWith('*_both_*'))
  assert.ok(segments.length <= 129)
})

test('URLs and domains retain visible destinations, punctuation and safe schemes', () => {
  const input = 'example.com, (https://example.org/a?q=1&v=2). http://example.net:8080/a_b mail@example.com'
  assert.deepEqual(ofKind(parse(input), 'link').map(s => s.href), [
    'https://example.com/', 'https://example.org/a?q=1&v=2', 'http://example.net:8080/a_b',
  ])
  assert.equal(shown(parse(input)), input)
  for (const text of ['javascript:alert(1)', 'data:text/html,<b>hi</b>', 'ftp://example.com/file', 'https://name:password@example.com/a']) {
    assert.equal(ofKind(parse(text), 'link').length, 0, text)
  }
  assert.deepEqual(ofKind(parse('*https://example.com/a* _example.org_ https://example.net/a_b'), 'link').map(s => [s.href, s.style]), [
    ['https://example.com/a', 'bold'], ['https://example.org/', 'italic'], ['https://example.net/a_b', undefined],
  ])
  assert.equal(shown(parse('[label](https://example.com)')), '[label](https://example.com)')
  for (const input of ['a*https://example.com/path*', '\\*https://example.com/path*']) {
    assert.equal(ofKind(parse(input), 'link')[0].href, 'https://example.com/path*', 'an invalid emphasis opener cannot trim the URL')
  }
})

test('Svelte escapes text and attributes; widget references open the app with pins', async () => {
  const text = `<script>alert(1)</script> <pre><img src=x onerror=alert(1)>\n*bold* _italic_\n${quote(7)} account://${address}`
  for (const embed of [false, true]) {
    try {
      router.embed = embed
      const rendered = await html(text)
      assert.ok(rendered.includes('&lt;script>alert(1)&lt;/script>'))
      assert.ok(!rendered.includes('<script') && !rendered.includes('<img'))
      for (const url of [href.thread(1, 7n, hash(7)), href.user(1, address)]) assert.ok(rendered.includes(`href="${url}"`), url)
      if (embed) {
        assert.ok(!rendered.includes('href="#/'))
        assert.equal((rendered.match(/target="_blank"/g) ?? []).length, 2)
        assert.equal((rendered.match(/rel="noopener noreferrer"/g) ?? []).length, 2)
      }
    } finally { router.embed = false }
  }
  const pictureHtml = await html(`![x" onmouseover="bad](record:${hash(1)})`)
  assert.ok(pictureHtml.includes('data-alt="x&quot; onmouseover=&quot;bad"'))
  assert.ok(!pictureHtml.includes(' onmouseover="'))
})

test('mentions and quotes share eight occurrence slots, before validation or deduplication', () => {
  const text = ['account://bad', ...Array(7).fill(`[@label](account://${address})`), quote(9)].join('\n')
  const segments = parse(text)
  assert.equal(ofKind(segments, 'mention').length, 7)
  assert.equal(ofKind(segments, 'quote').length, 0)
  assert.ok(shown(segments).includes(quote(9)))
  assert.equal(ofKind(parse(Array(500).fill(`account://${address}`).join(' ')), 'mention').length, 8)
})

test('images and quotes share a hard four-preview budget, reset per body', () => {
  const text = [picture(1), quote(2), picture(1), quote(2), picture(3), quote(4)].join('\n\n')
  const previews = options => parse(text, options).filter(s => s.kind === 'quote' || s.kind === 'record' && s.image)
  assert.equal(previews().length, 4)
  assert.equal(previews({ maxAttachments: 100 }).length, 4)
  assert.equal(previews({ maxAttachments: 1 }).length, 1)
  assert.equal(previews({ maxAttachments: 0 }).length, 0)
  assert.equal(previews().length, 4)
  const quoted = parse([quote(1), ...Array(20).fill(picture(2))].join('\n'), { quotes: false })
  assert.equal(ofKind(quoted, 'quote').length, 0)
  assert.equal(ofKind(quoted, 'post').length, 1)
  assert.equal(ofKind(quoted, 'record').filter(s => s.image).length, 4)
})

test('app wrappers retain mentions and pictures; invalid pins stay entirely literal', () => {
  const segments = parse(`hello [@label](account://${address})\n${picture(4)}\n[file](record:${hash(5)})\n${quote(6)}`)
  assert.equal(ofKind(segments, 'mention')[0].address, address)
  assert.deepEqual(ofKind(segments, 'record').map(s => [s.label, s.image]), [['picture 4', true], ['file', false]])
  assert.deepEqual(ofKind(segments, 'quote').map(s => s.id), [6n])
  for (const bad of [quote(1) + '&bad=true', quote(1) + 'f', quote(1).replace('commit=', 'commit=x'), 'post://1/0', 'post://9007199254740992/1']) {
    assert.equal(shown(parse(bad)), bad)
    assert.equal(parse(bad).some(s => s.kind === 'post' || s.kind === 'quote'), false)
  }
  assert.equal(ofKind(parse('inline ' + quote(1)), 'quote').length, 0)
  assert.equal(ofKind(parse('  ' + quote(1) + '  '), 'quote').length, 1)
})

test('line breaks that only frame a quote card or picture are not shown', () => {
  assert.deepEqual(parse(`\n\n${quote(6)}\n`).map(s => s.kind), ['quote'])
  const around = parse(`before\n\n${quote(6)}\n\nafter\n${picture(2)}\n`)
  assert.deepEqual(around.map(s => [s.kind, s.text ?? null]), [['text', 'before'], ['quote', null], ['text', 'after'], ['record', null]])
  // Inside a line nothing is trimmed: the words around an inline post link keep their spaces and line end.
  assert.deepEqual(parse(`see post://1/6 here\n`).map(s => s.kind === 'text' ? s.text : s.kind), ['see ', 'post', ' here\n'])
  assert.deepEqual(parse(`a\n${quote(6)} tail\n`).map(s => s.kind), ['text', 'post', 'text'])
})

test('references inside labels cannot overlap following references or duplicate text', () => {
  const segments = parse(`[account://${address}](account://${address}) *ok*`)
  assert.equal(ofKind(segments, 'mention').length, 2)
  assert.equal(shown(segments), '[]() ok')
  assert.equal(segments.at(-1).style, 'bold')
})

test('budgets leave excess source literal and never link a truncated token', () => {
  const links = Array(500).fill('example.com').join(' ')
  assert.equal(ofKind(parse(links), 'link').length, 64)
  assert.equal(shown(parse(links)), links)
  assert.equal(parse(Array(500).fill('*hi*').join(' ')).filter(s => s.style).length, 64)
  const large = 'x'.repeat(65_500) + ' ' + quote(9)
  assert.equal(shown(parse(large)), large)
  assert.equal(ofKind(parse(large), 'quote').length, 0)
  const records = parse(Array(1000).fill(picture(1)).join('\n'))
  assert.equal(ofKind(records, 'record').length, 128)
  assert.ok(shown(records).endsWith(picture(1)))
})

test('mentions render the current name through the template, the address when none is known', async () => {
  const { names } = await load('lib/names.svelte.ts')
  const other = '0x' + '34'.repeat(20)
  const saved = names.entries
  names.entries = { [address]: { name: 'alice.eth', checkedAt: Date.now() } }
  try {
    const page = await html(`hi account://${address} and account://${other}`)
    assert.match(page, /<a class="mention[^"]*"[^>]*>@alice\.eth<\/a>/)
    assert.match(page, new RegExp(`<a class="mention[^"]*"[^>]*>@${other.slice(0, 6)}`))
  } finally { names.entries = saved }
})

import { test, expect, card, author, deferred, fulfill } from './host.mjs'

const metadata = (image = 'https://blohard.social/account-keys-card.jpg') => `<!doctype html><html><head>
  <meta property="og:title" content="about account keys &amp; markets">
  <meta property="og:description" content="Learn how &lt;b&gt;keys&lt;/b&gt; work.">
  <meta property="og:image" content="${image}">
  <script>throw new Error('metadata script executed')</script>
  <iframe src="https://unwanted.example/frame"></iframe>
  <img src="https://unwanted.example/pixel">
  </head><body>not preview text</body></html>`

async function pages(page) {
  await page.route('**/keys/84532/about', route => route.fulfill({ contentType: 'text/html', body: metadata() }))
  await page.route('http://127.0.0.1:8790/about', route => route.fulfill({ contentType: 'text/html', body: metadata('https://unwanted.example/thumbnail') }))
  await page.route('**/design.html', route => route.fulfill({ status: 302, headers: { location: 'https://unwanted.example/redirect' } }))
}

test('same-site metadata takes priority over post-link quotes and explicit quotes still work', async ({ page, host }) => {
  await pages(page)
  const original = host.post(1, 'Original post body')
  host.post(2, 'https://blohard.social/p/84532/1 https://blohard.social/keys/84532/about')
  host.post(3, 'Only a post URL https://blohard.social/p/84532/1')
  host.post(4, `post://84532/1?commit=${original.commitment}\nhttps://blohard.social/keys/84532/about https://blohard.social/p/84532/1`)
  host.post(5, 'No remote thumbnail https://blohard.social/about')
  host.post(6, 'No redirects https://blohard.social/design.html')
  await page.goto('/')
  const link = card(page, 2).getByRole('complementary', { name: 'link preview' })
  await expect(link).toContainText('about account keys & markets')
  await expect(link).toContainText('Learn how <b>keys</b> work.')
  await expect(link).not.toContainText('not preview text')
  await expect(link.locator('.description b')).toHaveCount(0)
  await expect(link.locator('img')).toHaveAttribute('src', 'http://127.0.0.1:8790/account-keys-card.jpg')
  await expect(card(page, 3)).toContainText('Only a post URL')
  await expect(card(page, 3).locator('.quote')).toContainText('Original post body')
  await expect(card(page, 2).locator('.quote')).toHaveCount(0)
  await expect(card(page, 4).locator('.quote')).toContainText('Original post body')
  await expect(card(page, 4).locator('.quote')).toHaveCount(1)
  await expect(card(page, 4).locator('.link-preview')).toHaveCount(0)
  await expect(card(page, 5).locator('.link-preview')).toContainText('about account keys & markets')
  await expect(card(page, 5).locator('.link-preview img')).toHaveCount(0)
  await expect(card(page, 6).locator('.link-preview')).toHaveCount(0)
  await expect(card(page, 6).getByRole('link', { name: 'https://blohard.social/design.html', exact: true })).toBeVisible()
})

for (const kind of ['page', 'post']) test(`a draft previews a ${kind} link without allowing navigation`, async ({ page, host }) => {
  await pages(page)
  host.post(1, 'A topic')
  await page.addInitScript(who => {
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method }) {
        if (method === 'eth_accounts') return [who]
        if (method === 'eth_chainId') return '0x14a34'
        throw Object.assign(new Error(`unsupported wallet method ${method}`), { code: 4200 })
      },
    }
  }, author)
  await page.goto('/')
  const draft = kind === 'page' ? 'Learn about keys https://blohard.social/keys/84532/about' : 'See https://blohard.social/p/84532/1 for context'
  const editor = page.getByPlaceholder('type a message, drop or paste an image')
  await editor.fill(draft)
  await page.getByRole('button', { name: 'preview', exact: true }).click()
  const modal = page.getByRole('dialog')
  if (kind === 'page') {
    await expect(modal.locator('.link-preview')).toContainText('about account keys & markets')
    await modal.getByRole('link', { name: /about account keys/ }).click()
  } else {
    await expect(modal.locator('.quote')).toContainText('A topic')
    await modal.getByRole('link', { name: 'open quoted post #1', exact: true }).click()
  }
  await expect(modal).toBeVisible()
  await expect(page).toHaveURL('http://127.0.0.1:8790/')
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(editor).toHaveValue(draft)
})

for (const width of [1100, 390]) test(`quotes and commentary have independent preview limits at ${width}px`, async ({ page, host }) => {
  await page.setViewportSize({ width, height: 1000 })
  const original = host.post(1, Array.from({ length: 40 }, (_, i) => `Quoted line ${i + 1}`).join('\n'))
  const quote = `post://84532/1?commit=${original.commitment}`
  host.post(2, `Cool way for agents to coordinate.\nI haven't tried it yet.\nI like the idea.\n${quote}`)
  host.post(3, `${Array.from({ length: 20 }, (_, i) => `Commentary line ${i + 1}`).join('\n')}\n${quote}`)
  await page.goto('/')
  for (const id of [2, 3]) {
    const post = card(page, id)
    const quoted = post.locator('.quote')
    await expect(quoted).toContainText('Quoted line 1')
    await expect(quoted.getByRole('link', { name: 'read full post', exact: true })).toHaveAttribute('href', `/p/84532/1?commit=${original.commitment}`)
    await expect(post.locator('.preview .quote')).toHaveCount(0)
    await expect(post.getByRole('link', { name: 'read full post', exact: true })).toHaveCount(id === 2 ? 1 : 2)
  }
  await expect(card(page, 3).getByRole('link', { name: 'read full post', exact: true }).first()).toHaveAttribute('href', '/p/84532/3')
  await card(page, 2).locator('.quote').getByRole('link', { name: 'read full post', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/p/84532/1\\?commit=${original.commitment}$`))
  await expect(card(page, 1)).toContainText('Quoted line 40')
})


test('a reply quotes an inline post link without changing its parent or nesting cards', async ({ page, host }) => {
  host.post(1, 'A referenced post with https://blohard.social/p/84532/2 inside it')
  host.post(2, 'Do not nest this post')
  host.post(3, 'The post being answered')
  host.post(4, 'See https://blohard.social/p/84532/1 for context.', { parent: 3 })
  await page.goto('/p/84532/4')
  const reply = card(page, 4)
  await expect(reply.locator('.quote')).toContainText('A referenced post')
  await expect(reply.locator('.quote .quote, .quote .link-preview')).toHaveCount(0)
  await expect(reply.getByRole('link', { name: 'https://blohard.social/p/84532/1', exact: true })).toBeVisible()
  await expect(card(page, 3)).toContainText('The post being answered')
  await reply.getByRole('link', { name: 'open quoted post #1', exact: true }).click()
  await expect(page).toHaveURL('http://127.0.0.1:8790/p/84532/1')
})

for (const outcome of ['card', 'no metadata', 'failure']) test(`a post-link quote waits for the ordinary preview: ${outcome}`, async ({ page, host }) => {
  host.post(1, 'The fallback quote')
  host.post(2, 'See https://blohard.social/p/84532/1 and https://example.org/context')
  await page.route('**/api/status', async route => {
    const answer = await (await host.answer(route.request())).json()
    answer.gateway.link_previews = true
    await fulfill(route, new Response(JSON.stringify(answer)))
  })
  const started = deferred(), release = deferred()
  await page.route('**/api/link-preview?**', async route => {
    started.resolve()
    await release.promise
    await route.fulfill({ status: outcome === 'failure' ? 503 : 200, json: {
      preview: outcome === 'card' ? { title: 'External context', description: 'A preview', image: null } : null,
    } })
  })
  await page.goto('/')
  await started.promise
  const post = card(page, 2)
  try { await expect(post.locator('.quote')).toHaveCount(0) }
  finally { release.resolve() }
  if (outcome === 'card') {
    await expect(post.locator('.link-preview')).toContainText('External context')
    await expect(post.locator('.quote')).toHaveCount(0)
  } else {
    await expect(post.locator('.quote')).toContainText('The fallback quote')
    await expect(post.locator('.link-preview')).toHaveCount(0)
  }
})

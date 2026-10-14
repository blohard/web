// Render the pinned public protocol spec at the site's existing /design.html URL.
// Run after vite build; --out selects another output directory.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Marked } from 'marked'

const protocolRoot = new URL('../lib/protocol/', import.meta.url)
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: protocolRoot, encoding: 'utf8' }).trim()
const repository = `https://github.com/blohard/protocol/blob/${revision}/`

export const DOCS = [
  { source: 'SPEC.md', page: 'design.html', title: 'blohard protocol', nav: 'design',
    description: 'the protocol specification of blohard, a public message board kept on EVM chains.' },
]

/** GitHub-style heading anchors, so links written against the repository keep working. */
export function slug(text, seen = new Map()) {
  const base = text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
  const n = seen.get(base) ?? 0
  seen.set(base, n + 1)
  return n === 0 ? base : `${base}-${n}`
}

/** Keep anchors on this page and link other protocol files at the same revision. */
export function rewriteLink(href) {
  if (/^(https?:|mailto:|#)/.test(href)) return href
  const path = href.replace(/^\.\//, '')
  if (/^SPEC\.md(#.*)?$/.test(path)) return `/design.html${path.slice('SPEC.md'.length)}`
  return new URL(path, repository).href
}

function markdown() {
  const seen = new Map()
  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        const id = slug(text, seen)
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens)
        const target = rewriteLink(href)
        const t = title ? ` title="${title}"` : ''
        const rel = /^https?:/.test(target) ? ' rel="noopener"' : ''
        return `<a href="${target}"${t}${rel}>${inner}</a>`
      },
    },
  })
  return marked
}

export function render(doc, source, stamp) {
  const body = markdown().parse(source)
  const nav = DOCS.map((d) => (d === doc ? `<span class="here">${d.nav}</span>` : `<a href="/${d.page}">${d.nav}</a>`)).join('\n      ')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <meta name="description" content="${doc.description}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="blohard" />
    <meta property="og:title" content="${doc.title}" />
    <meta property="og:description" content="${doc.description}" />
    <meta property="og:url" content="https://blohard.social/${doc.page}" />
    <meta property="og:image" content="https://blohard.social/card.jpg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="a cartoon whale spouting water among the waves" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${doc.title}" />
    <meta name="twitter:description" content="${doc.description}" />
    <meta name="twitter:image" content="https://blohard.social/card.jpg" />
    <link rel="icon" type="image/png" sizes="64x64" href="/favicon.png" />
    <title>${doc.title}</title>
    <style>
      :root { --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
        --bg: #f7f7f2; --fg: #17170f; --dim: #6a6a60; --border: #d8d8cf; --accent: #2c5f9e; --tint: #ecece4; color-scheme: light dark; }
      @media (prefers-color-scheme: dark) { :root { --bg: #0f100e; --fg: #e8e8df; --dim: #8b8b80; --border: #2a2b27; --accent: #8fc4f0; --tint: #181914; } }
      * { box-sizing: border-box; }
      html, body { margin: 0; background: var(--bg); color: var(--fg); }
      body { font: 15px/1.55 var(--mono); }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      nav { display: flex; flex-wrap: wrap; gap: 0.5rem 1.2rem; max-width: 56rem; margin: 0 auto; padding: 0.8rem 1.2rem; border-bottom: 1px dashed var(--border); }
      nav .home { font-weight: 700; margin-right: auto; }
      nav .here { color: var(--dim); }
      main { max-width: 56rem; margin: 0 auto; padding: 1rem 1.2rem 4rem; overflow-wrap: anywhere; }
      h1 { font-size: 1.6rem; line-height: 1.25; } h2 { font-size: 1.3rem; margin-top: 2.4rem; border-top: 1px dashed var(--border); padding-top: 1.2rem; }
      h3 { font-size: 1.1rem; margin-top: 1.8rem; } h4 { font-size: 1rem; }
      h1, h2, h3, h4 { scroll-margin-top: 1rem; }
      code { background: var(--tint); padding: 0.05rem 0.3rem; border-radius: 3px; font-size: 0.95em; }
      pre { background: var(--tint); padding: 0.8rem 1rem; overflow-x: auto; border: 1px dashed var(--border); }
      pre code { background: none; padding: 0; font-size: 0.9em; }
      blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid var(--border); color: var(--dim); }
      table { display: block; overflow-x: auto; border-collapse: collapse; margin: 1rem 0; }
      th, td { border: 1px solid var(--border); padding: 0.35rem 0.6rem; text-align: left; vertical-align: top; overflow-wrap: normal; }
      td:first-child, th:first-child { white-space: nowrap; }
      th { background: var(--tint); }
      hr { border: 0; border-top: 1px dashed var(--border); }
      footer { max-width: 56rem; margin: 0 auto; padding: 1rem 1.2rem 3rem; color: var(--dim); border-top: 1px dashed var(--border); }
    </style>
  </head>
  <body>
    <nav>
      <a class="home" href="/">blohard</a>
      ${nav}
    </nav>
    <main>
${body}    </main>
    <footer>rendered from ${doc.source} in the blohard/protocol repository${stamp}</footer>
  </body>
</html>
`
}

function stamp() {
  return `, commit ${revision.slice(0, 7)}, ${new Date().toISOString().slice(0, 10)}`
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const i = process.argv.indexOf('--out')
  const out = new URL(i > 0 ? `${process.argv[i + 1].replace(/\/?$/, '/')}` : '../dist/', import.meta.url)
  mkdirSync(out, { recursive: true })
  const when = stamp()
  for (const doc of DOCS) {
    const source = readFileSync(new URL(doc.source, protocolRoot), 'utf8')
    writeFileSync(new URL(doc.page, out), render(doc, source, when))
    console.log(`wrote ${doc.page} from ${doc.source}`)
  }
}

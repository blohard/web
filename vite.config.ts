import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import { base, baseSepolia } from 'viem/chains'

/**
 * The revision of this checkout, written into each page so it can say which
 * build it runs (src/shared/build.ts). A build with uncommitted changes to
 * tracked files is marked, since it is not the revision it would otherwise name.
 * Outside a git checkout the build is "unknown".
 */
function revision(): string {
  try {
    const git = (...args: string[]) => execFileSync('git', args,
      { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const head = git('rev-parse', '--short=12', 'HEAD')
    return git('status', '--porcelain', '--untracked-files=no') ? `${head}-dirty` : head
  } catch {
    return 'unknown'
  }
}

// In development the app runs on Vite's server and proxies /api to a host, so
// it behaves exactly as when the host serves the built files itself.
// Point HOST_URL at any running host (default: a local one).
export default defineConfig(() => {
  const build = revision()
  let deployment: { revision: string; chains: number[]; market: string | null; devFund: string | null }
  return {
    plugins: [svelte(), {
      name: 'deployment-metadata',
      // In each page's head, not in a script: a new revision alone must not rename the script files.
      transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'blohard-build', content: build }, injectTo: 'head' }],
      configResolved(config) {
        deployment = { revision: build, chains: [base.id, baseSepolia.id], market: config.env.VITE_ACCOUNT_KEYS_ADDRESS || null,
          devFund: config.env.VITE_ACCOUNT_KEYS_DEV_FUND || null }
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'deployment.json', source: JSON.stringify(deployment) })
      },
    }],
    // Two pages: the app, and the discussion widget's frame (embed.html, put
    // on other sites' pages by public/embed.js).
    build: { rollupOptions: { input: { main: 'index.html', embed: 'embed.html' } } },
    server: {
      proxy: {
        // With RELAY_URL set, the relayer's routes go to it, as Caddy does in
        // production; otherwise they reach the host, which answers 404 (no relayer).
        ...(process.env.RELAY_URL ? { '/api/relay': { target: process.env.RELAY_URL, changeOrigin: true } } : {}),
        // changeOrigin rewrites the Host header, so a host behind a name-checking
        // reverse proxy answers too.
        '/api': { target: process.env.HOST_URL ?? 'http://127.0.0.1:8080', changeOrigin: true },
      },
    },
  }
})

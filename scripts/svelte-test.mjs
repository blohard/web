// Test-only Svelte loading. Reactive fixtures use the browser compiler in Node;
// static component assertions use the server renderer, without running effects.
import { build, createServer } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Compile one state-only fixture with the client runtime, including its effects. */
export async function reactiveFixture(entry, define = {}) {
  const result = await build({
    root, configFile: false, plugins: [svelte()], logLevel: 'error', define,
    build: { write: false, minify: false,
      lib: { entry: fileURLToPath(entry), formats: ['es'] },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
  const { output } = Array.isArray(result) ? result[0] : result
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`)
}

/** Own the compiler, its isolated cache and the matching Svelte server renderer. */
export async function componentRenderer() {
  // Parallel fixtures must not rebuild one another's Svelte dependency cache.
  const cacheDir = await mkdtemp(join(tmpdir(), 'blohard-web-tests-'))
  const server = await createServer({
    // Without the app config, Vite preserves watch: null. Tests need no watchers.
    root, configFile: false, plugins: [svelte()], logLevel: 'error', cacheDir,
    server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom',
  })
  if (Object.keys(server.watcher.getWatched()).length > 0) throw new Error('the test server must not watch files')
  const { render } = await server.ssrLoadModule('svelte/server')
  const load = name => server.ssrLoadModule(`/src/${name}`)
  return {
    load, render,
    async renderComponent(name, props) {
      const { default: Component } = await load(name)
      return render(Component, { props }).body
    },
    async close() {
      await server.close()
      // The dependency optimizer may still be finishing its final cache write.
      await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    },
  }
}

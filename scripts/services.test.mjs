import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { serviceBinaries } from './services.mjs'

test('the services are named through the environment, and what is missing is said before anything starts', async () => {
  assert.throws(() => serviceBinaries({}, {}), /BLOHARD_HOST_BIN \(a blohard-host binary\) and BLOHARD_RELAY_BIN \(a blohard-relay binary\)/)
  assert.throws(() => serviceBinaries({ relay: false }, {}), /^Error: set BLOHARD_HOST_BIN \(a blohard-host binary\) before/)
  assert.throws(() => serviceBinaries({}, { BLOHARD_HOST_BIN: '/nowhere/blohard-host', BLOHARD_RELAY_BIN: '/nowhere/blohard-relay' }),
    /BLOHARD_HOST_BIN names \/nowhere\/blohard-host, which does not exist/)
  const dir = await mkdtemp(join(tmpdir(), 'blohard-services-'))
  await writeFile(join(dir, 'host'), '')
  await writeFile(join(dir, 'relay'), '')
  assert.deepEqual(serviceBinaries({}, { BLOHARD_HOST_BIN: join(dir, 'host'), BLOHARD_RELAY_BIN: join(dir, 'relay') }),
    { host: resolve(dir, 'host'), relay: resolve(dir, 'relay') })
  assert.deepEqual(serviceBinaries({ relay: false }, { BLOHARD_HOST_BIN: join(dir, 'host') }), { host: resolve(dir, 'host') })
})

// The host and relayer binaries the integration stack and the read-cost
// measurement run. They are built elsewhere, the host from
// github.com/blohard/host and the relayer by a deployment's operator, and
// named through the environment, so a checkout of this app alone says plainly
// what it lacks before starting anything.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** The binaries named by `BLOHARD_HOST_BIN` and, unless `relay` is false, `BLOHARD_RELAY_BIN`, as absolute paths. */
export function serviceBinaries({ relay = true } = {}, env = process.env) {
  const wanted = [
    ['BLOHARD_HOST_BIN', 'host', 'a blohard-host binary'],
    ...(relay ? [['BLOHARD_RELAY_BIN', 'relay', 'a blohard-relay binary']] : []),
  ]
  const missing = wanted.filter(([name]) => !env[name]).map(([name, , what]) => `${name} (${what})`)
  if (missing.length) {
    throw new Error(`set ${missing.join(' and ')} before starting services; see scripts/integration/README.md`)
  }
  const found = {}
  for (const [name, key] of wanted) {
    const path = resolve(env[name])
    if (!existsSync(path)) throw new Error(`${name} names ${path}, which does not exist`)
    found[key] = path
  }
  return found
}

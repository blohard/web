// Read artifacts from the public project that owns each contract, pinned as a
// submodule under lib/ and built there with forge. Paths are relative to this
// app's root.
const keyContracts = new Set(['AccountKeys', 'AuthorKeyGate', 'AuthorKeyBlocklistGate'])
export function artifactPath(name, source = name) {
  const project = keyContracts.has(name) ? 'lib/account-keys' : 'lib/protocol'
  return `${project}/out/${source}.sol/${name}.json`
}

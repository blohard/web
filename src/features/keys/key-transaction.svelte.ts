// A key market's transaction: a tracked transaction whose confirmation also
// makes every keyring view read again, since the reader's keyring changed.
import type { KeyAccount } from './account-keys'
import { forgetKeyrings } from './keyring'
import { trackedTransaction } from '../../lib/tracked-transaction.svelte'

export function keyTransaction(key: string) {
  return trackedTransaction<KeyAccount>(key, forgetKeyrings)
}

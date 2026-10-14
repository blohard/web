<script lang="ts">
  // How an author is written: the verified name when there is one, otherwise
  // the shortened address. The full address is always a hover away, and on
  // the profile page; a name is a hint, not an identity.
  import { names } from '../lib/names.svelte'

  let { address }: { address: string } = $props()
</script>

<span class="name" title={address}>{names.display(address)}</span>

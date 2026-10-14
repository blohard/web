<script lang="ts">
  // An ETH amount as people read it (lib/format.ts ethAmount): three significant
  // digits with zeros written out. The exact amount is on hover and read aloud
  // by screen readers.
  import { formatEther } from 'viem'
  import { ethAmount } from '../lib/format'

  let { wei, round = 'nearest', unit = true }: {
    wei: bigint
    round?: 'up' | 'down' | 'nearest'
    /** Off where the caller sets the unit apart itself; it then hides that unit from screen readers. */
    unit?: boolean
  } = $props()
  let exact = $derived(`${formatEther(wei)} ETH`)
</script>

<span class="eth" title={exact}><span aria-hidden="true">{ethAmount(wei, round)}{unit ? ' ETH' : ''}</span><span class="visually-hidden">{exact}</span></span>

<style>
  .eth { white-space: nowrap; }
</style>

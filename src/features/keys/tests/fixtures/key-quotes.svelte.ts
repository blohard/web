import { keyQuote } from '../../key-page.svelte'
export { flushSync } from 'svelte'

export function quoteView(read: (amount: number) => Promise<number>) {
  let amount = $state(1), enabled = $state(true)
  let quote: ReturnType<typeof keyQuote<number>>
  const stop = $effect.root(() => {
    quote = keyQuote(() => {
      const n = amount
      return enabled ? () => read(n) : null
    })
  })
  return {
    set(amount_: number) { amount = amount_ },
    disable() { enabled = false },
    get value() { return quote.value },
    get error() { return quote.error },
    stop,
  }
}

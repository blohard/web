/** A call that gives up after `ms` with the error `expired` makes. */
export function withTimeout<T>(call: Promise<T>, ms: number, expired: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([call, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expired()), ms) })])
    .finally(() => clearTimeout(timer))
}

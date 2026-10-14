// Plain test data helpers: no Svelte runtime or global replacements.
export const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export const address = (byte) => `0x${byte.repeat(20)}`
export const hash = (byte) => `0x${byte.repeat(32)}`
export const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

/** Bounded body collection only: callers own timeouts, decoding and policy. */
export class ResponseTooLarge extends Error {
  constructor() { super('response exceeds byte limit') }
}

export async function responseBytes(response: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel().catch(() => {})
    throw new ResponseTooLarge()
  }
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) throw new ResponseTooLarge()
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

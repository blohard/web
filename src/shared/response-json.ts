// Decode once, with a byte bound. Endpoint callers decide whether an answer
// is valid and what an unreadable response means for retry or recovery.
import { responseBytes } from './response-bytes.ts'

export async function responseJson(response: Response, max = 1 << 20): Promise<unknown> {
  const bytes = await responseBytes(response, max)
  if (!bytes) throw new Error('the host returned an empty answer')
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

/** Human-readable service refusals; never render a proxy's HTML error page. */
export function errorMessage(response: Response, answer: unknown): string {
  if (answer && typeof answer === 'object' && 'error' in answer
    && typeof answer.error === 'string' && answer.error) return answer.error
  return response.statusText
}

/**
 * The wait a refusal's `Retry-After` names, in milliseconds, or null when it
 * names none (absent, a date or not a number). Zero is a wait, of none: it
 * still marks a refusal that passes. Each caller bounds it for its own purpose.
 */
export function retryAfter(response: Response): number | null {
  const header = response.headers.get('retry-after')
  const seconds = header === null || header.trim() === '' ? NaN : Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

import { sameAddress } from '../../lib/format'
import { getAddress, isAddress, zeroAddress, type Address } from 'viem'
import { ApiError, requestPath } from '../../lib/api'

/** Addresses are immediate. Only complete eth names reach the debounced lookup. */
export function recipientInput(text: string): { address: Address | null; name: string | null; error: string; hint: string } {
  const value = text.trim()
  if (!value) return { address: null, name: null, error: '', hint: '' }
  if (isAddress(value)) return { address: getAddress(value), name: null, error: '', hint: '' }
  if (!/^0x/i.test(value)) {
    if (!/\.eth$/i.test(value)) return { address: null, name: null, error: '', hint: 'names end in .eth' }
    if (new TextEncoder().encode(value).length <= 255 && !/[\s\u0000-\u001f\u007f]/u.test(value)) {
      return { address: null, name: value, error: '', hint: '' }
    }
  }
  return { address: null, name: null, error: 'enter a wallet address, ENS name or Basename', hint: '' }
}

export function canRetryRecipient(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503
}

/** Resolve once for review. Submission uses this address, never a second name lookup. */
export async function resolveRecipient(input: string): Promise<{ name: string; address: Address }> {
  const answer = await requestPath<{ name: unknown; address: unknown }>(`/api/names/resolve/${encodeURIComponent(input.trim())}`)
  if (!answer || typeof answer.name !== 'string' || answer.name.length > 255 || !answer.name.endsWith('.eth')) {
    throw new Error('invalid recipient lookup')
  }
  if (answer.address === null) throw new Error('this name has no wallet address')
  if (typeof answer.address !== 'string' || !isAddress(answer.address) || sameAddress(answer.address, zeroAddress)) {
    throw new Error('invalid recipient lookup')
  }
  return { name: answer.name, address: getAddress(answer.address) }
}

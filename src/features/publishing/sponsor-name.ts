// A name is only a lookup hint. The relayer verifies ownership independently.
// Hints are names the host verified, already in ENS's normalized spelling.

const hints = new Map<string, string>()
const key = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

export function sponsorName(chainId: number, address: string): string | undefined {
  return hints.get(key(chainId, address))
}

export function setSponsorName(chainId: number, address: string, value: string): void {
  const name = value.trim()
  if (name && (new TextEncoder().encode(name).length > 255 || !/^[^.]+\.(?:base\.)?eth$/.test(name))) {
    throw new Error('enter a name directly under .eth or .base.eth')
  }
  if (hints.size >= 64) hints.clear()
  if (name) hints.set(key(chainId, address), name)
  else hints.delete(key(chainId, address))
}

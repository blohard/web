import type { Address, Hex } from 'viem'

/** One chain the host serves, as published by GET /api/status. */
export type ChainInfo = {
  id: number
  name: string | null
  contract: Address
  /** Browser-safe RPC URL, or null if the operator published none. */
  public_rpc_url: string | null
  /** Native gas token; absent on older hosts, which assumed Ether. */
  native_currency?: { name: string; symbol: string; decimals: number }
  /** Deployment block, published for diagnostics. */
  start_block: number
  /** Configured accepted depth, published for diagnostics. */
  confirmations: number
  /** This host offers its shared curated list as a feed and badges on this chain. */
  curated?: boolean
  /** Display policy, independent of reply gates and available during gate validation. */
  blocklist?: { registry: Address; list: string } | null
  /** The blocking setup the host suggests: a shared author gate over each author's own list. */
  blocking?: { gate: Address; registry: Address; list: string } | null
  /** Verified deny-all gate for reversible closing of direct replies. */
  closed_gate?: Address | null
  /** Verified shared key gates for this Board. The combined gate uses blocking's registry/list. */
  key_gates?: { holders?: Address | null; holders_blocklist?: Address | null } | null
  /** A configured gate is still validating, so it is left out above for now. */
  gates_pending?: boolean
}

/** A named on-chain list, used by personal reply gates. */
export type ListInfo = { registry: Address; owner: Address; name: string; id: Hex }

export type HostPolicy = {
  admin: Address
  admin_chain: number
  origin: string
  revision: string
  curated: Address[]
  blocked: Address[]
  /** Accounts the admin labels as bots. */
  bots: Address[]
  /** Accounts whose own latest statement says they are bots (design/BOT_LABELS.md). */
  declared_bots: Address[]
  /** Raised by every accepted declaration; the admin revision cannot order them. */
  declarations: string
}

/** The host's attachment policy (the protocol spec §7); null = bodies only. */
export type AttachmentPolicy = {
  max_bytes: number
  max_per_message: number
  /** Media types the host stores, or null for any. */
  media_types?: string[] | null
}

/**
 * The content-store role's facts, when the host plays it
 * (https://github.com/blohard/host/blob/main/STORE_API.md).
 */
type StoreInfo = {
  max_content_size: number
  /** Required for every content store; all admitted records carry a header. */
  envelope: { version: number }
  attachments: AttachmentPolicy | null
  /** The holding area for uploads not yet accepted by the index. */
  holding?: { entries: number; bytes: number; max_bytes: number; max_per_signer: number; ttl_secs: number }
}

/** The gateway role's facts, when the host plays it. */
type GatewayInfo = {
  /** The host offers verified ENS/Basenames display-name lookup. */
  names: boolean
  /** The host offers bounded external link metadata. */
  link_previews?: boolean
}

/** One independently indexed account-key market. */
export type KeyringInfo = { chain: number; market: Address; start_block: number }

/**
 * GET /api/status, as documented in https://github.com/blohard/host/blob/main/STORE_API.md and
 * https://github.com/blohard/host/blob/main/GATEWAY_API.md;
 * not every field is read by this app. A host is a content store, a gateway,
 * or both; a role it does not play is null.
 */
export type Status = {
  host_policy?: HostPolicy | null
  keyrings?: KeyringInfo[]
  verifier: string
  chains: ChainInfo[]
  store: StoreInfo | null
  gateway: GatewayInfo | null
  /** The operator's one-line notice for visitors, shown in the rail and on the About page. */
  notice?: string | null
}

/** The immutable identity needed to display, link or reply to a message. */
export type MessageRef = {
  id: bigint
  author: Address
  parentId: bigint
  contentHash: Hex
}

/** An indexed message's identity and chain position, used for ordering feeds. */
export type Posted = MessageRef & {
  /** Zero for a top-level post. */
  parentAuthor: Address
  blockNumber: bigint
  logIndex: number
}

/** Accepted message identity and location. Gates and counts belong to a fresh
 * snapshot, never to a cached message returned for display or quoting. */
export type MessageRecord = Readonly<Posted & {
  timestamp: number
  txHash: Hex
  commitment: Hex
}>

/** Minimal EIP-1193 provider surface the app relies on (window.ethereum). */
export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>
  on(event: string, listener: (...args: unknown[]) => void): void
  removeListener(event: string, listener: (...args: unknown[]) => void): void
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider
  }
}

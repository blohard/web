// Local operator policy. The server verifies signed edits; wallet identity in
// the UI only decides which controls to offer.
import { isAddress, isHex, stringToHex, type Address, type Hex } from 'viem'
import { host } from './host.svelte'
import { requestPath, integer } from './api'
import type { HostPolicy } from './types'
import { captureWallet, type ActionWallet } from './wallet-action'
import { guarded } from './signer'

export type HostList = 'curated' | 'blocked' | 'bots'
export type ListEdit = { revision: string; expires: number; list: HostList; action: 'add' | 'remove'; addresses: Address[] }

export function policyMessage(origin: string, edit: ListEdit): string {
  return `Host policy update\nHost: ${origin}\nRevision: ${edit.revision}\nExpires: ${edit.expires}\nList: ${edit.list}\nAction: ${edit.action}\nAddresses:\n${edit.addresses.map(a => a.toLowerCase()).join('\n')}`
}
export function declarationMessage(origin: string, account: Address, bot: boolean, issued: number): string {
  return `Bot declaration\nHost: ${origin}\nAccount: ${account.toLowerCase()}\nBot: ${bot ? 'yes' : 'no'}\nIssued: ${issued}`
}
function checked(policy: HostPolicy): HostPolicy {
  integer(policy.revision)
  integer(policy.declarations)
  if (!isAddress(policy.admin) || !Number.isSafeInteger(policy.admin_chain) || typeof policy.origin !== 'string'
    || !(['curated', 'blocked', 'bots', 'declared_bots'] as const).every(k => {
      const addresses = policy[k]
      return Array.isArray(addresses) && addresses.length <= 4096 && addresses.every(a => typeof a === 'string' && isAddress(a))
    })) throw new Error('invalid host policy')
  return policy
}
/**
 * A late answer cannot undo a newer one: the admin lists follow their
 * revision and the declarations their own counter, since declaring never
 * moves the revision.
 */
export function mergePolicy(old: HostPolicy | null | undefined, fresh: HostPolicy | null): HostPolicy | null {
  if (fresh === null || !old || old.origin !== fresh.origin) return fresh
  const lists = BigInt(old.revision) > BigInt(fresh.revision) ? old : fresh
  const declared = BigInt(old.declarations ?? 0) > BigInt(fresh.declarations ?? 0) ? old : fresh
  if (lists === fresh && declared === fresh) return fresh
  return { ...fresh, revision: lists.revision, curated: lists.curated, blocked: lists.blocked, bots: lists.bots,
    declarations: declared.declarations, declared_bots: declared.declared_bots }
}
export function adoptPolicy(policy: HostPolicy | null): void {
  if (!host.status) return
  host.status.host_policy = mergePolicy(host.status.host_policy, policy === null ? null : checked(policy))
}
export async function readHostPolicy(): Promise<HostPolicy | null> {
  const result = await requestPath<HostPolicy | null>('/api/host-policy')
  adoptPolicy(result)
  return host.status?.host_policy ?? result
}

/** Refreshes policy only; it never reloads a stream or replaces its snapshot. */
export function watchHostPolicy(): () => void {
  let active = true, reading = false
  const ask = async () => {
    if (!active || reading || document.visibilityState !== 'visible' || !host.status?.host_policy) return
    reading = true
    try { const policy = await requestPath<HostPolicy | null>('/api/host-policy'); if (active) adoptPolicy(policy) }
    catch { /* Keep the last known policy. Writes still check at the host. */ }
    finally { reading = false }
  }
  const timer = setInterval(() => void ask(), 30_000)
  window.addEventListener('focus', ask)
  document.addEventListener('visibilitychange', ask)
  return () => { active = false; clearInterval(timer); window.removeEventListener('focus', ask); document.removeEventListener('visibilitychange', ask) }
}

/** The host admin's wallet, ready to sign for the admin chain: list edits and takedowns both use it. */
async function adminSigner(wallet: ActionWallet) {
  const pressed = captureWallet(wallet)
  if (!pressed) throw new Error('connect the host admin wallet')
  const policy = await readHostPolicy()
  if (!policy || pressed.account.toLowerCase() !== policy.admin.toLowerCase()) throw new Error('only the host admin can make this change')
  const chain = host.chain(policy.admin_chain)
  if (!chain) throw new Error('the host admin chain is unavailable')
  // A signature needs no wallet RPC; the chain is only what it is signed for.
  await wallet.ensureChain(chain, 'optional')
  if (!pressed.current()) throw new Error('the wallet account changed. try again')
  const sign = async (message: string) => {
    const signature = await guarded(pressed.provider, pressed.account).request({ method: 'personal_sign', params: [stringToHex(message), pressed.account] })
    if (!pressed.current()) throw new Error('the wallet account changed. try again')
    return signature
  }
  return { policy, sign }
}

export async function saveHostList(wallet: ActionWallet, list: HostList, action: ListEdit['action'], addresses: Address[]): Promise<void> {
  const { policy, sign } = await adminSigner(wallet)
  const edit: ListEdit = { revision: policy.revision, expires: Math.floor(Date.now() / 1000) + 300, list, action, addresses }
  const signature = await sign(policyMessage(policy.origin, edit))
  adoptPolicy(await requestPath<HostPolicy>('/api/host-policy', { ...edit, signature }))
}

/**
 * The time each account last signed in this tab. The host keeps only a
 * statement newer than the last, so two within one second count up.
 */
const lastIssued = new Map<string, number>()

/** The connected account's own statement that it is, or is no longer, a bot. No gas, no transaction. */
export async function declareBot(wallet: ActionWallet, bot: boolean): Promise<void> {
  const pressed = captureWallet(wallet)
  if (!pressed) throw new Error('connect your wallet')
  const policy = await readHostPolicy()
  if (!policy) throw new Error('this host keeps no bot labels')
  // Contract accounts are checked on the admin chain, so they sign for it;
  // a signature needs no wallet RPC.
  const chain = host.chain(policy.admin_chain)
  if (!chain) throw new Error('the host admin chain is unavailable')
  await wallet.ensureChain(chain, 'optional')
  if (!pressed.current()) throw new Error('the wallet account changed. try again')
  const account = pressed.account.toLowerCase()
  const issued = Math.max(Math.floor(Date.now() / 1000), (lastIssued.get(account) ?? 0) + 1)
  lastIssued.set(account, issued)
  const signature = await guarded(pressed.provider, pressed.account).request({ method: 'personal_sign', params: [stringToHex(declarationMessage(policy.origin, pressed.account, bot, issued)), pressed.account] })
  if (!pressed.current()) throw new Error('the wallet account changed. try again')
  adoptPolicy(await requestPath<HostPolicy>('/api/bot-declaration', { account: pressed.account, bot, issued, signature }))
}

/** The admin's private list of content hashes this host neither serves nor accepts. */
export type Takedowns = { revision: string; hashes: Hex[] }
export type TakedownEdit = { revision: string; expires: number; action: 'add' | 'remove'; hashes: Hex[] }

export function takedownMessage(origin: string, edit: TakedownEdit): string {
  return `Host takedown update\nHost: ${origin}\nRevision: ${edit.revision}\nExpires: ${edit.expires}\nAction: ${edit.action}\nHashes:\n${edit.hashes.map(h => h.toLowerCase()).join('\n')}`
}
export function takedownViewMessage(origin: string, expires: number): string {
  return `Host takedown list\nHost: ${origin}\nExpires: ${expires}`
}
function checkedTakedowns(list: Takedowns): Takedowns {
  integer(list.revision)
  if (!Array.isArray(list.hashes) || list.hashes.length > 4096 || !list.hashes.every(h => typeof h === 'string' && isHex(h) && h.length === 66)) throw new Error('invalid takedown list')
  return list
}


/** The takedown list, which the host shows only to its admin's signature. */
export async function readTakedowns(wallet: ActionWallet): Promise<Takedowns> {
  const { policy, sign } = await adminSigner(wallet)
  const expires = Math.floor(Date.now() / 1000) + 300
  const signature = await sign(takedownViewMessage(policy.origin, expires))
  return checkedTakedowns(await requestPath<Takedowns>('/api/host-policy/takedowns/read', { expires, signature }))
}

/** Take content down by hash, or restore it, as of the list's `revision`. */
export async function saveTakedowns(wallet: ActionWallet, revision: string, action: TakedownEdit['action'], hashes: Hex[]): Promise<Takedowns> {
  const { policy, sign } = await adminSigner(wallet)
  const edit: TakedownEdit = { revision, expires: Math.floor(Date.now() / 1000) + 300, action, hashes }
  const signature = await sign(takedownMessage(policy.origin, edit))
  return checkedTakedowns(await requestPath<Takedowns>('/api/host-policy/takedowns', { ...edit, signature }))
}

export async function allowHostPosting(account: Address): Promise<void> {
  if (!host.status?.host_policy) return
  await readHostPolicy()
  if (host.blocked(account)) throw new Error('posting blocked by host')
}

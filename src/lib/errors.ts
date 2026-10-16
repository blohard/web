// Reader-facing errors from the host, relayer, wallet and Board.
import { decodeErrorResult } from 'viem'
import { boardAbi } from './abi/board'
import { ApiError } from './api'

/** Keep the provider's diagnosis rather than viem's synthetic unknown code. */
function rpcErrorInfo(error: unknown): { code?: number; message?: string } {
  let code: number | undefined, message: string | undefined
  for (let cause: unknown = error, i = 0; cause && typeof cause === 'object' && i < 8; i++) {
    const e = cause as { name?: string; code?: number; message?: string; shortMessage?: string; cause?: unknown }
    if (code === undefined && typeof e.code === 'number' && Number.isSafeInteger(e.code) &&
      !(e.name === 'UnknownRpcError' && e.code === -1)) code = e.code
    // Wrapped messages contain request dumps. Only show the underlying message,
    // with URLs removed so an RPC credential cannot end up in a screenshot.
    if (!e.shortMessage && typeof e.message === 'string') {
      message = e.message.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, '[RPC URL]')
        .split(/[\r\n]/, 1)[0].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240)
    }
    cause = e.cause
  }
  return { code, message }
}

function rpcDiagnostic(error: unknown, summary = ''): string {
  const { code, message } = rpcErrorInfo(error)
  const details = [code === undefined ? '' : `RPC code ${code}`,
    message && !summary.includes(message) ? message : ''].filter(Boolean)
  return details.length ? ` · ${details.join(' · ')}` : ''
}

/** Preserve the failed connect step and original provider error for diagnosis. */
export class WalletConnectionError extends Error {
  constructor(step: 'account access' | 'network check', cause: unknown) {
    const { code } = rpcErrorInfo(cause)
    const reason = code === 4100
      ? 'the wallet refused permission. open its site permissions and reconnect this site (RPC code 4100)'
      : explain(cause)
    super(`${step} failed: ${reason}`, { cause })
  }
}

/** A short, human explanation for a failed contract call or wallet action. */
export function explain(e: unknown): string {
  if (e instanceof WalletConnectionError) return e.message
  const err = e as { shortMessage?: string; message?: string; code?: number; cause?: unknown }
  for (let cause: unknown = e, i = 0; cause && i < 8; i++) {
    const nested = cause as { message?: string; cause?: unknown }
    if (/wallet.*timed out/i.test(nested.message ?? '')) return 'your wallet did not answer in time. open it and try again'
    cause = nested.cause
  }
  const { code } = rpcErrorInfo(e)
  if (code === 4001) return 'you rejected the request in your wallet'
  if (code === -32002) {
    return 'your wallet already has a request waiting. open it and approve or dismiss that first, then try again'
  }
  if (code === 4100) return 'the wallet has not authorized this site. connect it first'
  if (code === 4900 || code === 4901) return 'the wallet is disconnected from the chain. check its network'
  if (e instanceof ApiError && e.revert) {
    try {
      const decoded = decodeErrorResult({ abi: boardAbi, data: e.revert })
      return boardError(decoded.errorName, [...(decoded.args ?? [])])
    } catch { /* Unknown revert data keeps the host's bounded error text. */ }
  }
  const text = err.message ?? ''
  if (/insufficient funds|exceeds the balance/i.test(text)) {
    return 'this account does not have enough funds to pay for gas on this network. add its native token, or use sponsored posting if available'
  }
  if (/HTTP request failed|Failed to fetch|Load failed|took too long|timed out/i.test(text)) {
    return 'could not reach the chain or the host. check your connection and try again'
  }
  // viem nests the revert reason; say what the board's custom error means.
  let cause: unknown = err
  for (let i = 0; i < 6 && cause; i++) {
    const c = cause as { data?: { errorName?: string; args?: unknown[] }; cause?: unknown }
    if (c.data?.errorName) return boardError(c.data.errorName, c.data.args ?? [])
    cause = c.cause
  }
  const message = err.shortMessage ?? err.message ?? String(e)
  return message === 'An unknown RPC error occurred.'
    ? `could not complete the wallet RPC request. try again${rpcDiagnostic(e)}`
    : code === undefined ? message : `${message}${rpcDiagnostic(e, message)}`
}

/** The board's revert reasons (IBoard.sol) as sentences; anything else by name. */
function boardError(name: string, args: unknown[]): string {
  switch (name) {
    case 'ParentNotFound':
      return `there is no post #${args[0]} on this chain to reply to`
    case 'ParentRetracted':
      return 'that post was retracted, so replies are closed'
    case 'ParentRemoved':
      return 'that reply was removed by the author of the post it answered, so replies are closed'
    case 'GateRejected':
      return "the parent's reply rule refused your reply"
    case 'NonceAlreadyUsed':
      return 'this signature’s nonce was already used or invalidated'
    case 'SignatureExpired':
      return 'the signature expired before it was submitted. try again'
    case 'InvalidSigner':
      return 'the signature does not match the author'
    case 'MessageNotFound':
      return `there is no post #${args[0]} on this chain`
    case 'MessageTombstoned':
      return 'that post was already deleted or removed'
    case 'NotAuthor':
      return 'only the author can do that'
    case 'ProtectedResponse':
      return 'you cannot remove a response from the author of the post you replied to'
    case 'NotParentAuthor':
      return 'only the author of the post it answers can remove a reply'
    case 'InvalidGate':
      return 'that gate address is reserved'
    default:
      return `${name}(${args.map(String).join(', ')})`
  }
}


/** Trading ETH includes the payment as well as gas; posting sponsorship cannot cover it. */
export function explainKeyError(error: unknown): string {
  let cause: unknown = error
  for (let i = 0; i < 8 && cause; i++) {
    const e = cause as { message?: string; data?: { errorName?: string }; cause?: unknown }
    if (/insufficient funds|exceeds the balance/i.test(e.message ?? '')) {
      return 'not enough ETH for this transaction and the network fee. add ETH and try again'
    }
    const messages: Record<string, string> = {
      Slippage: 'the price moved beyond your limit. refresh the quote and try again',
      InsufficientKeys: 'you no longer hold enough keys. refresh your balance',
      InsufficientPayment: 'the payment is too small. refresh the quote and try again',
      Expired: 'the transaction deadline passed. try again',
      AlreadyActive: 'account keys are already active. refresh this page',
      InactiveMarket: 'this account has not activated keys',
      InvalidAmount: 'choose a valid number of whole keys',
      SupplyLimit: 'this purchase would exceed the market’s key limit',
      InvalidRecipient: 'choose another wallet as the recipient',
      ZeroAddress: 'enter a valid wallet address',
      PaymentFailed: 'the receiving wallet refused the ETH payment',
    }
    if (e.data?.errorName && messages[e.data.errorName]) return messages[e.data.errorName]
    cause = e.cause
  }
  const message = explain(error)
  // The batch helper's name gives readers no useful recovery instruction.
  return message.startsWith('An unknown error occurred while executing the contract function "aggregate3".')
    ? `could not read account keys. refresh the page to try again${rpcDiagnostic(error)}`
    : message
}

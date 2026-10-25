// Shared wallet connection and request state, reactive through Svelte runes.
import { getAddress, numberToHex, type Address } from 'viem'
import { chainLabel, publicRpcUrl, toViemChain } from './chains'
import { isMobile } from './device'
import { loadMobileWallet, mobileWallet } from './mobile-wallet'
import { browserWallet, type BrowserWallet } from './browser-wallet'
import { WalletConnectionError } from './errors'
import type { RemoteWallet, RemoteWalletKind, WalletChoice, WalletFactories } from './remote-wallet'
import { sameAddress } from './format'
import { withTimeout } from '../shared/with-timeout'
import { readJSON, writeJSON } from './storage'
import type { ChainInfo, Eip1193Provider } from './types'

/** Set when the user pressed disconnect, so a reload does not quietly reconnect. */
const DISCONNECTED_KEY = 'blohard.wallet.disconnected'
const CONNECTED_KEY = 'blohard.wallet.connected'
const REMOTE_KEY = 'blohard.wallet.remote'
const BROWSER_KEY = 'blohard.wallet.browser'

/**
 * What a wallet interaction needs from the wallet's own RPC for the chain.
 * A transaction the wallet sends itself needs a working RPC; a signature the
 * host's relayer sends needs none, and a smart-account wallet may not answer
 * reads for a chain it does not know while it signs for it without trouble.
 */
type RpcNeed = 'required' | 'optional'

/**
 * How the wallet's RPC answered a probe: it works; it is broken (a timeout
 * or a transport failure, typically a stale URL saved in the wallet); or the
 * wallet does not serve reads at all, which says nothing about sending.
 */
type Probe = 'ok' | 'broken' | 'unsupported'

/** The wallet will not serve this method (4200, -32601), or not to this site (4100): not a broken wallet. */
export const unserved = (code: number | undefined): boolean => code === 4100 || code === 4200 || code === -32601

export class Wallet {
  /**
   * The connected SDK provider, or an injected browser wallet. A wallet's
   * in-app browser (MetaMask's on a phone) may inject it only after the page
   * has started, so it can arrive late; see `awaitLateProvider`.
   */
  provider = $state.raw<Eip1193Provider | undefined>()

  /** Last wallet-confirmed account for browsing in this tab; signing checks live access. */
  account = $state<Address | null>(null)
  /** The connected account is `address`: false without a wallet or an address. */
  is(address: string | null | undefined): boolean {
    return this.account !== null && !!address && sameAddress(this.account, address)
  }
  /** Layout hint only. No account is restored until the wallet answers. */
  restoring = $state(false)
  chainId = $state<number | null>(null)
  /** True while a wallet prompt (connect, switch, add chain) is outstanding. */
  busy = $state(false)
  /** Whether the wallet's RPC for its current chain answered the last probe (null = not probed, or the wallet serves no reads). */
  rpcHealthy = $state<boolean | null>(null)
  /** What the wallet answered when its RPC was found broken, for the reader and for a bug report. */
  rpcProblem = $state<string | null>(null)
  /** How long a probe waits for the wallet's RPC. Short in tests. */
  probeTimeoutMs = 6000
  /**
   * Signed out on the site's side. Kept here so it holds without browser
   * storage, and in storage so it holds across reloads.
   */
  private disconnected = readJSON<boolean>(DISCONNECTED_KEY, false)
  /**
   * Bumped by every change the wallet announces and every action the page
   * takes, so a silent re-read that finishes after a newer change is dropped
   * rather than applied over it.
   */
  private generation = 0
  /** The bounded wait is shared until the provider's actual reads finish. */
  private syncing = new WeakMap<Eip1193Provider, Promise<boolean>>()
  private remote: RemoteWallet | undefined
  private remoteKind: RemoteWalletKind | undefined
  private loadingRemote = new Map<RemoteWalletKind, Promise<RemoteWallet>>()
  private watched = new WeakSet<Eip1193Provider>()
  private injected: Eip1193Provider | undefined
  private browsers = $state.raw<BrowserWallet[]>([])
  private browserChoice: WalletChoice | undefined
  /** Account events during connect must not hide an error from its network check. */
  private connecting = false

  /** This page uses no wallet: nothing injected is read, nothing is restored or discovered. */
  private silent: boolean
  constructor(
    /** The injected provider; `null` for a page that uses no wallet, such as an embedded discussion. */
    provider: Eip1193Provider | undefined | null = typeof window !== 'undefined' ? window.ethereum : undefined,
    private restoreTimeoutMs = 6000,
    /** How long to wait for a wallet injected after the page started. */
    lateProviderMs = 3000,
    /** SDKs load only after a choice, or to restore that chosen wallet. */
    private factories: WalletFactories = {},
    /** What each remote choice is called; the host's connector names itself. */
    private names: Partial<Record<RemoteWalletKind, string>> = {},
  ) {
    // A change made inside the extension does not always reach the page as
    // an event: a wallet may not announce an account it connected from its
    // own connected-sites screen, and with several wallets installed one
    // wallet's shim can swallow another's events. So the page asks again
    // whenever the reader comes back to it, which is when they have just
    // been in the wallet.
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => void this.resync())
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.resync()
      })
    }
    this.silent = provider === null
    this.injected = provider ?? undefined
    const saved = readJSON<RemoteWalletKind | null>(REMOTE_KEY, null)
    const savedBrowser = readJSON<string | null>(BROWSER_KEY, null)
    if (this.silent) {
      // Nothing to restore, wait for or listen to.
    } else if ((saved === 'mobile' || saved === 'coinbase') && factories[saved] && !this.disconnected) {
      this.restoring = true
      const seen = this.generation
      void this.loadRemote(saved).then(remote => {
        if (seen !== this.generation || this.busy) return
        this.remote = remote
        this.remoteKind = saved
        return this.adopt(remote.provider)
      }).catch(() => {}).finally(() => { this.restoring = false })
    } else if (savedBrowser) {
      // A missing remembered wallet must not silently become a different wallet.
      this.restoring = !this.disconnected && readJSON<unknown>(CONNECTED_KEY, false) === true
    } else if (provider) {
      this.adopt(provider)
    } else if (typeof window !== 'undefined') {
      void this.awaitLateProvider(lateProviderMs)
    }
    if (typeof window !== 'undefined' && !this.silent) this.discover(saved ? null : savedBrowser, lateProviderMs)
  }

  /** The injected provider, chosen or found on the page; a silent page has none. */
  private injectedProvider(): Eip1193Provider | undefined {
    if (this.silent) return undefined
    return this.injected ?? (typeof window !== 'undefined' ? window.ethereum : undefined)
  }

  /** One listener for this page-lifetime controller; announcements never prompt a wallet. */
  private discover(saved: string | null, waitMs: number): void {
    const seen = this.generation
    let restore = !!saved && !this.disconnected
    const timer = restore ? setTimeout(() => {
      restore = false
      if (this.generation === seen) this.restoring = false
    }, waitMs) : undefined
    window.addEventListener('eip6963:announceProvider', event => {
      const found = browserWallet((event as CustomEvent).detail)
      if (!found || this.browsers.length >= 32 ||
          this.browsers.some(b => b.id === found.id || b.provider === found.provider)) return
      this.browsers = [...this.browsers, found]
      // Collect synchronous announcements before restoring. RDNS is only a
      // preference, not proof of identity; an ambiguous preference needs a choice.
      if (restore) queueMicrotask(() => {
        if (!restore || this.generation !== seen || this.busy || this.disconnected) return
        const matches = this.browsers.filter(b => b.rdns === saved)
        if (matches.length !== 1) return
        restore = false
        clearTimeout(timer)
        this.browserChoice = matches[0].id
        void this.adopt(matches[0].provider)
      })
    })
    window.dispatchEvent(new Event('eip6963:requestProvider'))
  }

  /** Take the wallet's provider, listen to it, and read the account once without prompting. */
  private adopt(p: Eip1193Provider): Promise<boolean> {
    if (this.provider === p) return this.resync()
    this.generation++
    this.provider = p
    this.account = null
    this.chainId = null
    this.rpcHealthy = null
    this.rpcProblem = null
    if (!this.watched.has(p)) {
      this.watched.add(p)
      p.on('accountsChanged', (accounts) => {
        if (this.provider !== p) return
        const list = accounts as string[]
        this.generation++
        if (!this.disconnected && !this.connecting && list.length) this.setAccount(getAddress(list[0]))
      })
      p.on('chainChanged', (id) => {
        if (this.provider !== p) return
        this.generation++
        this.chainId = Number(id as string)
        this.rpcHealthy = null
      })
    }
    this.restoring = !this.disconnected && readJSON<unknown>(CONNECTED_KEY, false) === true
    const timer = this.restoring ? setTimeout(() => { this.restoring = false }, this.restoreTimeoutMs) : undefined
    const read = this.resync().finally(() => { clearTimeout(timer); this.restoring = false })
    let limit: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      read,
      new Promise<boolean>((resolve) => { limit = setTimeout(() => resolve(false), this.restoreTimeoutMs) }),
    ]).finally(() => clearTimeout(limit))
  }

  /**
   * MetaMask announces a provider it injects late with `ethereum#initialized`;
   * other wallets just set `window.ethereum`. Either is adopted if it appears
   * within `ms`; otherwise the page has no wallet.
   */
  private awaitLateProvider(ms: number): Promise<boolean> {
    // A reader who was connected is shown "connecting" while the wallet appears.
    this.restoring = !this.disconnected && readJSON<unknown>(CONNECTED_KEY, false) === true
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (p: Eip1193Provider | undefined) => {
        if (done) return
        done = true
        clearInterval(poll)
        clearTimeout(timer)
        window.removeEventListener('ethereum#initialized', found)
        if (this.provider) resolve(true)
        else if (p && !this.busy) {
          this.injected = p
          void this.adopt(p).then(resolve)
        }
        else {
          this.restoring = false
          resolve(true)
        }
      }
      const found = () => finish(window.ethereum)
      window.addEventListener('ethereum#initialized', found, { once: true })
      const poll = setInterval(() => { if (window.ethereum) found() }, 100)
      const timer = setTimeout(() => finish(window.ethereum), ms)
    })
  }

  private arrivals = new Set<() => void>()
  /** Told whenever an account arrives where there was none: a connect, or a wallet found already connected. */
  onConnected(listener: () => void): () => void {
    this.arrivals.add(listener)
    return () => { this.arrivals.delete(listener) }
  }

  private setAccount(account: Address | null): void {
    const arrived = account !== null && this.account === null
    this.account = account
    this.restoring = false
    writeJSON(CONNECTED_KEY, account !== null)
    if (arrived) for (const listener of this.arrivals) listener()
  }

  get choices(): WalletChoice[] {
    if (this.silent) return []
    const browser = this.injectedProvider()
    return [...this.browsers.map(b => b.id),
      ...(browser && !this.browsers.some(b => b.provider === browser) ? ['browser' as const] : []),
      ...(['mobile', 'coinbase'] as const).filter(kind => this.factories[kind])]
  }

  choiceName(choice: WalletChoice): string {
    if (choice === 'browser') return 'browser wallet'
    if (choice === 'mobile') return this.names.mobile ?? 'wallet app'
    if (choice === 'coinbase') return this.names.coinbase ?? 'Coinbase Wallet · passkey'
    return `${this.browsers.find(b => b.id === choice)?.name ?? 'unavailable wallet'} · browser wallet`
  }

  get canConnect(): boolean {
    return this.provider !== undefined || this.choices.length > 0
  }

  /** Keep initialization shared after a timeout, but never adopt a late answer. */
  private loadRemote(kind: RemoteWalletKind): Promise<RemoteWallet> {
    let loading = this.loadingRemote.get(kind)
    if (!loading) {
      const factory = this.factories[kind]
      if (!factory) return Promise.reject(new Error('this wallet is not available here'))
      loading = Promise.resolve().then(factory).catch(error => {
        this.loadingRemote.delete(kind)
        throw error
      })
      this.loadingRemote.set(kind, loading)
    }
    return withTimeout(loading, this.restoreTimeoutMs, () => new Error('could not load the wallet. try again'))
  }

  private async select(choice: WalletChoice): Promise<void> {
    if (choice !== 'mobile' && choice !== 'coinbase') {
      const found = this.browsers.find(b => b.id === choice)
      const provider = choice === 'browser' ? this.injectedProvider() : found?.provider
      if (!provider) throw new Error('no browser wallet found')
      if (choice === 'browser') this.injected = provider
      this.browserChoice = choice
      writeJSON(BROWSER_KEY, found?.rdns ?? null)
      this.remote = undefined
      this.remoteKind = undefined
      writeJSON(REMOTE_KEY, null)
      await this.adopt(provider)
    } else {
      const remote = await this.loadRemote(choice)
      this.remote = remote
      this.remoteKind = choice
      this.browserChoice = undefined
      writeJSON(BROWSER_KEY, null)
      writeJSON(REMOTE_KEY, choice)
      await this.adopt(remote.provider)
    }
  }

  /**
   * Re-read the current account and chain without prompting; stays signed out
   * after a disconnect. Skipped while a prompt is open, so it never races one.
   * False means the wait expired; the provider may still answer later.
   */
  async resync(): Promise<boolean> {
    const p = this.provider
    // After a disconnect the account is already null, and stays so until connect.
    if (!p || this.busy || this.disconnected) return true
    const existing = this.syncing.get(p)
    if (existing) return existing
    // Provider requests cannot be cancelled. Keep the flight after our wait
    // expires, including when only one of the two reads has answered. Wallet
    // events and explicit prompts remain independent of this silent check.
    const read = this.readCurrent(p).finally(() => { this.syncing.delete(p) })
    const wait = withTimeout(read, this.probeTimeoutMs, () => new Error('wallet check timed out')).then(() => true, () => false)
    this.syncing.set(p, wait)
    return wait
  }

  private async readCurrent(p: Eip1193Provider): Promise<void> {
    const seen = ++this.generation
    try {
      // Neither answer depends on the other, so the wallet is asked both at once.
      const request = async (method: string) => p.request({ method })
      const [accountRead, chainRead] = await Promise.allSettled([
        request('eth_accounts'), request('eth_chainId'),
      ])
      if (accountRead.status === 'rejected' || chainRead.status === 'rejected') return
      const accounts = accountRead.value as string[]
      const chain = chainRead.value as string
      const chainId = Number(chain)
      // A restoring SDK session can briefly have neither an account nor a chain.
      if (!Number.isSafeInteger(chainId) || chainId <= 0) return
      // Something newer arrived while the wallet was answering: the answer is
      // out of date, and what arrived is the truth.
      if (seen !== this.generation || this.busy || p !== this.provider) return
      // Empty accounts can mean a locked wallet or revoked access. Keep the
      // browsing identity; only an explicit disconnect forgets it in this tab.
      if (accounts.length) this.setAccount(getAddress(accounts[0]))
      if (chainId !== this.chainId) {
        this.chainId = chainId
        this.rpcHealthy = null
      }
    } catch {
      // A wallet that will not answer right now keeps what the page has.
    }
  }

  private signOut(value: boolean): void {
    this.disconnected = value
    writeJSON(DISCONNECTED_KEY, value)
  }

  /**
   * Sign out: ask the wallet to forget this site's permission (wallets that
   * support revoking do; the rest just ignore it), and remember the choice so
   * the next load does not reconnect on its own.
   */
  async disconnect(): Promise<void> {
    const p = this.provider
    if (!p || this.busy) return
    this.busy = true
    this.generation++
    this.signOut(true)
    this.setAccount(null)
    this.rpcHealthy = null
    try {
      await withTimeout(this.remote ? this.remote.disconnect()
        : p.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }),
      this.connectTimeoutMs, () => new Error('wallet disconnect timed out'))
    } catch {
      // An unavailable wallet cannot undo the local sign-out.
    } finally {
      this.busy = false
    }
  }

  /**
   * The wallet's chain, read silently while a prompt holds the wallet. A read
   * that never answers gives the button back rather than leaving it waiting.
   */
  private async readChain(p: Eip1193Provider): Promise<number> {
    const id = await withTimeout(p.request({ method: 'eth_chainId' }), this.probeTimeoutMs,
      () => new Error('the wallet did not answer. try again'))
    return Number(id as string)
  }

  /**
   * Run one wallet interaction at a time. MetaMask answers a second request
   * made while a prompt is still open with -32002 ("Requested resource not
   * available"), so overlapping calls are refused here with a clear message.
   */
  private async prompt<T>(work: (p: Eip1193Provider) => Promise<T>, choice?: WalletChoice): Promise<T> {
    if (this.busy) throw new Error('your wallet is still waiting on a previous request. finish or dismiss it in the wallet, then try again')
    this.busy = true
    this.generation++
    try {
      if (choice) await this.select(choice)
      const p = this.provider
      if (!p) throw new Error('no browser wallet found')
      return await work(p)
    } finally {
      // Whatever the prompt changed is newer than any silent read still out.
      this.generation++
      this.busy = false
    }
  }

  /** How long a connect prompt may go unanswered before the button is offered again. */
  connectTimeoutMs = 120_000

  /** Connecting is the sign-in: there is no server session to create. */
  async connect(chain?: ChainInfo, choice: WalletChoice | undefined = this.remoteKind ?? this.browserChoice ?? this.choices[0]): Promise<void> {
    await this.prompt(async (p) => {
      this.connecting = true
      try {
        // A wallet that never answers (one just back from the background, say)
        // must not leave the connect button waiting forever. An approval that
        // comes later still arrives as accountsChanged.
        let accounts: string[]
        try {
          accounts = (await withTimeout(this.remote ? this.remote.connect(chain)
            : p.request({ method: 'eth_requestAccounts' }), this.connectTimeoutMs,
            () => new Error('the wallet did not answer. try connecting again'))) as string[]
        } catch (error) { throw new WalletConnectionError('account access', error) }
        const account = accounts.length ? getAddress(accounts[0]) : null
        let chainId: number
        try { chainId = await this.readChain(p) }
        catch (error) { throw new WalletConnectionError('network check', error) }
        if (!account) throw new Error('the wallet did not connect an account')
        this.signOut(false)
        this.setAccount(account)
        this.chainId = chainId
      } finally { this.connecting = false }
    }, choice)
  }

  /**
   * Does the wallet's RPC for its current chain answer? Wallets keep their own
   * RPC URL per chain; a stale one (say, from an earlier test setup) makes
   * every request hang or fail even though the chain itself is fine. The
   * answer is kept for the UI: only a broken RPC is a warning, with what the
   * wallet said.
   */
  private async probe(p: Eip1193Provider): Promise<Probe> {
    let result: Probe = 'broken', problem: string | null = null
    try {
      const r = await withTimeout(p.request({ method: 'eth_blockNumber' }), this.probeTimeoutMs,
        () => new Error(`no answer within ${this.probeTimeoutMs / 1000} seconds`))
      if (typeof r === 'string') result = 'ok'
      else problem = `the wallet answered ${JSON.stringify(r)} instead of a block number`
    } catch (e) {
      // A wallet that serves no reads to this site is not thereby unable to send.
      const { code, message } = e as { code?: number; message?: string }
      if (unserved(code)) result = 'unsupported'
      else {
        problem = `the wallet said ${code === undefined ? '' : `${code} `}${(message ?? String(e)).slice(0, 160)}`
        console.warn('wallet RPC probe failed', { code, message })
      }
    }
    this.rpcHealthy = result === 'ok' ? true : result === 'broken' ? false : null
    this.rpcProblem = problem
    return result
  }

  /** Probe without prompting; used to surface a warning in the UI. */
  async checkRpc(): Promise<void> {
    const p = this.provider
    if (!p || this.busy) return
    await this.probe(p)
  }

  /**
   * Ask the wallet to register the host's URL for `chain`. For a chain the
   * wallet already knows, MetaMask shows this as an "update network" prompt.
   */
  private async offerRpc(p: Eip1193Provider, chain: ChainInfo): Promise<void> {
    const def = toViemChain(chain)
    await this.answered(p, {
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: numberToHex(chain.id),
          chainName: def.name,
          nativeCurrency: def.nativeCurrency,
          rpcUrls: [publicRpcUrl(chain)],
        },
      ],
    })
  }

  /**
   * A network prompt, given up after the connect prompt's wait: one the wallet
   * lost must not hold every later wallet action. Giving up ends the action;
   * a later approval still arrives as chainChanged.
   */
  private answered(p: Eip1193Provider, request: Parameters<Eip1193Provider['request']>[0]): Promise<unknown> {
    return withTimeout(p.request(request), this.connectTimeoutMs,
      () => new Error('the wallet did not answer. open it, finish or dismiss its request, and try again'))
  }

  /**
   * Put the wallet on `chain`: switch, adding the chain if the wallet lacks
   * it. When the wallet itself will send the transaction (`rpc` required),
   * also make sure the wallet's RPC for the chain answers, offering the
   * host's URL if not. A signature the relayer sends needs no wallet RPC, so
   * a wallet that cannot read this chain still signs for it.
   */
  async ensureChain(chain: ChainInfo, rpc: RpcNeed = 'required'): Promise<void> {
    const expected = this.account
    await this.prompt(async (p) => {
      // A remembered browsing account is not signing permission. Only a
      // reader's action may prompt to unlock or restore wallet access.
      if (expected) {
        const seen = this.generation
        let accounts = await withTimeout(p.request({ method: 'eth_accounts' }), this.probeTimeoutMs,
          () => new Error('the wallet account check timed out. try again')) as string[]
        if (!Array.isArray(accounts)) throw new Error('the wallet returned an invalid account list')
        if (!accounts.length) accounts = await this.answered(p, { method: 'eth_requestAccounts' }) as string[]
        const active = Array.isArray(accounts) && accounts.length ? getAddress(accounts[0]) : null
        if (!active) throw new Error('the wallet reports no connected account. unlock it and try again')
        if (seen === this.generation) this.setAccount(active)
        if (!sameAddress(active, expected) || this.account !== expected) {
          throw new Error('the wallet is set to a different account. check the selected account and try again')
        }
      }
      if (this.chainId !== chain.id) {
        try {
          await this.answered(p, { method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(chain.id) }] })
        } catch (e) {
          // 4902: the wallet does not know this chain yet.
          if ((e as { code?: number }).code !== 4902) throw e
          if (!publicRpcUrl(chain)) {
            throw new Error(
              `your wallet does not know ${chainLabel(chain)} and this host published no RPC URL to add it with`,
            )
          }
          await this.offerRpc(p, chain)
          // Adding a chain need not switch to it (EIP-3085 leaves that to the
          // wallet, and some wallets stay put): ask for the switch if it did not.
          if (await this.readChain(p) !== chain.id) {
            await this.answered(p, { method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(chain.id) }] })
          }
        }
        this.chainId = await this.readChain(p)
        if (this.chainId !== chain.id) throw new Error(`your wallet did not switch to ${chainLabel(chain)}`)
      }

      if (rpc === 'optional') return

      // On the right chain, and about to send from the wallet: is its RPC for
      // the chain alive? A wallet that serves no reads is not thereby broken.
      const first = await this.probe(p)
      if (first !== 'broken') return
      const url = publicRpcUrl(chain)
      if (!url) {
        throw new Error(
          `your wallet's RPC for ${chainLabel(chain)} is not responding, and this host published no URL to offer instead. fix the network's RPC URL in your wallet`,
        )
      }
      // Offer the host's URL. A wallet that will not update a chain it already
      // has, whether it asked the user or refused on its own, leaves the same
      // remedy, so every failure falls through to the hint.
      try {
        await this.offerRpc(p, chain)
      } catch {
        // fall through
      }
      const second = await this.probe(p)
      if (second !== 'broken') return
      throw new Error(
        `your wallet's RPC for ${chainLabel(chain)} still does not respond (${this.rpcProblem ?? 'no answer'}). in the wallet's network settings, set its RPC URL to ${url}. sponsored posts need no wallet RPC and still work`,
      )
    })
  }
}

// An embedded discussion asks no wallet anything: it offers no choice and
// never reads a provider injected into the page it sits in. Full pages offer
// the browser's wallets, a passkey wallet and, on a phone, the wallet app
// connector this host serves, loading either of the last two only when chosen.
const embedded = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-embed')
const standalone = typeof window !== 'undefined' && !embedded && window.top === window.self
/** The host's wallet app connector, offered on phones on full pages. */
export const mobileConnector = standalone && isMobile() ? mobileWallet() : null
export const wallet = new Wallet(standalone ? undefined : null, 6000, 3000, standalone ? {
  ...(mobileConnector ? { mobile: () => loadMobileWallet(mobileConnector) } : {}),
  coinbase: async () => (await import('./coinbase')).passkeyWallet(),
} : {}, mobileConnector ? { mobile: mobileConnector.name } : {})

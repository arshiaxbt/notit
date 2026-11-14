/**
 * Everything Testnet mode needs to know about "who is playing": which
 * contract is selected, which account is signed in (a guest key or a wallet),
 * how far a guest sign-up has got, and whether the contract is locked.
 *
 * A small observable store, so React reads it with useSyncExternalStore and
 * the logic stays testable without a DOM. Nothing here touches the network
 * until `start()` is called, which the app does only when Testnet mode is
 * actually shown.
 */
import { forgetGuest, guestChain, isLockedTo, loadChainProvider, loadGuest, saveGuest } from './chain';
import type { GuestChain, GuestCredentials } from './chain';
import type { ChainConfig, Deployment } from './config';
import { describeError } from './errors';
import { NearClient } from './NearClient';
import type { ChainProvider, ChainSigner } from './NearClient';
import { connectWallet, disconnectWallet, restoreWallet } from './wallet';

export type GuestStep = 'account' | 'confirm' | 'claim' | 'lock';

export interface GuestProgress {
  status: 'idle' | 'running' | 'done' | 'error';
  /** The step in progress, or the one that failed. */
  step: GuestStep | null;
  error: string | null;
  /** Hash of the claim transaction, once known. */
  claimTx: string | null;
  /** Which deployment a claim step is for ("Fast", "Live"). */
  detail?: string | null;
  /** Position of the step and how many there are, for "3/5". */
  at?: number;
  of?: number;
  /** Hash of the transaction that swapped the keys, once known. */
  lockTx?: string | null;
}

export type LockState = { status: 'unknown' } | { status: 'locked' } | { status: 'open'; keys: number } | { status: 'error' };

export interface SessionState {
  deployment: Deployment;
  /** `key`: what the key in this browser may do; null for a wallet, which holds its own. */
  account: { id: string; kind: 'guest' | 'wallet'; key: 'full' | 'volunteer' | null } | null;
  /** True while a saved guest or wallet is being restored on load. */
  restoring: boolean;
  guest: GuestProgress;
  wallet: { busy: boolean; error: string | null };
  lock: LockState;
  /** Bumped whenever the signed-in account or its tokens may have changed. */
  version: number;
}

const SIGNER_KEY = 'notit-signer';

function remember(kind: 'guest' | 'wallet' | null): void {
  try {
    if (kind) localStorage.setItem(SIGNER_KEY, kind);
    else localStorage.removeItem(SIGNER_KEY);
  } catch {
    /* storage blocked: the choice just will not persist */
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(SIGNER_KEY);
  } catch {
    return null;
  }
}

const IDLE_GUEST: GuestProgress = { status: 'idle', step: null, error: null, claimTx: null };

export class ChainSession {
  readonly config: ChainConfig;
  private clients = new Map<string, NearClient>();
  private signer: ChainSigner | null = null;
  private listeners = new Set<() => void>();
  private state: SessionState;
  private started = false;

  private chain: GuestChain;
  private provider: () => Promise<ChainProvider>;

  /** `chain` and `provider` are seams for tests; the app uses the real ones. */
  constructor(config: ChainConfig, chain: GuestChain = guestChain, provider?: () => Promise<ChainProvider>) {
    this.config = config;
    this.chain = chain;
    this.provider = provider ?? (() => loadChainProvider(config.rpcUrls));
    this.state = {
      deployment: config.contracts[0]!,
      account: null,
      restoring: false,
      guest: IDLE_GUEST,
      wallet: { busy: false, error: null },
      lock: { status: 'unknown' },
      version: 0,
    };
  }

  // ---------- store ----------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): SessionState => this.state;

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ---------- clients ----------

  /** The client for the selected contract. One per contract, created on demand. */
  get client(): NearClient {
    return this.clientFor(this.state.deployment.id);
  }

  private clientFor(contractId: string): NearClient {
    let c = this.clients.get(contractId);
    if (!c) {
      c = new NearClient({
        contractId,
        provider: this.provider,
        pollMs: this.config.pollMs,
      });
      c.setSigner(this.signer);
      this.clients.set(contractId, c);
    }
    return c;
  }

  private setSigner(signer: ChainSigner | null): void {
    this.signer = signer;
    for (const c of this.clients.values()) c.setSigner(signer);
    remember(signer?.kind ?? null);
    this.set({
      account: signer ? { id: signer.accountId, kind: signer.kind, key: signer.kind === 'guest' ? (signer.key ?? 'full') : null } : null,
      version: this.state.version + 1,
    });
  }

  selectContract(contractId: string): void {
    const deployment = this.config.contracts.find((c) => c.id === contractId);
    if (!deployment || deployment.id === this.state.deployment.id) return;
    this.set({ deployment, lock: { status: 'unknown' }, guest: IDLE_GUEST });
    void this.refreshLock();
  }

  // ---------- start-up ----------

  /** Restores a saved guest or wallet and checks the lock. Safe to call more than once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refreshLock();
    void this.restore();
  }

  private async restore(): Promise<void> {
    const last = remembered();
    if (last !== 'wallet' && last !== 'guest') return;
    this.set({ restoring: true });
    try {
      if (last === 'wallet') {
        const signer = await restoreWallet(this.config.network);
        if (signer) this.setSigner(signer);
        else remember(null);
      } else {
        const guest = loadGuest(this.config.network);
        if (guest) {
          this.setSigner(await this.chain.signer(this.config, guest));
          // A new guest whose sign-up was cut short by a reload: carry on from what the chain says.
          if (guest.setup === 'pending' && guest.secretKey && this.sessionKeys) void this.resumeSetup(guest);
        } else remember(null);
      }
    } catch {
      /* stay signed out; the buttons still work */
    } finally {
      this.set({ restoring: false });
    }
  }

  async refreshLock(): Promise<void> {
    const contractId = this.state.deployment.id;
    try {
      const lock = await this.clientFor(contractId).getLockStatus();
      if (this.state.deployment.id !== contractId) return;
      this.set({ lock: lock.locked ? { status: 'locked' } : { status: 'open', keys: lock.keys } });
    } catch {
      if (this.state.deployment.id === contractId) this.set({ lock: { status: 'error' } });
    }
  }

  // ---------- guest play ----------

  /** Session keys are on unless the build switches them off (VITE_SESSION_KEYS=off). */
  private get sessionKeys(): boolean {
    return this.config.sessionKeys !== false;
  }

  /** account, confirm, one claim per deployment, lock: or the three steps of old when session keys are off. */
  private stepCount(pending: boolean): number {
    return pending ? 2 + this.config.contracts.length + 1 : 3;
  }

  private guestStep(step: GuestStep, at: number, of: number, detail: string | null = null): void {
    const keep = this.state.guest;
    this.set({ guest: { status: 'running', step, error: null, claimTx: keep.claimTx, lockTx: keep.lockTx ?? null, detail, at, of } });
  }

  private guestFail(step: GuestStep, error: string): void {
    this.set({ guest: { ...this.state.guest, status: 'error', step, error } });
  }

  private guestDone(): void {
    this.set({ guest: { ...this.state.guest, status: 'done', step: null, error: null, detail: null }, version: this.state.version + 1 });
  }

  /** A claim, tried a few times: a fresh account can take a block or two before it can sign. */
  private async claimOn(contractId: string): Promise<{ ok: boolean; message: string; txHash?: string }> {
    let last = { ok: false, message: describeError('ERR_UNKNOWN'), txHash: undefined as string | undefined };
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.clientFor(contractId).claim();
      if (res.ok || res.code === 'ERR_ALREADY_CLAIMED') return { ok: true, message: '', txHash: res.txHash };
      last = { ok: false, message: res.message, txHash: res.txHash };
      if (res.code.startsWith('ERR_') && !['ERR_UNKNOWN', 'ERR_NETWORK'].includes(res.code)) break;
      await new Promise((resolve) => setTimeout(resolve, this.retryMs));
    }
    return last;
  }

  /** Wait between retries; shortened in tests. */
  retryMs = 2000;

  /**
   * One click: make a key, have the faucet create a funded testnet account,
   * wait until the network can see it, claim NOTIT on every deployment, then
   * swap the full-access key for keys that can only volunteer. Picks up where
   * it stopped if called again after a failure or a reload.
   */
  async playAsGuest(): Promise<void> {
    if (this.state.guest.status === 'running') return;
    const network = this.config.network;
    this.set({ guest: IDLE_GUEST });

    // 1. The account. A guest created by an earlier, interrupted attempt is reused.
    let guest: GuestCredentials | null = loadGuest(network);
    const pending = guest ? guest.setup === 'pending' && !!guest.secretKey && this.sessionKeys : this.sessionKeys;
    const of = this.stepCount(pending);
    this.guestStep('account', 1, of);
    if (!guest) {
      try {
        guest = await this.chain.createAccount(this.config);
      } catch (e) {
        this.guestFail('account', e instanceof Error ? e.message : 'The faucet refused.');
        return;
      }
      if (this.sessionKeys) guest = { ...guest, setup: 'pending' };
      saveGuest(network, guest);
    }

    // 2. Wait until the RPC nodes know about it.
    this.guestStep('confirm', 2, of);
    const visible = await this.chain.waitForAccount(this.config, guest.accountId).catch(() => false);
    if (!visible) {
      this.guestFail('confirm', 'The new account is not on the network yet.');
      return;
    }
    try {
      this.setSigner(await this.chain.signer(this.config, guest));
    } catch {
      this.guestFail('confirm', 'The guest key could not be loaded.');
      return;
    }
    // A guest whose key is already locked has nothing left to set up.
    if (!guest.secretKey) {
      this.guestDone();
      return;
    }

    // 3. Claim on the deployment on screen. This one must work: it is what "play" means.
    const here = this.state.deployment;
    this.guestStep('claim', 3, of, here.label);
    const first = await this.claimOn(here.id);
    if (!first.ok) {
      this.guestFail('claim', 'The account is made; the claim did not go through.');
      this.set({ version: this.state.version + 1 });
      return;
    }
    this.set({ guest: { ...this.state.guest, claimTx: first.txHash ?? null }, version: this.state.version + 1 });

    // 4. The rest (the other deployments, the key swap) can only improve things: it never fails the sign-up.
    if (pending) await this.finishSetup(guest, here.id);
    this.guestDone();
  }

  /** After a reload in the middle of a new guest's sign-up. */
  private async resumeSetup(guest: GuestCredentials): Promise<void> {
    if (this.state.guest.status === 'running') return;
    await this.finishSetup(guest, null);
    this.guestDone();
  }

  /**
   * Claims on every other deployment, then swaps the keys. The full-access key
   * is given up only when the chain shows exactly the function-call keys; any
   * failure on the way leaves the guest playing with the full key, as before.
   */
  private async finishSetup(guest: GuestCredentials, claimedHere: string | null): Promise<'locked' | 'full'> {
    const network = this.config.network;
    const contracts = this.config.contracts;
    const of = this.stepCount(true);
    const lockStep = of;
    try {
      // The swap may already be on chain (a reload after it was sent): the key list decides.
      if (guest.keys && (await this.isLocked(guest.accountId, guest.keys))) return await this.adoptLocked(guest);

      // A function-call key cannot attach the deposit `claim` needs, so every claim comes first.
      let at = 3;
      for (const c of contracts) {
        if (c.id === claimedHere) {
          at += 1;
          continue;
        }
        this.guestStep('claim', claimedHere === null ? at : at + 0, of, c.label);
        at += 1;
        const already = await this.clientFor(c.id)
          .getAccount(guest.accountId)
          .then((a) => a.claimed)
          .catch(() => false);
        if (already) continue;
        const res = await this.claimOn(c.id);
        if (!res.ok) return 'full';
        if (c.id === this.state.deployment.id) this.set({ guest: { ...this.state.guest, claimTx: res.txHash ?? null }, version: this.state.version + 1 });
      }

      this.guestStep('lock', lockStep, of);
      const secret = guest.keys ?? (await this.chain.newKeys(contracts.map((c) => c.id))).secret;
      const publicKeys = await this.chain.publicKeys(secret);
      // Stored before anything is sent: if the page closes mid-swap, the new keys are not lost.
      guest = { ...guest, keys: secret, setup: 'pending' };
      if (!saveGuest(network, guest)) return 'full';
      try {
        const out = await this.chain.swapKeys(this.config, guest, publicKeys);
        this.set({ guest: { ...this.state.guest, lockTx: out.txHash ?? null } });
      } catch {
        /* it may have landed all the same: the key list below is what counts */
      }
      for (let attempt = 0; attempt < 12; attempt++) {
        if (await this.isLocked(guest.accountId, secret)) return await this.adoptLocked(guest);
        await new Promise((resolve) => setTimeout(resolve, this.retryMs / 3));
      }
      return 'full';
    } catch {
      return 'full';
    }
  }

  /** True when the account holds exactly the function-call keys we have, and no full-access key. */
  private async isLocked(accountId: string, secret: Record<string, string>): Promise<boolean> {
    const [keys, want] = await Promise.all([this.chain.accessKeys(this.config, accountId), this.chain.publicKeys(secret)]);
    return isLockedTo(keys, want);
  }

  /** The chain shows only the function-call keys: forget the full key, in storage and in memory. */
  private async adoptLocked(guest: GuestCredentials): Promise<'locked'> {
    const locked: GuestCredentials = { accountId: guest.accountId, keys: guest.keys };
    saveGuest(this.config.network, locked);
    this.setSigner(await this.chain.signer(this.config, locked));
    return 'locked';
  }

  /** Signs the guest out and deletes its key from this browser. It cannot be recovered. */
  forgetGuest(): void {
    forgetGuest(this.config.network);
    if (this.signer?.kind === 'guest') this.setSigner(null);
    this.set({ guest: IDLE_GUEST });
  }

  // ---------- wallets ----------

  async connectWallet(): Promise<void> {
    if (this.state.wallet.busy) return;
    this.set({ wallet: { busy: true, error: null } });
    try {
      const signer = await connectWallet(this.config.network);
      this.setSigner(signer);
      this.set({ wallet: { busy: false, error: null }, guest: IDLE_GUEST });
    } catch (e) {
      const text = e instanceof Error ? e.message : '';
      const cancelled = /cancel|reject|closed|denied/i.test(text);
      this.set({
        wallet: {
          busy: false,
          error: cancelled
            ? null
            : `Wallet login is not available right now${text ? ` (${text.slice(0, 120)})` : ''}. Playing as a guest works without a wallet.`,
        },
      });
    }
  }

  /**
   * Signs out. A wallet is disconnected. A guest key stays in this browser,
   * so "Play as guest" picks the same account up again; use `forgetGuest` to
   * delete it.
   */
  async signOut(): Promise<void> {
    if (this.signer?.kind === 'wallet') await disconnectWallet(this.config.network);
    this.setSigner(null);
    this.set({ guest: IDLE_GUEST });
  }

  /** Account id of a guest whose key is stored in this browser, signed in or not. */
  storedGuestId(): string | null {
    return loadGuest(this.config.network)?.accountId ?? null;
  }
}

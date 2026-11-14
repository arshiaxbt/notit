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
import { createGuestAccount, forgetGuest, guestSigner, loadChainProvider, loadGuest, saveGuest, waitForAccount } from './chain';
import type { GuestCredentials } from './chain';
import type { ChainConfig, Deployment } from './config';
import { describeError } from './errors';
import { NearClient } from './NearClient';
import type { ChainSigner } from './NearClient';
import { connectWallet, disconnectWallet, restoreWallet } from './wallet';

export type GuestStep = 'account' | 'confirm' | 'claim';

export interface GuestProgress {
  status: 'idle' | 'running' | 'done' | 'error';
  /** The step in progress, or the one that failed. */
  step: GuestStep | null;
  error: string | null;
  /** Hash of the claim transaction, once known. */
  claimTx: string | null;
}

export type LockState = { status: 'unknown' } | { status: 'locked' } | { status: 'open'; keys: number } | { status: 'error' };

export interface SessionState {
  deployment: Deployment;
  account: { id: string; kind: 'guest' | 'wallet' } | null;
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

  constructor(config: ChainConfig) {
    this.config = config;
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
        provider: () => loadChainProvider(this.config.rpcUrls),
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
      account: signer ? { id: signer.accountId, kind: signer.kind } : null,
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
        if (guest) this.setSigner(await guestSigner(this.config, guest));
        else remember(null);
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

  private guestStep(step: GuestStep): void {
    this.set({ guest: { status: 'running', step, error: null, claimTx: null } });
  }

  private guestFail(step: GuestStep, error: string): void {
    this.set({ guest: { status: 'error', step, error, claimTx: null } });
  }

  /**
   * One click: make a key, have the faucet create a funded testnet account,
   * wait until the network can see it, then claim NOTIT on the selected
   * contract. Picks up where it stopped if called again after a failure.
   */
  async playAsGuest(): Promise<void> {
    if (this.state.guest.status === 'running') return;
    const network = this.config.network;

    // 1. The account. A guest created by an earlier, interrupted attempt is reused.
    let guest: GuestCredentials | null = loadGuest(network);
    this.guestStep('account');
    if (!guest) {
      try {
        guest = await createGuestAccount(this.config);
      } catch (e) {
        this.guestFail('account', e instanceof Error ? e.message : 'The faucet refused.');
        return;
      }
      saveGuest(network, guest);
    }

    // 2. Wait until the RPC nodes know about it.
    this.guestStep('confirm');
    const visible = await waitForAccount(this.config, guest.accountId).catch(() => false);
    if (!visible) {
      this.guestFail('confirm', 'The new account is not on the network yet.');
      return;
    }
    try {
      this.setSigner(await guestSigner(this.config, guest));
    } catch (e) {
      this.guestFail('confirm', 'The guest key could not be loaded.');
      return;
    }

    // 3. Claim. A fresh account can take a block or two before it can sign.
    this.guestStep('claim');
    let last = { code: 'ERR_UNKNOWN', message: describeError('ERR_UNKNOWN'), txHash: undefined as string | undefined };
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.client.claim();
      if (res.ok || res.code === 'ERR_ALREADY_CLAIMED') {
        this.set({
          guest: { status: 'done', step: null, error: null, claimTx: res.txHash ?? null },
          version: this.state.version + 1,
        });
        return;
      }
      last = { code: res.code, message: res.message, txHash: res.txHash };
      if (res.code.startsWith('ERR_') && !['ERR_UNKNOWN', 'ERR_NETWORK'].includes(res.code)) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    this.guestFail('claim', 'The account is made; the claim did not go through.');
    this.set({ version: this.state.version + 1 });
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

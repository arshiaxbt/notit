import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_ALLOWANCE_NEAR, SESSION_METHODS, guestSigner, isLockedTo, loadGuest, loadNearApi, saveGuest, swapActions } from './chain';
import type { GuestChain, GuestCredentials, KeyInfo } from './chain';
import type { ChainConfig } from './config';
import { accessKeysUrl } from './config';
import type { ChainProvider, ChainSigner, FunctionCall } from './NearClient';
import { TxFailure } from './NearClient';
import { ChainSession } from './session';
import { keyMarkText } from '../components/play/Chain';

const CONFIG: ChainConfig = {
  network: 'testnet',
  rpcUrls: ['https://rpc.invalid'],
  faucetUrl: 'https://faucet.invalid/account',
  explorer: 'https://explorer.invalid',
  contracts: [
    { id: 'one.testnet', label: 'Fast' },
    { id: 'two.testnet', label: 'Live' },
  ],
  pollMs: 3000,
};
const ID = 'guest-abc12345.testnet';
const FULL = 'ed25519:FULL';
const fc = (contractId: string) => `ed25519:FC-${contractId}`;
const pub = (secret: string) => secret.replace('ed25519:', 'pub:');

/** A pretend chain: one guest account, its access keys, and where it has claimed. */
function world(opts: { failClaimOn?: string; swap?: 'ok' | 'refused' | 'lands-but-throws' | 'never-visible' } = {}) {
  const claimed = new Set<string>();
  let keys: KeyInfo[] = [{ publicKey: pub(FULL), permission: 'full' }];
  let hideSwap = false;
  const calls: Array<{ contractId: string; method: string; deposit: bigint; signedWith: string }> = [];
  const swaps: Array<Record<string, string>> = [];
  const faucet = { calls: 0 };

  const signerFor = (guest: GuestCredentials): ChainSigner => ({
    accountId: guest.accountId,
    kind: 'guest',
    key: guest.secretKey ? 'full' : 'volunteer',
    async call(call: FunctionCall) {
      const secret = guest.secretKey ?? guest.keys?.[call.contractId];
      if (!secret) throw new TxFailure('ERR_KEY_LIMITED');
      if (!guest.secretKey && (call.deposit > 0n || !SESSION_METHODS.includes(call.method))) throw new TxFailure('ERR_KEY_LIMITED');
      // The chain itself refuses a key it does not know.
      if (!keys.some((k) => k.publicKey === pub(secret))) throw new TxFailure('InvalidAccessKeyError');
      calls.push({ contractId: call.contractId, method: call.method, deposit: call.deposit, signedWith: secret });
      if (call.method === 'claim') {
        if (opts.failClaimOn === call.contractId) throw new TxFailure('Contract panicked: ERR_CLAIMS_CLOSED');
        claimed.add(call.contractId);
      }
      return { txHash: `tx-${calls.length}`, logs: [] };
    },
  });

  const chain: GuestChain = {
    async createAccount() {
      faucet.calls += 1;
      return { accountId: ID, secretKey: FULL };
    },
    async waitForAccount() {
      return true;
    },
    async signer(_config, guest) {
      return signerFor(guest);
    },
    async newKeys(contractIds) {
      return { secret: Object.fromEntries(contractIds.map((c) => [c, fc(c)])), public: Object.fromEntries(contractIds.map((c) => [c, pub(fc(c))])) };
    },
    async publicKeys(secret) {
      return Object.fromEntries(Object.entries(secret).map(([c, k]) => [c, pub(k)]));
    },
    async swapKeys(_config, guest, publicKeys) {
      swaps.push(publicKeys);
      if (opts.swap === 'refused') throw new Error('the transaction was refused');
      if (!guest.secretKey) throw new Error('no full key');
      keys = Object.entries(publicKeys).map(([contractId, publicKey]) => ({ publicKey, permission: { receiver: contractId, methods: [...SESSION_METHODS] } }));
      if (opts.swap === 'never-visible') hideSwap = true;
      if (opts.swap === 'lands-but-throws') throw new Error('timed out waiting for the answer');
      return { txHash: 'tx-swap' };
    },
    async accessKeys() {
      return hideSwap ? [{ publicKey: pub(FULL), permission: 'full' }] : keys;
    },
  };
  const provider = async (): Promise<ChainProvider> => ({
    async callFunction({ contractId, method }) {
      if (method === 'get_account') return { registered: claimed.has(contractId), claimed: claimed.has(contractId), balance: claimed.has(contractId) ? '1000' : '0', saves: 0, burned: '0', collected: '0', is_it: false };
      if (method === 'storage_balance_bounds') return { min: '1250000000000000000000', max: '1250000000000000000000' };
      throw new Error(`unexpected view ${method}`);
    },
    async viewAccessKeyList() {
      return { keys: [] };
    },
  });
  const session = () => {
    const s = new ChainSession(CONFIG, chain, provider);
    s.retryMs = 1;
    return s;
  };
  return { chain, provider, session, calls, swaps, faucet, claimed, keysOnChain: () => keys, showSwap: () => (hideSwap = false) };
}

/** Waits until the session has nothing in flight. */
async function settled(session: ChainSession): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const s = session.getState();
    if (!s.restoring && s.guest.status !== 'running') return;
  }
  throw new Error('the session did not settle');
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('a new guest ends up with keys that can only volunteer', () => {
  it('claims on every deployment, swaps the keys in one transaction, then forgets the full key', async () => {
    const w = world();
    const session = w.session();
    const steps: string[] = [];
    session.subscribe(() => {
      const g = session.getState().guest;
      const line = `${g.at}/${g.of} ${g.step}${g.detail ? ` ${g.detail}` : ''}`;
      if (g.status === 'running' && steps[steps.length - 1] !== line) steps.push(line);
    });

    await session.playAsGuest();

    expect(steps).toEqual(['1/5 account', '2/5 confirm', '3/5 claim Fast', '4/5 claim Live', '5/5 lock']);
    // Both claims were signed with the full key and carried the storage deposit.
    expect(w.calls.map((c) => `${c.method}@${c.contractId}`)).toEqual(['claim@one.testnet', 'claim@two.testnet']);
    expect(w.calls.every((c) => c.signedWith === FULL && c.deposit > 0n)).toBe(true);
    // One swap, with a different key for each contract.
    expect(w.swaps).toEqual([{ 'one.testnet': pub(fc('one.testnet')), 'two.testnet': pub(fc('two.testnet')) }]);
    expect(new Set(Object.values(w.swaps[0]!)).size).toBe(2);
    // The chain holds exactly the two function-call keys.
    expect(isLockedTo(w.keysOnChain(), w.swaps[0]!)).toBe(true);
    // Storage and memory: only the function-call secrets are left.
    expect(loadGuest('testnet')).toEqual({ accountId: ID, keys: { 'one.testnet': fc('one.testnet'), 'two.testnet': fc('two.testnet') }, secretKey: undefined, setup: undefined });
    expect(localStorage.getItem('notit-guest:testnet')).not.toContain('FULL');
    const state = session.getState();
    expect(state.guest.status).toBe('done');
    expect(state.guest.lockTx).toBe('tx-swap');
    expect(state.account).toEqual({ id: ID, kind: 'guest', key: 'volunteer' });
  });

  it('signs for each contract with that contract\'s key, and cannot claim or attach a deposit', async () => {
    const w = world();
    const session = w.session();
    await session.playAsGuest();
    w.calls.length = 0;

    expect((await session.client.volunteer({ round: 1, maxCost: 10n })).ok).toBe(true);
    session.selectContract('two.testnet');
    expect((await session.client.poke()).ok).toBe(true);
    expect(w.calls.map((c) => [c.contractId, c.method, c.signedWith])).toEqual([
      ['one.testnet', 'volunteer', fc('one.testnet')],
      ['two.testnet', 'poke', fc('two.testnet')],
    ]);
    // Nothing that needs a deposit can be sent, and the app says so plainly.
    w.claimed.clear();
    const claim = await session.client.claim();
    expect(claim).toMatchObject({ ok: false, code: 'ERR_KEY_LIMITED', message: 'This browser key can only volunteer.' });
    expect(w.calls).toHaveLength(2);
  });
});

describe('nobody is stranded', () => {
  it('a claim that fails on the other deployment leaves a working full-access session', async () => {
    const w = world({ failClaimOn: 'two.testnet' });
    const session = w.session();
    await session.playAsGuest();
    expect(session.getState().guest.status).toBe('done');
    expect(session.getState().account).toEqual({ id: ID, kind: 'guest', key: 'full' });
    expect(w.swaps).toHaveLength(0);
    expect(loadGuest('testnet')).toMatchObject({ accountId: ID, secretKey: FULL, setup: 'pending' });
    expect((await session.client.volunteer({ round: 1, maxCost: 10n })).ok).toBe(true);
  });

  it('a claim that fails on the deployment on screen stops the sign-up as before, still with the full key', async () => {
    const w = world({ failClaimOn: 'one.testnet' });
    const session = w.session();
    await session.playAsGuest();
    expect(session.getState().guest).toMatchObject({ status: 'error', step: 'claim' });
    expect(session.getState().account?.key).toBe('full');
    expect(w.swaps).toHaveLength(0);
    expect(loadGuest('testnet')?.secretKey).toBe(FULL);
  });

  it('a refused swap leaves the full key in place and in use', async () => {
    const w = world({ swap: 'refused' });
    const session = w.session();
    await session.playAsGuest();
    expect(session.getState().guest.status).toBe('done');
    expect(session.getState().account?.key).toBe('full');
    expect(w.keysOnChain()).toEqual([{ publicKey: pub(FULL), permission: 'full' }]);
    expect(loadGuest('testnet')?.secretKey).toBe(FULL);
    expect((await session.client.volunteer({ round: 1, maxCost: 10n })).ok).toBe(true);
  });

  it('a swap whose answer is lost is judged by the key list, not by the error', async () => {
    const w = world({ swap: 'lands-but-throws' });
    const session = w.session();
    await session.playAsGuest();
    expect(session.getState().account?.key).toBe('volunteer');
    expect(loadGuest('testnet')?.secretKey).toBeUndefined();
    expect((await session.client.volunteer({ round: 1, maxCost: 10n })).ok).toBe(true);
  });

  it('keeps the full key until the key list shows the swap, and adopts the new keys on the next load', async () => {
    const w = world({ swap: 'never-visible' });
    const session = w.session();
    await session.playAsGuest();
    // The node we read from never showed the new keys: nothing is discarded.
    expect(session.getState().account?.key).toBe('full');
    const stored = loadGuest('testnet')!;
    expect(stored.secretKey).toBe(FULL);
    expect(stored.keys).toEqual({ 'one.testnet': fc('one.testnet'), 'two.testnet': fc('two.testnet') });

    // Next visit: the chain answers, the stored function-call keys are adopted, no second swap is sent.
    w.showSwap();
    const next = w.session();
    next.start();
    await settled(next);
    expect(next.getState().account?.key).toBe('volunteer');
    expect(w.swaps).toHaveLength(1);
    expect(loadGuest('testnet')?.secretKey).toBeUndefined();
  });
});

describe('a reload in the middle of the sign-up', () => {
  it('after the first claim: claims on the other deployment and locks the key', async () => {
    const w = world();
    w.claimed.add('one.testnet');
    saveGuest('testnet', { accountId: ID, secretKey: FULL, setup: 'pending' });
    localStorage.setItem('notit-signer', 'guest');
    const session = w.session();
    session.start();
    await settled(session);
    expect(w.faucet.calls).toBe(0);
    expect(w.calls.map((c) => `${c.method}@${c.contractId}`)).toEqual(['claim@two.testnet']);
    expect(w.swaps).toHaveLength(1);
    expect(session.getState().account?.key).toBe('volunteer');
  });

  it('after both claims: only the swap is left', async () => {
    const w = world();
    w.claimed.add('one.testnet').add('two.testnet');
    saveGuest('testnet', { accountId: ID, secretKey: FULL, setup: 'pending' });
    localStorage.setItem('notit-signer', 'guest');
    const session = w.session();
    session.start();
    await settled(session);
    expect(w.calls).toHaveLength(0);
    expect(w.swaps).toHaveLength(1);
    expect(session.getState().account?.key).toBe('volunteer');
  });

  it('"Continue as guest" on a half-made account goes through the same steps without the faucet', async () => {
    const w = world();
    saveGuest('testnet', { accountId: ID, secretKey: FULL, setup: 'pending' });
    const session = w.session();
    await session.playAsGuest();
    expect(w.faucet.calls).toBe(0);
    expect(w.calls.map((c) => `${c.method}@${c.contractId}`)).toEqual(['claim@one.testnet', 'claim@two.testnet']);
    expect(session.getState().account?.key).toBe('volunteer');
  });

  it('an already locked guest is simply signed in', async () => {
    const w = world();
    const first = w.session();
    await first.playAsGuest();
    w.calls.length = 0;
    const session = w.session();
    localStorage.setItem('notit-signer', 'guest');
    session.start();
    await settled(session);
    expect(session.getState().account).toEqual({ id: ID, kind: 'guest', key: 'volunteer' });
    expect(w.calls).toHaveLength(0);
    expect(w.swaps).toHaveLength(1);
  });
});

describe('guests from before session keys', () => {
  it('keep their full-access key: no claims elsewhere, no swap, no migration', async () => {
    const w = world();
    w.claimed.add('one.testnet');
    saveGuest('testnet', { accountId: ID, secretKey: FULL });
    localStorage.setItem('notit-signer', 'guest');
    const session = w.session();
    session.start();
    await settled(session);
    expect(session.getState().account).toEqual({ id: ID, kind: 'guest', key: 'full' });
    expect(w.calls).toHaveLength(0);
    expect(w.swaps).toHaveLength(0);
    expect(loadGuest('testnet')).toMatchObject({ accountId: ID, secretKey: FULL });
    expect(loadGuest('testnet')?.setup).toBeUndefined();
  });

  it('with the flag off a new guest is made exactly as before', async () => {
    const w = world();
    const session = new ChainSession({ ...CONFIG, sessionKeys: false }, w.chain, w.provider);
    session.retryMs = 1;
    await session.playAsGuest();
    expect(w.calls.map((c) => `${c.method}@${c.contractId}`)).toEqual(['claim@one.testnet']);
    expect(w.swaps).toHaveLength(0);
    expect(session.getState().account?.key).toBe('full');
    expect(session.getState().guest).toMatchObject({ status: 'done', of: 3 });
    expect(loadGuest('testnet')).toMatchObject({ accountId: ID, secretKey: FULL });
    expect(loadGuest('testnet')?.setup).toBeUndefined();
  });
});

describe('the pieces', () => {
  it('the swap is two function-call keys and then the deletion of the full key, in that order', async () => {
    const api = await loadNearApi();
    const full = api.KeyPair.fromRandom('ed25519').getPublicKey().toString();
    const one = api.KeyPair.fromRandom('ed25519').getPublicKey().toString();
    const two = api.KeyPair.fromRandom('ed25519').getPublicKey().toString();
    const allowance = api.nearToYocto(SESSION_ALLOWANCE_NEAR);
    expect(allowance).toBe(250_000_000_000_000_000_000_000n);
    const actions = swapActions(api, { 'notit-play.testnet': one, 'notit-live.testnet': two }, full, allowance) as Array<Record<string, any>>;
    expect(actions).toHaveLength(3);
    const added = actions.slice(0, 2).map((a) => {
      const perm = a.addKey.accessKey.permission.functionCall;
      return { key: a.addKey.publicKey.toString(), receiver: perm.receiverId, methods: perm.methodNames, allowance: perm.allowance };
    });
    expect(added).toEqual([
      { key: one, receiver: 'notit-play.testnet', methods: ['volunteer', 'poke'], allowance },
      { key: two, receiver: 'notit-live.testnet', methods: ['volunteer', 'poke'], allowance },
    ]);
    expect(actions[2]!.deleteKey.publicKey.toString()).toBe(full);
    expect(actions[2]!.addKey).toBeUndefined();
  });

  it('a locked signer refuses a deposit, another method or another contract before anything is sent', async () => {
    const api = await loadNearApi();
    const secret = api.KeyPair.fromRandom('ed25519').toString();
    const signer = await guestSigner(CONFIG, { accountId: ID, keys: { 'one.testnet': secret } });
    expect(signer.key).toBe('volunteer');
    const base = { contractId: 'one.testnet', method: 'volunteer', args: {}, deposit: 0n, gasTera: 30 };
    await expect(signer.call({ ...base, deposit: 1n })).rejects.toThrow('ERR_KEY_LIMITED');
    await expect(signer.call({ ...base, method: 'claim' })).rejects.toThrow('ERR_KEY_LIMITED');
    await expect(signer.call({ ...base, contractId: 'two.testnet' })).rejects.toThrow('ERR_KEY_LIMITED');
  });

  it('"locked" means exactly one function-call key per contract, the right methods, and no full-access key', () => {
    const want = { 'one.testnet': 'pub:1', 'two.testnet': 'pub:2' };
    const k1: KeyInfo = { publicKey: 'pub:1', permission: { receiver: 'one.testnet', methods: ['poke', 'volunteer'] } };
    const k2: KeyInfo = { publicKey: 'pub:2', permission: { receiver: 'two.testnet', methods: ['volunteer', 'poke'] } };
    expect(isLockedTo([k1, k2], want)).toBe(true);
    expect(isLockedTo([k1, k2, { publicKey: 'pub:full', permission: 'full' }], want)).toBe(false);
    expect(isLockedTo([k1], want)).toBe(false);
    expect(isLockedTo([k1, { ...k2, permission: { receiver: 'one.testnet', methods: ['volunteer', 'poke'] } }], want)).toBe(false);
    expect(isLockedTo([k1, { ...k2, permission: { receiver: 'two.testnet', methods: ['volunteer', 'poke', 'claim'] } }], want)).toBe(false);
    expect(isLockedTo([k1, { ...k2, publicKey: 'pub:other' }], want)).toBe(false);
  });

  it('the marker says what the key can do and links to the account\'s keys on the explorer', () => {
    expect(keyMarkText('volunteer')).toBe('key: volunteer only');
    expect(keyMarkText('full')).toBe('key: full access');
    expect(accessKeysUrl(CONFIG, ID)).toBe(`https://explorer.invalid/address/${ID}?tab=accesskeys`);
  });
});

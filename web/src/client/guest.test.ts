import { afterEach, describe, expect, it, vi } from 'vitest';
import { FaucetError, createGuestAccount, faucetMessage, isTransportError, preferFirst } from './chain';
import type { ChainConfig } from './config';
import { ChainSession } from './session';

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

function fakeFetch(status: number, body = '') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as typeof fetch;
  return { impl, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('faucet answers', () => {
  it('asks the faucet for an account with a fresh public key', async () => {
    const { impl, calls } = fakeFetch(200, '{}');
    const guest = await createGuestAccount(CONFIG, impl);
    expect(guest.accountId).toMatch(/^guest-[0-9a-z]{8}\.testnet$/);
    expect(guest.secretKey).toMatch(/^ed25519:/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(CONFIG.faucetUrl);
    expect(calls[0]!.init.method).toBe('POST');
    const sent = JSON.parse(String(calls[0]!.init.body)) as { newAccountId: string; newAccountPublicKey: string };
    expect(sent.newAccountId).toBe(guest.accountId);
    expect(sent.newAccountPublicKey).toMatch(/^ed25519:/);
    // The secret key itself is never sent anywhere.
    expect(String(calls[0]!.init.body)).not.toContain(guest.secretKey);
  });

  it('explains a rate limit (HTTP 429) in plain words, with three ways forward', async () => {
    const { impl, calls } = fakeFetch(429, 'Too Many Requests');
    const error = await createGuestAccount(CONFIG, impl).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FaucetError);
    const e = error as FaucetError;
    expect(e.status).toBe(429);
    expect(e.message).toBe(faucetMessage(429));
    expect(e.message).toMatch(/faucet is busy/i);
    expect(e.message).toMatch(/try again in a minute/i);
    expect(e.message).toMatch(/connect a wallet/i);
    expect(e.message).toMatch(/Demo mode/);
    // The faucet's raw words and the status code stay out of the message people read.
    expect(e.message).not.toMatch(/429|Too Many Requests/);
    expect(e.detail).toBe('Too Many Requests');
    // One request only: a refusal is not retried behind the person's back.
    expect(calls).toHaveLength(1);
  });

  it('has a message for server trouble and for other refusals', () => {
    expect(faucetMessage(503)).toMatch(/having trouble.*503/);
    expect(faucetMessage(400)).toMatch(/refused.*400/);
    for (const status of [400, 429, 503]) expect(faucetMessage(status)).toMatch(/Demo mode/);
  });
});

describe('guest sign-up in the session', () => {
  it('stops at the first step with the friendly message when the faucet answers 429', async () => {
    const { impl, calls } = fakeFetch(429, 'Too Many Requests');
    vi.stubGlobal('fetch', impl);
    const session = new ChainSession(CONFIG);
    const seen: string[] = [];
    session.subscribe(() => seen.push(`${session.getState().guest.status}:${session.getState().guest.step ?? '-'}`));

    await session.playAsGuest();

    const { guest, account } = session.getState();
    expect(guest.status).toBe('error');
    expect(guest.step).toBe('account');
    expect(guest.error).toBe(faucetMessage(429));
    expect(account).toBeNull();
    expect(session.storedGuestId()).toBeNull();
    expect(seen).toContain('running:account');
    expect(calls).toHaveLength(1);

    // "Try again" simply runs the same step again: one more request, same answer.
    await session.playAsGuest();
    expect(calls).toHaveLength(2);
    expect(session.getState().guest.error).toBe(faucetMessage(429));
  });

  it('starts on the first listed contract and can switch to another', () => {
    const session = new ChainSession(CONFIG);
    expect(session.getState().deployment.id).toBe('one.testnet');
    const first = session.client;
    expect(first.contractId).toBe('one.testnet');
    vi.stubGlobal('fetch', fakeFetch(500).impl);
    session.selectContract('two.testnet');
    expect(session.getState().deployment.id).toBe('two.testnet');
    expect(session.client.contractId).toBe('two.testnet');
    expect(session.client).not.toBe(first);
    session.selectContract('nope.testnet');
    expect(session.getState().deployment.id).toBe('two.testnet');
    session.selectContract('one.testnet');
    expect(session.client).toBe(first);
  });
});

describe('RPC endpoints', () => {
  const panic = Object.assign(new Error('Contract panicked: ERR_ALREADY_SAVED'), { name: 'HostGuestPanicError', panicMessage: 'ERR_ALREADY_SAVED' });

  function endpoint(name: string, behave: () => unknown) {
    const calls: unknown[][] = [];
    return {
      name,
      calls,
      url: `https://${name}.invalid`,
      async callFunction(...args: unknown[]) {
        calls.push(args);
        const v = behave();
        if (v instanceof Error) throw v;
        return v;
      },
    };
  }

  it('uses the first endpoint, and the next one only for a call the first did not answer', async () => {
    let refuse = true;
    let clock = 1_000;
    const fast = endpoint('fast', () => (refuse ? new TypeError('Failed to fetch') : 'from fast'));
    const slow = endpoint('slow', () => 'from slow');
    const rpc = preferFirst([fast, slow], { coolOffMs: 15_000, now: () => clock });

    expect(await rpc.callFunction({ method: 'get_state' })).toBe('from slow');
    expect(fast.calls).toHaveLength(1);
    expect(slow.calls).toHaveLength(1);

    // For a short while the endpoint that refused is left alone...
    refuse = false;
    clock += 5_000;
    expect(await rpc.callFunction({ method: 'get_state' })).toBe('from slow');
    expect(fast.calls).toHaveLength(1);
    expect(slow.calls).toHaveLength(2);

    // ...and then the first endpoint is used again, instead of staying on the fallback.
    clock += 11_000;
    expect(await rpc.callFunction({ method: 'get_state' })).toBe('from fast');
    expect(fast.calls).toHaveLength(2);
    expect(slow.calls).toHaveLength(2);
    expect(fast.calls[1]).toEqual([{ method: 'get_state' }]);
    // Plain properties come from the first endpoint.
    expect(rpc.url).toBe('https://fast.invalid');
  });

  it('still asks when every endpoint has refused recently', async () => {
    let clock = 0;
    let down = true;
    const a = endpoint('a', () => (down ? new TypeError('Failed to fetch') : 'a is back'));
    const b = endpoint('b', () => new TypeError('Failed to fetch'));
    const rpc = preferFirst([a, b], { now: () => clock });
    await expect(rpc.callFunction({})).rejects.toThrow('Failed to fetch');
    down = false;
    clock += 1_000;
    expect(await rpc.callFunction({})).toBe('a is back');
  });

  it('does not send a refused contract call to another endpoint', async () => {
    const fast = endpoint('fast', () => panic);
    const slow = endpoint('slow', () => 'should not be asked');
    await expect(preferFirst([fast, slow]).callFunction({})).rejects.toBe(panic);
    expect(slow.calls).toHaveLength(0);
  });

  it('gives the last error when no endpoint answers', async () => {
    const a = endpoint('a', () => new TypeError('Failed to fetch'));
    const b = endpoint('b', () => Object.assign(new Error('Too Many Requests'), { name: 'ProviderError', cause: 429 }));
    await expect(preferFirst([a, b]).callFunction({})).rejects.toThrow('Too Many Requests');
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it('tells transport trouble from answers given by the chain', () => {
    expect(isTransportError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransportError(Object.assign(new Error('rate limited'), { name: 'ProviderError', cause: 429 }))).toBe(true);
    expect(isTransportError(Object.assign(new Error('Exceeded 3 attempts for request to query.'), { name: 'TypedError' }))).toBe(true);
    expect(isTransportError(panic)).toBe(false);
    expect(isTransportError(Object.assign(new Error('Account x does not exist at block height 5'), { name: 'AccountDoesNotExistError' }))).toBe(false);
    expect(isTransportError(Object.assign(new Error('boom'), { transactionResult: {} }))).toBe(false);
  });
});

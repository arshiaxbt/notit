/**
 * The near-api-js side of Testnet mode: the RPC provider, guest accounts and
 * the guest-key signer. near-api-js is loaded with a dynamic import, so it is
 * only downloaded when Testnet mode is actually used.
 */
import type { ChainConfig } from './config';
import { TxFailure, errorTxHash, outcomeToTx } from './NearClient';
import type { ChainProvider, ChainSigner, FunctionCall, TxOutcome } from './NearClient';

type NearApi = typeof import('near-api-js');

let apiPromise: Promise<NearApi> | null = null;

export function loadNearApi(): Promise<NearApi> {
  if (!apiPromise) {
    apiPromise = import('near-api-js');
    apiPromise.catch(() => {
      apiPromise = null;
    });
  }
  return apiPromise;
}

type RpcProvider = InstanceType<NearApi['JsonRpcProvider']>;
const providers = new Map<string, Promise<RpcProvider>>();

/**
 * Errors that say "this endpoint did not answer", as opposed to an answer from
 * the chain such as a contract panic or "account does not exist". Only the
 * first kind is worth trying on another endpoint.
 */
export function isTransportError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return true;
  const o = e as { name?: unknown; message?: unknown; transactionResult?: unknown; panicMessage?: unknown; cause?: unknown };
  if (o.transactionResult !== undefined || o.panicMessage !== undefined) return false;
  const name = typeof o.name === 'string' ? o.name : '';
  const message = typeof o.message === 'string' ? o.message : '';
  if (e instanceof TypeError) return true; // fetch failed: offline, CORS-less refusal, DNS
  if (name === 'ProviderError' || name === 'RetriesExceeded' || /RetriesExceeded|Exceeded \d+ attempts/.test(message)) return true;
  if (typeof o.cause === 'number' && [408, 429, 500, 502, 503].includes(o.cause)) return true;
  return /Failed to fetch|NetworkError|network|timed? ?out|Too Many Requests|Bad Gateway|unavailable/i.test(message);
}

/**
 * Presents several RPC endpoints as one provider. Every call goes to the first
 * endpoint; only if that one does not answer is the next tried, for that call
 * alone. An endpoint that just refused is left alone for a short while, so a
 * rate limit is not made worse by knocking on it with every call.
 * (near-api-js's own FailoverRpcProvider stays on the fallback after a single
 * refusal, and the usual public fallback is far slower.)
 */
export function preferFirst<T extends object>(endpoints: T[], options: { coolOffMs?: number; now?: () => number } = {}): T {
  if (endpoints.length === 0) throw new Error('At least one RPC endpoint is needed');
  const first = endpoints[0]!;
  if (endpoints.length === 1) return first;
  // A refused endpoint rests for a minute; refused again on waking, twice as long (up to five minutes).
  const coolOffMs = options.coolOffMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const restingUntil = endpoints.map(() => 0);
  const refusals = endpoints.map(() => 0);
  return new Proxy(first, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const t = now();
        const awake = endpoints.map((_, i) => i).filter((i) => restingUntil[i]! <= t);
        // If every endpoint is resting, try them all anyway rather than fail without asking.
        const order = awake.length > 0 ? awake : endpoints.map((_, i) => i);
        let lastError: unknown;
        for (const i of order) {
          try {
            const answer = await (endpoints[i] as Record<PropertyKey, (...a: unknown[]) => unknown>)[prop]!(...args);
            refusals[i] = 0;
            return answer;
          } catch (e) {
            lastError = e;
            if (!isTransportError(e)) throw e;
            // A rate limit is an expected event on public endpoints: step aside quietly.
            restingUntil[i] = now() + Math.min(coolOffMs * 2 ** refusals[i]!, Math.max(coolOffMs, 300_000));
            refusals[i]! += 1;
          }
        }
        throw lastError;
      };
    },
  });
}

/** One provider per list of RPC URLs, shared by views and signers. */
export function loadProvider(rpcUrls: string[]): Promise<RpcProvider> {
  const key = rpcUrls.join(',');
  let p = providers.get(key);
  if (!p) {
    // A refusal is not retried on the same endpoint: the next one gets the call at once.
    // (The library default is twelve attempts with growing waits, which stalls the UI
    // and keeps knocking on an endpoint that is rate-limiting.)
    p = loadNearApi().then((api) =>
      preferFirst(rpcUrls.map((url) => new api.JsonRpcProvider({ url }, { retries: 1, wait: 200, backoff: 2 }))),
    );
    p.catch(() => providers.delete(key));
    providers.set(key, p);
  }
  return p;
}

/** The provider as the NearClient sees it. */
export async function loadChainProvider(rpcUrls: string[]): Promise<ChainProvider> {
  const provider = await loadProvider(rpcUrls);
  return {
    callFunction: (params) => provider.callFunction(params),
    viewAccessKeyList: (params) => provider.viewAccessKeyList(params),
  };
}

/* ---- guest accounts ---- */

export interface GuestCredentials {
  accountId: string;
  /** "ed25519:…". Lives only in this browser's localStorage. */
  secretKey: string;
}

function storageKey(network: string): string {
  return `notit-guest:${network}`;
}

export function loadGuest(network: string): GuestCredentials | null {
  try {
    const raw = localStorage.getItem(storageKey(network));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<GuestCredentials>;
    if (typeof v.accountId === 'string' && typeof v.secretKey === 'string') return { accountId: v.accountId, secretKey: v.secretKey };
  } catch {
    /* blocked or corrupt storage: treat as no guest */
  }
  return null;
}

export function saveGuest(network: string, guest: GuestCredentials): boolean {
  try {
    localStorage.setItem(storageKey(network), JSON.stringify(guest));
    return true;
  } catch {
    return false;
  }
}

export function forgetGuest(network: string): void {
  try {
    localStorage.removeItem(storageKey(network));
  } catch {
    /* nothing to forget */
  }
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** "guest-" plus eight random base36 characters, under the network's top-level account. */
export function randomGuestId(network: string, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(8);
  let name = '';
  for (let i = 0; i < 8; i++) name += BASE36[bytes[i]! % 36];
  return `guest-${name}.${network === 'mainnet' ? 'near' : 'testnet'}`;
}

/** What to tell someone when the faucet will not make an account, by HTTP status. */
export function faucetMessage(status: number): string {
  if (status === 429) return 'The faucet is busy.';
  if (status >= 500) return 'The faucet is down.';
  return 'The faucet refused.';
}

export class FaucetError extends Error {
  status: number;
  /** The faucet's own words, for the console; not shown to people. */
  detail: string;
  constructor(status: number, detail = '') {
    super(faucetMessage(status));
    this.name = 'FaucetError';
    this.status = status;
    this.detail = detail.slice(0, 300);
  }
}

/** Makes a key pair and asks the testnet helper to create a faucet-funded account for it. */
export async function createGuestAccount(config: ChainConfig, fetchImpl: typeof fetch = fetch): Promise<GuestCredentials> {
  const api = await loadNearApi();
  const keyPair = api.KeyPair.fromRandom('ed25519');
  const accountId = randomGuestId(config.network);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetchImpl(config.faucetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(
      controller.signal.aborted
        ? 'The faucet did not answer.'
        : 'The faucet could not be reached.',
      { cause: e },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new FaucetError(response.status, await response.text().catch(() => ''));
  return { accountId, secretKey: keyPair.toString() };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the RPC nodes can see a newly created account. */
export async function waitForAccount(config: ChainConfig, accountId: string, timeoutMs = 30_000): Promise<boolean> {
  const api = await loadNearApi();
  const deadline = Date.now() + timeoutMs;
  let i = 0;
  while (Date.now() < deadline) {
    // A plain provider: "does not exist" is an expected answer here, not a reason to fail over.
    const url = config.rpcUrls[i % config.rpcUrls.length]!;
    try {
      await new api.JsonRpcProvider({ url }).viewAccount({ accountId });
      return true;
    } catch {
      i += 1;
      await sleep(1200);
    }
  }
  return false;
}

/** A signer backed by a guest key held in this browser. */
export async function guestSigner(config: ChainConfig, guest: GuestCredentials): Promise<ChainSigner> {
  const api = await loadNearApi();
  const provider = await loadProvider(config.rpcUrls);
  const account = new api.Account(guest.accountId, provider, guest.secretKey as Parameters<NearApi['KeyPair']['fromString']>[0]);
  return {
    accountId: guest.accountId,
    kind: 'guest',
    async call(call: FunctionCall): Promise<TxOutcome> {
      try {
        const raw = await account.callFunctionRaw({
          contractId: call.contractId,
          methodName: call.method,
          args: call.args,
          gas: api.teraToGas(call.gasTera),
          deposit: call.deposit,
        });
        return outcomeToTx(raw);
      } catch (e) {
        if (e instanceof TxFailure) throw e;
        // near-api-js throws e.g. HostGuestPanicError("Contract panicked: ERR_ALREADY_SAVED")
        // with the outcome attached. Keep the message (it carries the code) and the hash.
        const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        const panic = (e as { panicMessage?: unknown } | null)?.panicMessage;
        throw new TxFailure(typeof panic === 'string' ? `${text} (${panic})` : text, errorTxHash(e));
      }
    },
  };
}

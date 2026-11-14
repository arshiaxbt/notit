import { describe, expect, it } from 'vitest';
import { readChainConfig, txUrl } from './config';
import { randomGuestId } from './chain';
import { describeError, errorCode, isGentle } from './errors';
import {
  NearClient,
  TxFailure,
  errorTxHash,
  outcomeToTx,
  parseRoundSaved,
  toAccountView,
  toConfigView,
  toHero,
  toHistoryEntry,
  toStateView,
} from './NearClient';
import type { ChainProvider, ChainSigner, FunctionCall, RawAccount, RawState, TxOutcome } from './NearClient';

const CONTRACT = 'notit-dev.testnet';

// Shapes copied from the dev deployment's real answers.
const RAW_STATE: RawState = {
  now_ns: '1794616255419893527',
  round: 7,
  round_start_ns: '1794616178483805523',
  round_end_ns: '1794616358483805523',
  saved: false,
  hero: null,
  it: 'usurper.testnet',
  armed: true,
  collapse_run: 0,
  cost_now: '165414499333470290427',
  round_supply: '5610314046040913391237',
  total_supply: '5610314046040913391237',
  index: '1000000000000000000000000000',
  scale: 0,
  claims_made: 6,
  claim_open: true,
  stats: {
    rounds_saved: 5,
    rounds_collapsed: 0,
    current_streak: 5,
    longest_streak: 5,
    closest_call_ms: 27948,
    total_burned: '389685953959086608763',
    total_paid: '0',
  },
};

const RAW_CONFIG = {
  round_ns: '180000000000',
  max_cost_ppm: 50000,
  min_cost_ppm: 2000,
  cut_ppm: 150000,
  claim_amount: '1000000000000000000000',
  claim_cap: 100000,
  genesis_ns: '1794614918483805523',
  decimals: 18,
  max_collapse_run: 8,
};

function rawAccount(patch: Partial<RawAccount> = {}): RawAccount {
  return { registered: false, claimed: false, balance: '0', saves: 0, burned: '0', collected: '0', is_it: false, ...patch };
}

class FakeProvider implements ChainProvider {
  calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  account = rawAccount();
  keys: unknown[] = [{ public_key: 'ed25519:abc' }];
  fail: Error | null = null;

  async callFunction({ contractId, method, args }: { contractId: string; method: string; args: Record<string, unknown> }): Promise<unknown> {
    expect(contractId).toBe(CONTRACT);
    this.calls.push({ method, args });
    if (this.fail) throw this.fail;
    switch (method) {
      case 'get_config':
        return RAW_CONFIG;
      case 'get_state':
        return RAW_STATE;
      case 'get_account':
        return this.account;
      case 'storage_balance_bounds':
        return { min: '1250000000000000000000', max: '1250000000000000000000' };
      case 'get_history_len':
        return 2;
      case 'get_history':
        return [
          { kind: 'saved', round: 4, hero: 'a.testnet', cost: '63252926967402900000', ms_left: 33420 },
          { kind: 'collapsed', first_round: 5, last_round: 6, count: 2, it: 'a.testnet', paid: '1500000000000000000000' },
        ];
      case 'get_heroes':
        return [{ account_id: 'a.testnet', saves: 3, burned: '262701307938924568377', collected: '5' }];
      default:
        throw new Error(`unexpected view ${method}`);
    }
  }

  async viewAccessKeyList({ accountId }: { accountId: string }): Promise<{ keys: unknown[] }> {
    expect(accountId).toBe(CONTRACT);
    return { keys: this.keys };
  }
}

class FakeSigner implements ChainSigner {
  readonly accountId = 'guest-abc12345.testnet';
  readonly kind = 'guest' as const;
  sent: FunctionCall[] = [];
  next: TxOutcome | Error = { txHash: 'HASH1', logs: [] };

  async call(call: FunctionCall): Promise<TxOutcome> {
    this.sent.push(call);
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

function setUp() {
  const provider = new FakeProvider();
  const signer = new FakeSigner();
  const client = new NearClient({ contractId: CONTRACT, provider });
  client.setSigner(signer);
  return { provider, signer, client };
}

describe('view conversions', () => {
  it('turns decimal strings into bigint and snake_case into camelCase', () => {
    const s = toStateView(RAW_STATE);
    expect(s.nowNs).toBe(1794616255419893527n);
    expect(s.roundEndNs - s.roundStartNs).toBe(180_000_000_000n);
    expect(s.costNow).toBe(165414499333470290427n);
    expect(s.it).toBe('usurper.testnet');
    expect(s.armed).toBe(true);
    expect(s.collapseRun).toBe(0);
    expect(s.stats.totalBurned).toBe(389685953959086608763n);
    expect(s.stats.totalPaid).toBe(0n);
    expect(s.stats.closestCallMs).toBe(27948);

    const c = toConfigView(RAW_CONFIG);
    expect(c.roundNs).toBe(180_000_000_000n);
    expect(c.claimAmount).toBe(1000n * 10n ** 18n);
    expect(c.maxCollapseRun).toBe(8);

    expect(toAccountView(rawAccount({ balance: '42', collected: '7', is_it: true }))).toEqual({
      registered: false,
      claimed: false,
      balance: 42n,
      saves: 0,
      burned: 0n,
      collected: 7n,
      isIt: true,
    });
    expect(toHero({ account_id: 'a.testnet', saves: 1, burned: '2', collected: '3' })).toEqual({
      accountId: 'a.testnet',
      saves: 1,
      burned: 2n,
      collected: 3n,
    });
    expect(toHistoryEntry({ kind: 'collapsed', first_round: 5, last_round: 6, count: 2, it: 'x', paid: '9' })).toEqual({
      kind: 'collapsed',
      firstRound: 5,
      lastRound: 6,
      count: 2,
      it: 'x',
      paid: 9n,
    });
  });

  it('reads every view through the provider', async () => {
    const { client, provider } = setUp();
    expect((await client.getConfig()).cutPpm).toBe(150000);
    expect((await client.getState()).round).toBe(7);
    expect((await client.getAccount('bob.testnet')).registered).toBe(false);
    expect(await client.getHistoryLen()).toBe(2);
    const history = await client.getHistory(0, 500);
    expect(history[0]).toEqual({ kind: 'saved', round: 4, hero: 'a.testnet', cost: 63252926967402900000n, msLeft: 33420 });
    expect((await client.getHeroes(0, 100))[0]!.burned).toBe(262701307938924568377n);
    // The limit is clamped to what the contract allows, and argument names are snake_case.
    expect(provider.calls.find((c) => c.method === 'get_history')!.args).toEqual({ from_index: 0, limit: 100 });
    expect(provider.calls.find((c) => c.method === 'get_account')!.args).toEqual({ account_id: 'bob.testnet' });
  });

  it('loads a lazy provider once', async () => {
    let loads = 0;
    const provider = new FakeProvider();
    const client = new NearClient({
      contractId: CONTRACT,
      provider: async () => {
        loads += 1;
        return provider;
      },
    });
    await Promise.all([client.getState(), client.getConfig()]);
    await client.getState();
    expect(loads).toBe(1);
  });
});

describe('claim', () => {
  it('attaches the storage fee read from the contract when the account is not registered', async () => {
    const { client, provider, signer } = setUp();
    provider.account = rawAccount({ registered: false });
    const res = await client.claim();
    expect(res).toEqual({ ok: true, txHash: 'HASH1' });
    expect(signer.sent).toEqual([{ contractId: CONTRACT, method: 'claim', args: {}, deposit: 1250000000000000000000n, gasTera: 30 }]);
    expect(provider.calls.map((c) => c.method)).toEqual(['get_account', 'storage_balance_bounds']);
    expect(provider.calls[0]!.args).toEqual({ account_id: signer.accountId });
  });

  it('attaches nothing when the account is already registered', async () => {
    const { client, provider, signer } = setUp();
    provider.account = rawAccount({ registered: true });
    await client.claim();
    expect(signer.sent[0]!.deposit).toBe(0n);
    expect(provider.calls.map((c) => c.method)).toEqual(['get_account']);
  });

  it('needs an account', async () => {
    const { client } = setUp();
    client.setSigner(null);
    const res = await client.claim();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('ERR_NO_ACCOUNT');
    expect(client.accountId()).toBeNull();
  });
});

describe('volunteer', () => {
  const LOG =
    'EVENT_JSON:{"standard":"notit","version":"1.0.0","event":"round_saved","data":{"round":7,"hero":"guest-abc12345.testnet","cost":"68348380971521668377","ms_left":37633}}';

  it('sends both guards and reads cost and time left from the round_saved event', async () => {
    const { client, signer } = setUp();
    signer.next = {
      txHash: 'HASH2',
      logs: ['EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_burn","data":[{"owner_id":"x","amount":"1"}]}', LOG],
      returnValue: '68348380971521668377',
    };
    const res = await client.volunteer({ round: 7, maxCost: 70000000000000000000n });
    expect(res).toEqual({ ok: true, txHash: 'HASH2', cost: 68348380971521668377n, msLeft: 37633 });
    expect(signer.sent[0]).toEqual({
      contractId: CONTRACT,
      method: 'volunteer',
      args: { round: 7, max_cost: '70000000000000000000' },
      deposit: 0n,
      gasTera: 30,
    });
  });

  it('falls back to the return value when there is no event', async () => {
    const { client, signer } = setUp();
    signer.next = { txHash: 'HASH3', logs: ['something else'], returnValue: '123' };
    const res = await client.volunteer({ round: 7, maxCost: 200n });
    expect(res).toEqual({ ok: true, txHash: 'HASH3', cost: 123n, msLeft: undefined });
  });

  it('parses round_saved with the data as an object or a one-element array', () => {
    expect(parseRoundSaved([LOG])).toEqual({ round: 7, hero: 'guest-abc12345.testnet', cost: 68348380971521668377n, msLeft: 37633 });
    expect(
      parseRoundSaved(['EVENT_JSON:{"standard":"notit","event":"round_saved","data":[{"round":1,"hero":"h","cost":"5","ms_left":9}]}']),
    ).toEqual({ round: 1, hero: 'h', cost: 5n, msLeft: 9 });
    expect(parseRoundSaved(['EVENT_JSON:not json', 'plain log', 'EVENT_JSON:{"standard":"notit","event":"rounds_closed","data":{}}'])).toBeNull();
  });
});

describe('errors', () => {
  const cases: Array<[string, string]> = [
    ['Smart contract panicked: ERR_ALREADY_SAVED', 'ERR_ALREADY_SAVED'],
    ['{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ERR_WRONG_ROUND: got 6"}}}}', 'ERR_WRONG_ROUND'],
    ['ERR_COST_TOO_HIGH', 'ERR_COST_TOO_HIGH'],
    ['panicked at ERR_INSUFFICIENT', 'ERR_INSUFFICIENT'],
    ['ERR_NOTHING_TO_SAVE', 'ERR_NOTHING_TO_SAVE'],
    ['ERR_ALREADY_CLAIMED', 'ERR_ALREADY_CLAIMED'],
  ];

  for (const [text, code] of cases) {
    it(`maps a refused call to ${code}`, async () => {
      const { client, signer } = setUp();
      signer.next = new TxFailure(text, 'FAILHASH');
      const res = await client.volunteer({ round: 7, maxCost: 1n });
      expect(res).toEqual({ ok: false, code, message: describeError(code), txHash: 'FAILHASH' });
    });
  }

  it('has plain words for every graceful case', () => {
    expect(describeError('ERR_ALREADY_SAVED')).toMatch(/beat you to it/i);
    expect(describeError('ERR_ALREADY_SAVED')).toMatch(/paid nothing/i);
    expect(isGentle('ERR_ALREADY_SAVED')).toBe(true);
    expect(isGentle('ERR_INSUFFICIENT')).toBe(false);
    expect(describeError('ERR_SOMETHING_NEW')).toMatch(/did not go through/i);
  });

  it('recognises network trouble, a cancelled wallet prompt and an empty account', () => {
    expect(errorCode(new TypeError('Failed to fetch'))).toBe('ERR_NETWORK');
    expect(errorCode(new Error('Exceeded 2 providers to execute request'))).toBe('ERR_NETWORK');
    expect(errorCode(new Error('User rejected the request'))).toBe('ERR_REJECTED');
    expect(errorCode({ type: 'NotEnoughBalance' })).toBe('ERR_NO_GAS');
    expect(errorCode(new Error('who knows'))).toBe('ERR_UNKNOWN');
  });

  it('finds the code and the hash in the error near-api-js really throws', () => {
    // Shape observed on testnet for a second claim from the same account.
    const real = Object.assign(new Error('Contract panicked: ERR_ALREADY_CLAIMED'), {
      name: 'HostGuestPanicError',
      blockHash: '91CSbrjvUS8MFM2kHYRki9tBZEnwJYHHbXn7fBcjzmEq',
      blockHeight: -1,
      panicMessage: 'ERR_ALREADY_CLAIMED',
      transactionResult: {
        final_execution_status: 'EXECUTED_OPTIMISTIC',
        receipts_outcome: [],
        transaction: { hash: 'REALHASH' },
        transaction_outcome: { id: 'REALHASH' },
      },
    });
    expect(errorCode(real)).toBe('ERR_ALREADY_CLAIMED');
    expect(errorTxHash(real)).toBe('REALHASH');
    expect(errorTxHash(new Error('plain'))).toBeUndefined();
  });

  it('reports a failed view as a failed claim, not a crash', async () => {
    const { client, provider, signer } = setUp();
    provider.fail = new TypeError('Failed to fetch');
    const res = await client.claim();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('ERR_NETWORK');
    expect(signer.sent).toEqual([]);
  });
});

describe('transaction outcomes', () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');

  it('collects the hash, the logs of every receipt and the return value', () => {
    const out = outcomeToTx({
      transaction: { hash: 'TX' },
      status: { SuccessValue: b64('68348380971521668377') },
      receipts_outcome: [{ outcome: { logs: ['one'], status: { SuccessValue: '' } } }, { outcome: { logs: ['two', 'three'] } }],
    });
    expect(out).toEqual({ txHash: 'TX', logs: ['one', 'two', 'three'], returnValue: '68348380971521668377' });
    expect(outcomeToTx({ transaction_outcome: { id: 'TX2' }, status: { SuccessValue: '' }, receipts_outcome: [] })).toEqual({
      txHash: 'TX2',
      logs: [],
      returnValue: undefined,
    });
  });

  it('throws with the hash when the transaction or a receipt failed', () => {
    const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: ERR_ALREADY_SAVED' } } } };
    for (const raw of [
      { transaction: { hash: 'TX' }, status: { Failure: failure }, receipts_outcome: [] },
      { transaction: { hash: 'TX' }, status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { logs: [], status: { Failure: failure } } }] },
    ]) {
      try {
        outcomeToTx(raw);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(TxFailure);
        expect((e as TxFailure).txHash).toBe('TX');
        expect(errorCode(e)).toBe('ERR_ALREADY_SAVED');
      }
    }
  });
});

describe('lock status and poke', () => {
  it('is locked only when the contract account has no access keys', async () => {
    const { client, provider } = setUp();
    expect(await client.getLockStatus()).toEqual({ locked: false, keys: 1 });
    provider.keys = [];
    expect(await client.getLockStatus()).toEqual({ locked: true, keys: 0 });
  });

  it('pokes without a deposit', async () => {
    const { client, signer } = setUp();
    signer.next = { txHash: 'P', logs: [], returnValue: 2 };
    expect(await client.poke()).toEqual({ ok: true, txHash: 'P', settled: 2 });
    expect(signer.sent[0]).toMatchObject({ method: 'poke', deposit: 0n });
  });
});

describe('configuration', () => {
  const file = {
    network: 'testnet',
    rpcUrls: ['https://a.example', 'https://b.example'],
    faucetUrl: 'https://faucet.example/account',
    explorer: 'https://explorer.example/',
    contracts: [
      { id: 'one.testnet', label: 'Fast', note: '3-minute rounds' },
      { id: 'two.testnet', label: 'Live' },
    ],
  };

  it('reads the deployments file', () => {
    const c = readChainConfig({}, file)!;
    expect(c.contracts.map((x) => x.id)).toEqual(['one.testnet', 'two.testnet']);
    expect(c.rpcUrls).toEqual(['https://a.example', 'https://b.example']);
    expect(c.explorer).toBe('https://explorer.example');
    expect(c.pollMs).toBe(3000);
    expect(txUrl(c, 'HASH')).toBe('https://explorer.example/txns/HASH');
  });

  it('lets VITE_CONTRACT_ID override the list with a single contract', () => {
    const c = readChainConfig({ VITE_CONTRACT_ID: ' mine.testnet ', VITE_RPC_URL: 'https://c.example', VITE_POLL_MS: '5000' }, file)!;
    expect(c.contracts).toEqual([{ id: 'mine.testnet', label: 'Custom' }]);
    expect(c.rpcUrls[0]).toBe('https://c.example');
    expect(c.pollMs).toBe(5000);
  });

  it('means Demo mode only when no contract is listed', () => {
    expect(readChainConfig({}, { contracts: [] })).toBeNull();
    expect(readChainConfig({}, {})).toBeNull();
  });

  it('names guests guest-<8 base36 characters>.testnet', () => {
    const id = randomGuestId('testnet', () => new Uint8Array([0, 35, 36, 71, 255, 10, 9, 100]));
    expect(id).toBe('guest-0z0z3a9s.testnet');
    expect(randomGuestId('testnet')).toMatch(/^guest-[0-9a-z]{8}\.testnet$/);
  });
});

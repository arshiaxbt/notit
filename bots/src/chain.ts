// Thin NEAR testnet client for the bots: views, calls, and faucet-funded account creation.

import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";

export const RPC_URLS = (
  process.env.NEAR_RPC_URLS ??
  "https://near-testnet.drpc.org,https://test.rpc.fastnear.com,https://api.zan.top/near-testnet,https://testnet-rpc.intea.rs"
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

/** Testnet faucet service used by `near account create-account sponsor-by-faucet-service`. */
export const FAUCET_URL = process.env.NEAR_FAUCET_URL ?? "https://helper.nearprotocol.com/account";

/** Fixed NEP-145 registration fee of the contract, in yoctoNEAR. */
export const STORAGE_FEE = 5_000_000_000_000_000_000_000n;

const providers = RPC_URLS.map((url) => new JsonRpcProvider({ url }));

/** Used for signing and sending transactions. */
export const provider = new FailoverRpcProvider(providers);

/**
 * Run a read against each RPC endpoint in turn, twice over, with a short pause.
 * Public endpoints rate-limit by IP (HTTP 429); a refused read should move on to
 * the next endpoint, not crash.
 */
export async function read<T>(call: (rpc: JsonRpcProvider) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 2 * providers.length; attempt++) {
    try {
      return await call(providers[attempt % providers.length]);
    } catch (error) {
      last = error;
      await sleep(400 * (attempt + 1));
    }
  }
  throw last;
}

/** Number of access keys on an account; 0 means nobody can ever sign for it. */
export async function accessKeyCount(accountId: string): Promise<number> {
  const list = await read((rpc) => rpc.viewAccessKeyList({ accountId }));
  return list.keys.length;
}

export interface Stats {
  rounds_saved: number;
  rounds_collapsed: number;
  current_streak: number;
  longest_streak: number;
  closest_call_ms: number | null;
  total_burned: string;
  total_paid: string;
}

export interface State {
  now_ns: string;
  round: number;
  round_start_ns: string;
  round_end_ns: string;
  saved: boolean;
  hero: string | null;
  it: string | null;
  armed: boolean;
  collapse_run: number;
  cost_now: string;
  round_supply: string;
  total_supply: string;
  index: string;
  scale: number;
  claims_made: number;
  claim_open: boolean;
  stats: Stats;
}

export interface Config {
  round_ns: string;
  max_cost_ppm: number;
  min_cost_ppm: number;
  cut_ppm: number;
  claim_amount: string;
  claim_cap: number;
  genesis_ns: string;
  decimals: number;
  max_collapse_run: number;
}

export interface AccountView {
  registered: boolean;
  claimed: boolean;
  balance: string;
  saves: number;
  burned: string;
  collected: string;
  is_it: boolean;
}

export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await read((rpc) => rpc.callFunction({ contractId, method, args }))) as T;
}

export const getState = (contractId: string) => view<State>(contractId, "get_state");
export const getConfig = (contractId: string) => view<Config>(contractId, "get_config");
export const getAccount = (contractId: string, accountId: string) =>
  view<AccountView>(contractId, "get_account", { account_id: accountId });

export function signer(accountId: string, secretKey: string): Account {
  return new Account(accountId, provider, secretKey as KeyPairString);
}

export async function claim(account: Account, contractId: string): Promise<void> {
  await account.callFunction({
    contractId,
    methodName: "claim",
    args: {},
    gas: teraToGas("30"),
    deposit: STORAGE_FEE,
  });
}

/** Volunteer with both guards, so a late transaction cannot land in the wrong round or overpay. */
export async function volunteer(account: Account, contractId: string, round: number, maxCost: bigint): Promise<void> {
  await account.callFunction({
    contractId,
    methodName: "volunteer",
    args: { round, max_cost: maxCost.toString() },
    gas: teraToGas("30"),
    deposit: 0n,
  });
}

/** NEP-141 transfer (needs exactly 1 yoctoNEAR). */
export async function transfer(account: Account, contractId: string, receiverId: string, amount: bigint): Promise<void> {
  await account.callFunction({
    contractId,
    methodName: "ft_transfer",
    args: { receiver_id: receiverId, amount: amount.toString(), memo: "fleet re-deal" },
    gas: teraToGas("30"),
    deposit: 1n,
  });
}

export async function poke(account: Account, contractId: string): Promise<void> {
  await account.callFunction({ contractId, methodName: "poke", args: {}, gas: teraToGas("30"), deposit: 0n });
}

/** Create a testnet account funded by the public faucet. Returns its secret key. */
export async function createFaucetAccount(accountId: string): Promise<string> {
  const keyPair = KeyPair.fromRandom("ed25519");
  const response = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
  });
  if (!response.ok) {
    throw new Error(`faucet refused ${accountId}: HTTP ${response.status} ${await response.text()}`);
  }
  return keyPair.toString();
}

/** Short reason from a failed call: the contract's ERR_* code when there is one. */
export function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return /ERR_[A-Z_]+/.exec(text)?.[0] ?? text.slice(0, 160);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 10^18 units → "1,234.56". */
export function fmt(units: string | bigint): string {
  const value = BigInt(units);
  const whole = value / 10n ** 18n;
  const cents = (value % 10n ** 18n) / 10n ** 16n;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

/**
 * Chain configuration. The list of deployed contracts is data, not code:
 * `src/deployments.json` is committed and edited when a new contract goes
 * live. `VITE_CONTRACT_ID` (build-time) overrides it with a single contract.
 * With no contract at all the app runs in Demo mode only.
 */
import deploymentsFile from '../deployments.json';

export type NetworkId = 'testnet' | 'mainnet';

export interface Deployment {
  id: string;
  label: string;
  note?: string;
}

export interface DeploymentsFile {
  network?: string;
  rpcUrls?: string[];
  faucetUrl?: string;
  explorer?: string;
  contracts?: Deployment[];
}

export interface ChainConfig {
  network: NetworkId;
  /** Tried in order; the next one is used when one fails. */
  rpcUrls: string[];
  /** Testnet helper that creates faucet-funded accounts (guest play). */
  faucetUrl: string;
  /** Block explorer base URL, no trailing slash. */
  explorer: string;
  contracts: Deployment[];
  /** Poll interval for views, ms. */
  pollMs: number;
  /**
   * New guests swap their full-access key for keys that can only volunteer.
   * On unless switched off (VITE_SESSION_KEYS=off).
   */
  sessionKeys?: boolean;
}

const DEFAULT_RPC: Record<NetworkId, string[]> = {
  testnet: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
  mainnet: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
};

function clean(v: string | undefined): string {
  return (v ?? '').trim();
}

/** Returns null when no contract is configured (Demo mode only). */
export function readChainConfig(
  env: Partial<ImportMetaEnv> = import.meta.env,
  file: DeploymentsFile = deploymentsFile,
): ChainConfig | null {
  const override = clean(env.VITE_CONTRACT_ID);
  const contracts: Deployment[] = override
    ? [{ id: override, label: 'Custom' }]
    : (file.contracts ?? []).filter((c) => clean(c.id) !== '').map((c) => ({ ...c, id: clean(c.id) }));
  if (contracts.length === 0) return null;

  const network: NetworkId = (clean(env.VITE_NETWORK) || clean(file.network)) === 'mainnet' ? 'mainnet' : 'testnet';
  const envRpc = clean(env.VITE_RPC_URL);
  const fileRpc = (file.rpcUrls ?? []).map(clean).filter(Boolean);
  const rpcUrls = envRpc ? [envRpc, ...fileRpc.filter((u) => u !== envRpc)] : fileRpc.length > 0 ? fileRpc : DEFAULT_RPC[network];
  const poll = Number(clean(env.VITE_POLL_MS));

  return {
    network,
    rpcUrls,
    faucetUrl: clean(file.faucetUrl) || 'https://helper.nearprotocol.com/account',
    explorer: (clean(file.explorer) || `https://${network === 'mainnet' ? '' : 'testnet.'}nearblocks.io`).replace(/\/+$/, ''),
    contracts,
    pollMs: Number.isFinite(poll) && poll >= 500 ? poll : 3000,
    sessionKeys: clean(env.VITE_SESSION_KEYS).toLowerCase() !== 'off',
  };
}

export const chainConfig: ChainConfig | null = readChainConfig();

export function txUrl(config: ChainConfig, hash: string): string {
  return `${config.explorer}/txns/${hash}`;
}

export function accountUrl(config: ChainConfig, accountId: string): string {
  return `${config.explorer}/address/${accountId}`;
}

/** The explorer's list of an account's access keys. */
export function accessKeysUrl(config: ChainConfig, accountId: string): string {
  return `${config.explorer}/address/${accountId}?tab=accesskeys`;
}

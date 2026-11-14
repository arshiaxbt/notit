/**
 * Wallet login through @hot-labs/near-connect. The connector is loaded with a
 * dynamic import the first time someone asks for a wallet (or had one
 * connected last time), so it costs nothing otherwise. It fetches its wallet
 * list from the network and shows its own picker.
 */
import type { NearConnector } from '@hot-labs/near-connect';
import type { NetworkId } from './config';
import { TxFailure, errorTxHash, outcomeToTx } from './NearClient';
import type { ChainSigner, FunctionCall, TxOutcome } from './NearClient';

const connectors = new Map<NetworkId, Promise<NearConnector>>();

export function loadConnector(network: NetworkId): Promise<NearConnector> {
  let p = connectors.get(network);
  if (!p) {
    p = import('@hot-labs/near-connect').then(async (mod) => {
      const connector = new mod.NearConnector({ network, footerBranding: null });
      // The wallet list comes from a manifest on the network; wait for it once.
      await Promise.race([connector.whenManifestLoaded, new Promise((resolve) => setTimeout(resolve, 8000))]);
      return connector;
    });
    p.catch(() => connectors.delete(network));
    connectors.set(network, p);
  }
  return p;
}

function signerFor(connector: NearConnector, network: NetworkId, accountId: string): ChainSigner {
  return {
    accountId,
    kind: 'wallet',
    async call(call: FunctionCall): Promise<TxOutcome> {
      try {
        const wallet = await connector.wallet();
        const outcome = await wallet.signAndSendTransaction({
          network,
          signerId: accountId,
          receiverId: call.contractId,
          actions: [
            {
              type: 'FunctionCall',
              params: {
                methodName: call.method,
                args: call.args,
                gas: (BigInt(call.gasTera) * 10n ** 12n).toString(),
                deposit: call.deposit.toString(),
              },
            },
          ],
        });
        return outcomeToTx(outcome);
      } catch (e) {
        if (e instanceof TxFailure) throw e;
        const text = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === 'string' ? e : JSON.stringify(e);
        throw new TxFailure(text || 'The wallet did not send the transaction.', errorTxHash(e));
      }
    },
  };
}

/** How many wallets the picker can offer on this network (0 means login cannot work). */
export async function availableWallets(network: NetworkId): Promise<number> {
  const connector = await loadConnector(network);
  return connector.availableWallets.length;
}

/** Opens the wallet picker and resolves once an account is connected. */
export async function connectWallet(network: NetworkId): Promise<ChainSigner> {
  const connector = await loadConnector(network);
  if (connector.availableWallets.length === 0) {
    throw new Error('No wallets are available for this network right now.');
  }
  const wallet = await connector.connect();
  const accounts = await wallet.getAccounts({ network });
  const first = accounts[0];
  if (!first) throw new Error('The wallet did not share an account.');
  return signerFor(connector, network, first.accountId);
}

/** The wallet that was connected last time, if it still is. */
export async function restoreWallet(network: NetworkId): Promise<ChainSigner | null> {
  try {
    const connector = await loadConnector(network);
    const { accounts } = await connector.getConnectedWallet();
    const first = accounts[0];
    return first ? signerFor(connector, network, first.accountId) : null;
  } catch {
    return null;
  }
}

export async function disconnectWallet(network: NetworkId): Promise<void> {
  try {
    const connector = await loadConnector(network);
    await connector.disconnect();
  } catch {
    /* already disconnected */
  }
}

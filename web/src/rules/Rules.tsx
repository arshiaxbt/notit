import type { LockState } from '../client/session';
import type { ConfigView } from '../client/types';
import type { Mode } from '../components/Header';
import { Card } from '../components/ui';
import { formatCountdown, formatInt, formatPpm, formatToken } from '../lib/format';

interface Props {
  config: ConfigView | null;
  mode: Mode;
  /** In Testnet mode: whether the selected contract account still has access keys. */
  lock: LockState | null;
}

/** The `fast` instance from SPEC §2, used until the live config has loaded. */
const FALLBACK: ConfigView = {
  roundNs: 180n * 1_000_000_000n,
  maxCostPpm: 50_000,
  minCostPpm: 2_000,
  cutPpm: 150_000,
  claimAmount: 1_000n * 10n ** 18n,
  claimCap: 100_000,
  genesisNs: 0n,
  decimals: 18,
  maxCollapseRun: 8,
};

function roundLength(ns: bigint): string {
  const seconds = Number(ns / 1_000_000_000n);
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return formatCountdown(seconds * 1000);
}

export function Rules({ config, mode, lock }: Props) {
  const unlocked = lock?.status === 'open';
  const c = config ?? FALLBACK;
  const max = formatPpm(c.maxCostPpm);
  const min = formatPpm(c.minCostPpm);
  const cut = formatPpm(c.cutPpm);
  const run = c.maxCollapseRun;
  const claim = formatToken(c.claimAmount);

  const rows: Array<[label: string, code: string, value: string]> = [
    ['Round length', 'round_ns', roundLength(c.roundNs)],
    ['Cost at round open', 'max_cost_ppm', `${max} of supply`],
    ['Cost at the deadline', 'min_cost_ppm', `${min} of supply`],
    ['Cut paid to It', 'cut_ppm', cut],
    ['Unsaved rounds charged in a row', 'MAX_COLLAPSE_RUN', String(run)],
    ['Faucet claim per account', 'claim_amount', `${claim} NOTIT`],
    ['Faucet claims in total', 'claim_cap', formatInt(c.claimCap)],
  ];

  return (
    <div className="page">
      <header className="page__head">
        <h1 className="page__title">
          Five rules. <span className="pitch__hl">Nobody can change them.</span>
        </h1>
      </header>

      <ol className="rules">
        <li className="rule">
          <h2>
            Time is split into rounds of {roundLength(c.roundNs)}
            {mode === 'demo' ? ', sped up in the demo' : ''}.
          </h2>
        </li>
        <li className="rule">
          <h2>
            In each round the cost to volunteer falls from {max} of the supply to {min}.
          </h2>
        </li>
        <li className="rule">
          <h2>The first to volunteer burns that cost, saves the round and becomes It.</h2>
        </li>
        <li className="rule">
          <h2>
            If nobody does, every balance is cut {cut} and It collects it, for at most {run} rounds in a row.
          </h2>
        </li>
        <li className="rule">
          <div>
            <h2>Nobody can change these rules: the contract has no admin and its account has no keys.</h2>
            {unlocked && <p>Not locked yet: this contract account still has an access key.</p>}
            {lock?.status === 'locked' && <p>Checked just now: this contract account has no access keys.</p>}
          </div>
        </li>
      </ol>

      <p className="rules__stakes">
        A save moves value from the volunteer to everyone else. An unsaved round moves value from everyone to It.
      </p>

      <div className="rules__cols">
        <Card labelId="params-title" title="The numbers">
          <div className="tablewrap" tabIndex={0} role="region" aria-label="Table of the numbers">
            <table className="table">
              <tbody>
                {rows.map(([label, code, value]) => (
                  <tr key={code}>
                    <th scope="row" title={code}>
                      {label}
                    </th>
                    <td className="num">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card labelId="limits-title" title="Limits">
          <ul className="bullets">
            <li>Testnet only: test tokens, no value.</li>
            <li>The faucet can be farmed with many accounts.</li>
            <li>A volunteer sent in the last seconds can land too late.</li>
            <li>A guest's browser key can only volunteer.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

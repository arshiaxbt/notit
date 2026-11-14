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
  onPlay(): void;
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

export function Rules({ config, mode, lock, onPlay }: Props) {
  const unlocked = lock?.status === 'open';
  const c = config ?? FALLBACK;
  const max = formatPpm(c.maxCostPpm);
  const min = formatPpm(c.minCostPpm);
  const cut = formatPpm(c.cutPpm);
  const run = c.maxCollapseRun;
  const claim = formatToken(c.claimAmount);

  return (
    <div className="page">
      <header className="page__head">
        <h1 className="page__title">
          Five rules. <span className="pitch__hl">Nobody can change them.</span>
        </h1>
        <p className="page__lead">
          Everyone says “Not it!”. Whoever finally does it becomes It, and collects the next time the crowd fails.
        </p>
      </header>

      <ol className="rules">
        <li className="rule">
          <div>
            <h3>Time is split into rounds.</h3>
            <p>
              {mode === 'demo'
                ? `A round lasts ${roundLength(c.roundNs)} of game time. The demo clock runs it faster.`
                : `A round lasts ${roundLength(c.roundNs)}.`}{' '}
              When one ends the next begins at once, whether or not anyone is watching.
            </p>
          </div>
        </li>
        <li className="rule">
          <div>
            <h3>Each round has a price, and it falls.</h3>
            <p>
              The sacrifice cost opens at {max} of the supply and falls in a straight line to {min} at the deadline. Waiting
              makes it cheaper. Waiting too long means nobody does it.
            </p>
          </div>
        </li>
        <li className="rule">
          <div>
            <h3>The first to volunteer saves the round and becomes It.</h3>
            <p>
              They burn the current cost from their own balance. Those tokens are gone for good. Nobody else pays anything
              that round, and the volunteer is now It: the last person who did it.
            </p>
          </div>
        </li>
        <li className="rule">
          <div>
            <h3>If nobody does, everybody pays It.</h3>
            <p>
              When a round ends unsaved, every balance is cut by {cut} and the whole cut goes to It. At most {run} unsaved
              rounds in a row are charged. After that the game sleeps until somebody volunteers again. Before the first
              volunteer ever, there is no It and nothing is charged.
            </p>
          </div>
        </li>
        <li className="rule">
          <div>
            <h3>Nobody can change the rules.</h3>
            <p>
              Every number on this page is fixed when the contract is deployed. The contract has no owner role, no admin
              method and no upgrade switch, and a locked deployment has no access keys left on its account.
            </p>
            {unlocked && (
              <p>
                <b>Not yet true here:</b> the account of the contract you are looking at still has an access key, so
                whoever holds it could redeploy. Locking the contract means deleting that key.
              </p>
            )}
            {lock?.status === 'locked' && (
              <p>
                <b>Checked just now:</b> this contract account has no access keys.
              </p>
            )}
          </div>
        </li>
      </ol>

      <Card labelId="stakes-title" title="Why the stakes are real">
        <div className="prose">
          <p>
            Neither outcome is a bookkeeping trick that treats everyone alike. <b>A save moves value from the volunteer to
            everyone else</b>: the volunteer’s tokens are burned, so every other holder owns a slightly bigger share of
            what is left. <b>A collapse moves value from everyone to It</b>: each holder loses {cut}, and one account
            receives all of it. So doing it costs you now and can pay you later, and saying “Not it!” is free until the
            round nobody steps up.
          </p>
        </div>
      </Card>

      <div className="rules__cols">
        <Card labelId="params-title" title="The numbers" aside={<span className="card__note">fixed at deployment</span>}>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Parameter</th>
                  <th scope="col" className="num">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">
                    Round length
                    <span className="table__sub">
                      <code>round_ns</code> · 3 minutes on the fast instance, 1 hour on the live one
                    </span>
                  </th>
                  <td className="num">{roundLength(c.roundNs)}</td>
                </tr>
                <tr>
                  <th scope="row">
                    Cost when a round opens
                    <span className="table__sub">
                      <code>max_cost_ppm</code> · share of the supply at round open
                    </span>
                  </th>
                  <td className="num">{max}</td>
                </tr>
                <tr>
                  <th scope="row">
                    Cost at the deadline
                    <span className="table__sub">
                      <code>min_cost_ppm</code>
                    </span>
                  </th>
                  <td className="num">{min}</td>
                </tr>
                <tr>
                  <th scope="row">
                    Cut paid to It after an unsaved round
                    <span className="table__sub">
                      <code>cut_ppm</code> · taken from every balance
                    </span>
                  </th>
                  <td className="num">{cut}</td>
                </tr>
                <tr>
                  <th scope="row">
                    Unsaved rounds charged in a row
                    <span className="table__sub">
                      <code>MAX_COLLAPSE_RUN</code> · then dormant until a volunteer
                    </span>
                  </th>
                  <td className="num">{run}</td>
                </tr>
                <tr>
                  <th scope="row">
                    Faucet claim, once per account
                    <span className="table__sub">
                      <code>claim_amount</code>
                    </span>
                  </th>
                  <td className="num">{claim} NOTIT</td>
                </tr>
                <tr>
                  <th scope="row">
                    Claims ever
                    <span className="table__sub">
                      <code>claim_cap</code>
                    </span>
                  </th>
                  <td className="num">{formatInt(c.claimCap)}</td>
                </tr>
                <tr>
                  <th scope="row">Decimals</th>
                  <td className="num">{c.decimals}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        <div className="page" style={{ gap: 'var(--space-4)' }}>
          <Card labelId="cannot-title" title="What this cannot do">
            <ul className="bullets bullets--no">
              <li>
                <b>No admin key.</b> Nobody can pause the game, change a rate, or move anyone’s tokens.
                {unlocked ? ' (On this contract the account key has not been deleted yet.)' : ''}
              </li>
              <li>
                <b>No changes after deployment.</b> The rules and every number above are set once.
              </li>
              <li>
                <b>No minting on the side.</b> New tokens only come from the faucet claim, capped at {formatInt(c.claimCap)}{' '}
                claims. A collapse moves tokens to It; it does not create any.
              </li>
              <li>
                <b>No overpaying by accident.</b> When you volunteer, the app sends the round and the highest cost you
                agreed to. A late transaction is rejected instead of burning more.
              </li>
            </ul>
          </Card>

          <Card labelId="limits-title" title="Honest limits">
            <ul className="bullets">
              <li>
                <b>Testnet only.</b> NOTIT is a test token. It has no value and is not an investment of any kind.
              </li>
              <li>
                <b>The faucet can be farmed.</b> One claim per account does not stop one person making many accounts. On
                testnet that is acceptable; anywhere real it would not be.
              </li>
              <li>
                <b>Big holders carry more weight.</b> The cost is a share of the whole supply, so small holders may not be
                able to afford it early in a round.
              </li>
              <li>
                <b>Last-second saves depend on block timing.</b> A volunteer sent in the final seconds can land too late.
              </li>
              <li>
                <b>Demo mode is a simulation.</b> The crowd is made of bots with simple strategies. Real people may play
                very differently.
              </li>
            </ul>
          </Card>
        </div>
      </div>

      <p className="play__more">
        <button type="button" className="btn" onClick={onPlay}>
          Back to the round
        </button>
      </p>
    </div>
  );
}

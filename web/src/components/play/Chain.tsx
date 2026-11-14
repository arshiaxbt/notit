/** Testnet-mode pieces of the Play screen: the contract bar and the guest sign-up. */
import { accessKeysUrl, accountUrl, txUrl } from '../../client/config';
import type { ChainUi } from '../../hooks/useSession';
import { cls } from '../ui';

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="extlink" href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <span aria-hidden="true"> ↗</span>
      <span className="sr-only"> (opens the block explorer)</span>
    </a>
  );
}

function roundLength(note: string | undefined): string {
  return note ?? '';
}

/** What the guest key in this browser may do, linked to the account's key list on the explorer. */
export function KeyMark({ chain, account }: { chain: ChainUi; account: { id: string; key: 'full' | 'volunteer' | null } }) {
  if (!account.key) return null;
  return (
    <a className="keymark extlink" href={accessKeysUrl(chain.session.config, account.id)} target="_blank" rel="noreferrer noopener">
      {keyMarkText(account.key)}
      <span className="sr-only"> (opens the block explorer)</span>
    </a>
  );
}

export function keyMarkText(key: 'full' | 'volunteer'): string {
  return key === 'volunteer' ? 'key: volunteer only' : 'key: full access';
}

/** One line: the contract, whether it is locked, the round length, and the deployment switch. */
export function ChainBar({ chain }: { chain: ChainUi }) {
  const { session, state } = chain;
  const { config } = session;
  const { deployment, lock, account } = state;
  const contractUrl = accountUrl(config, deployment.id);

  let lockText: string;
  if (lock.status === 'locked') lockText = 'Locked: no access keys';
  else if (lock.status === 'open') lockText = `Not locked: ${lock.keys} access ${lock.keys === 1 ? 'key' : 'keys'}`;
  else if (lock.status === 'error') lockText = 'Lock not checked';
  else lockText = 'Checking lock…';

  return (
    <div className="chainbar">
      <p className="chainbar__row">
        <ExternalLink href={contractUrl}>
          <code>{deployment.id}</code>
        </ExternalLink>
        <span className={cls('lock', `lock--${lock.status}`)} role="status">
          <span className="lock__icon" aria-hidden="true">
            {lock.status === 'locked' ? (
              <svg viewBox="0 0 24 24" width="16" height="16">
                <rect x="4" y="10" width="16" height="11" rx="2.5" fill="currentColor" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2.6" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16">
                <rect x="4" y="10" width="16" height="11" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
                <path d="M8 10V7a4 4 0 0 1 7.5-2" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            )}
          </span>
          {lock.status === 'locked' || lock.status === 'open' ? <ExternalLink href={contractUrl}>{lockText}</ExternalLink> : lockText}
        </span>
        {config.contracts.length > 1 ? (
          <label className="chainbar__pick">
            <span className="sr-only">Deployment</span>
            <select value={deployment.id} onChange={(e) => session.selectContract(e.target.value)}>
              {config.contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.note ?? c.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span>{roundLength(deployment.note)}</span>
        )}
        {account?.kind === 'guest' && account.key && <KeyMark chain={chain} account={account} />}
        {account?.kind === 'guest' && (
          <button
            type="button"
            className="linkbtn chainbar__forget"
            title="Delete this guest account's key from this browser"
            onClick={() => {
              if (window.confirm('Forget this guest account? Its key exists only in this browser, so it cannot be recovered.')) {
                session.forgetGuest();
              }
            }}
          >
            Forget
          </button>
        )}
      </p>
    </div>
  );
}

/** A link to the last transaction on the explorer. */
export function TxLink({ chain, hash, label }: { chain: ChainUi; hash: string; label: string }) {
  return (
    <span className="txlink">
      <ExternalLink href={txUrl(chain.session.config, hash)}>{label}</ExternalLink>
    </span>
  );
}

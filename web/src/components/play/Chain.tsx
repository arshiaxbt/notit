/** Testnet-mode pieces of the Play screen: the contract bar and the guest sign-up. */
import { accountUrl, txUrl } from '../../client/config';
import type { GuestStep } from '../../client/session';
import type { ChainUi } from '../../hooks/useSession';
import { formatToken, shortAccount } from '../../lib/format';
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

/** Which contract this is, whether its rules are locked, and who you are playing as. */
export function ChainBar({ chain }: { chain: ChainUi }) {
  const { session, state } = chain;
  const { config } = session;
  const { deployment, lock, account } = state;

  let lockText: React.ReactNode;
  if (lock.status === 'locked') {
    lockText = (
      <>
        <b>Locked:</b> this contract account has no access keys, so nobody can change it.
      </>
    );
  } else if (lock.status === 'open') {
    lockText = (
      <>
        <b>Not locked yet:</b> this contract account still has {lock.keys} access {lock.keys === 1 ? 'key' : 'keys'}, so
        whoever holds {lock.keys === 1 ? 'it' : 'them'} could still change the contract.
      </>
    );
  } else if (lock.status === 'error') {
    lockText = 'Could not check whether the rules are locked.';
  } else {
    lockText = 'Checking whether the rules are locked…';
  }

  return (
    <div className="chainbar">
      <p className="chainbar__row">
        <span className="chip chip--accent">Testnet</span>
        <span>
          Live on NEAR {config.network}. Contract{' '}
          <ExternalLink href={accountUrl(config, deployment.id)}>
            <code>{deployment.id}</code>
          </ExternalLink>
          {deployment.note ? ` · ${deployment.note}` : ''}
        </span>
        {config.contracts.length > 1 && (
          <label className="chainbar__pick">
            <span className="sr-only">Deployment</span>
            <select value={deployment.id} onChange={(e) => session.selectContract(e.target.value)}>
              {config.contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.note ? ` · ${c.note}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </p>
      <p className={cls('chainbar__row', 'lock', `lock--${lock.status}`)} role="status">
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
        <span>{lockText}</span>
      </p>
      {account?.kind === 'guest' && (
        <p className="chainbar__row chainbar__guest">
          <span>
            You are playing as <b>{shortAccount(account.id)}</b>, a throwaway testnet account. Its key lives only in
            this browser.
          </span>
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              if (window.confirm('Forget this guest account? Its key exists only in this browser, so it cannot be recovered.')) {
                session.forgetGuest();
              }
            }}
          >
            Forget this guest account
          </button>
        </p>
      )}
    </div>
  );
}

const STEPS: Array<{ id: GuestStep; label: (claim: string) => string }> = [
  { id: 'account', label: () => 'Create a throwaway testnet account' },
  { id: 'confirm', label: () => 'Wait for the network to see it' },
  { id: 'claim', label: (claim) => `Claim ${claim} NOTIT` },
];

/**
 * The sign-in block shown in place of the main button while nobody is signed
 * in: one click to play as a guest, with its progress, or a wallet.
 */
export function GuestStart({ chain, claimAmount }: { chain: ChainUi; claimAmount: bigint }) {
  const { session, state } = chain;
  const { guest, wallet, restoring } = state;
  const running = guest.status === 'running';
  const failed = guest.status === 'error';
  const stored = session.storedGuestId();
  const activeIdx = guest.step ? STEPS.findIndex((s) => s.id === guest.step) : -1;
  const claim = formatToken(claimAmount);

  let label = 'Play as guest';
  if (restoring) label = 'Signing in…';
  else if (running) label = 'Setting up…';
  else if (failed) label = 'Try again';
  else if (stored) label = 'Continue as guest';

  return (
    <div className="guest">
      <button type="button" className="cta" disabled={running || restoring} onClick={() => void session.playAsGuest()}>
        <span className="cta__label">{label}</span>
        {!running && !restoring && (
          <span className="cta__sub">
            {stored && !failed ? shortAccount(stored) : `one click: a testnet account and ${claim} NOTIT`}
          </span>
        )}
      </button>

      {(running || failed) && (
        <ol className="steps" aria-label="Guest sign-up progress">
          {STEPS.map((s, i) => {
            const status = i < activeIdx ? 'done' : i === activeIdx ? (failed ? 'failed' : 'active') : 'todo';
            return (
              <li key={s.id} className={cls('steps__item', `steps__item--${status}`)}>
                <span className="steps__mark" aria-hidden="true">
                  {status === 'done' ? '✓' : status === 'failed' ? '!' : i + 1}
                </span>
                <span>
                  {s.label(claim)}
                  <span className="sr-only">
                    {status === 'done' ? ': done' : status === 'active' ? ': in progress' : status === 'failed' ? ': failed' : ''}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <div role="status" aria-live="polite">
        {running && <p className="cta__hint">This takes about ten seconds. The testnet faucet is doing the work.</p>}
        {failed && guest.error && <p className="cta__hint cta__hint--warn">{guest.error}</p>}
      </div>

      {!running && (
        <>
          <button type="button" className="btn guest__wallet" disabled={wallet.busy || restoring} onClick={() => void session.connectWallet()}>
            {wallet.busy ? 'Opening wallets…' : 'Connect a wallet'}
          </button>
          {wallet.error && (
            <p className="cta__hint cta__hint--warn" role="alert">
              {wallet.error}
            </p>
          )}
          <p className="cta__hint">
            A guest is a throwaway testnet account made for you. Its key is kept in this browser only. Watching needs no
            account at all.
          </p>
        </>
      )}
    </div>
  );
}

/** A link to the last transaction on the explorer. */
export function TxLink({ chain, hash, label }: { chain: ChainUi; hash: string; label: string }) {
  return (
    <p className="cta__hint txlink">
      {label} <ExternalLink href={txUrl(chain.session.config, hash)}>View transaction</ExternalLink>
    </p>
  );
}

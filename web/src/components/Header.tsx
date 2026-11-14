import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { ChainUi } from '../hooks/useSession';
import type { Theme } from '../hooks/useTheme';
import { shortAccount } from '../lib/format';

export type Tab = 'play' | 'lab' | 'rules';
export type Mode = 'demo' | 'testnet';

const TAB_LABELS: Record<Tab, string> = { play: 'Play', lab: 'Lab', rules: 'Rules' };
const ORDER: Tab[] = ['play', 'lab', 'rules'];

interface Props {
  tab: Tab;
  onTab(tab: Tab): void;
  mode: Mode;
  onMode(mode: Mode): void;
  testnetAvailable: boolean;
  network: string;
  /** Set in Testnet mode. */
  chain: ChainUi | null;
  theme: Theme;
  onToggleTheme(): void;
}

export function Logo() {
  return (
    <span className="logo" aria-label="Not It">
      <span className="logo__not" aria-hidden="true">
        Not
      </span>
      <span className="logo__it" aria-hidden="true">
        it!
      </span>
    </span>
  );
}

export function Header({ tab, onTab, mode, onMode, testnetAvailable, network, chain, theme, onToggleTheme }: Props) {
  const account = chain?.state.account ?? null;
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = ORDER.indexOf(tab);
    let next: Tab | null = null;
    if (e.key === 'ArrowRight') next = ORDER[(i + 1) % ORDER.length]!;
    else if (e.key === 'ArrowLeft') next = ORDER[(i + ORDER.length - 1) % ORDER.length]!;
    else if (e.key === 'Home') next = ORDER[0]!;
    else if (e.key === 'End') next = ORDER[ORDER.length - 1]!;
    if (next) {
      e.preventDefault();
      onTab(next);
      tabRefs.current[next]?.focus();
    }
  };

  return (
    <header className="top">
      <p className="ribbon">
        <span>{mode === 'demo' ? 'Demo' : network}</span>
        <span aria-hidden="true">·</span>
        <span>{mode === 'demo' ? 'simulated crowd' : 'test tokens'}</span>
        <span aria-hidden="true">·</span>
        <span>no value</span>
      </p>
      <div className="top__bar">
        <a
          className="top__home"
          href="#play"
          onClick={(e) => {
            e.preventDefault();
            onTab('play');
          }}
        >
          <Logo />
        </a>

        <div className="tabs" role="tablist" aria-label="Sections" onKeyDown={onKey}>
          {ORDER.map((t) => (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              id={`tab-${t}`}
              role="tab"
              type="button"
              className="tabs__tab"
              aria-selected={tab === t}
              aria-controls={`panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => onTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {chain && account && (
          <div className="acct">
            <span className="acct__id" title={account.id}>
              <span className="acct__kind">{account.kind === 'guest' ? 'Guest' : 'Wallet'}</span>
              {shortAccount(account.id)}
            </span>
            <button type="button" className="acct__out" onClick={() => void chain.session.signOut()}>
              Sign out
            </button>
          </div>
        )}

        <div className="top__tools">
          <div className="mode" role="group" aria-label="Mode">
            <button
              type="button"
              className="mode__opt"
              aria-pressed={mode === 'demo'}
              onClick={() => onMode('demo')}
              title="Demo: the game runs in your browser with a simulated crowd"
            >
              Demo
            </button>
            <button
              type="button"
              className="mode__opt"
              aria-pressed={mode === 'testnet'}
              disabled={!testnetAvailable}
              onClick={() => onMode('testnet')}
              title={testnetAvailable ? 'Testnet: the deployed contract' : 'Testnet mode switches on once the contract is deployed'}
            >
              Testnet
              {!testnetAvailable && <small>connecting soon</small>}
            </button>
          </div>
          <button
            type="button"
            className="iconbtn"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          >
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <circle cx="12" cy="12" r="4.5" fill="currentColor" />
                <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
                </g>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" fill="currentColor" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}

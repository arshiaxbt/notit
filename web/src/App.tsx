import { useCallback, useEffect, useMemo, useState } from 'react';
import { chainConfig } from './client/config';
import { MockClient } from './client/MockClient';
import { ChainSession } from './client/session';
import type { GameClient } from './client/types';
import { Header } from './components/Header';
import type { Mode, Tab } from './components/Header';
import { Play } from './components/play/Play';
import { useGame } from './hooks/useGame';
import { useSession } from './hooks/useSession';
import type { ChainUi } from './hooks/useSession';
import { useTheme } from './hooks/useTheme';
import { Lab } from './lab/Lab';
import { Rules } from './rules/Rules';

const TABS: Tab[] = ['play', 'lab', 'rules'];

function tabFromHash(): Tab {
  const h = window.location.hash.replace('#', '');
  return (TABS as string[]).includes(h) ? (h as Tab) : 'play';
}

/** Testnet when a contract is configured, unless the address says `?mode=demo`. */
function initialMode(testnetAvailable: boolean): Mode {
  const asked = new URLSearchParams(window.location.search).get('mode');
  if (asked === 'demo' || !testnetAvailable) return 'demo';
  return 'testnet';
}

function newDemo(roundSeconds?: number): MockClient {
  // The played-in history is the same for everyone; what happens next is not.
  return new MockClient({ roundSeconds, liveSeed: Date.now() & 0x7fffffff });
}

export function App() {
  const { theme, toggle } = useTheme();
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [demo, setDemo] = useState<MockClient>(() => newDemo());
  // Testnet is offered when a contract is configured (deployments.json or
  // VITE_CONTRACT_ID). The session does nothing until Testnet mode is shown.
  const session = useMemo(() => (chainConfig ? new ChainSession(chainConfig) : null), []);
  const sessionState = useSession(session);
  const [mode, setMode] = useState<Mode>(() => initialMode(session !== null));
  const onTestnet = mode === 'testnet' && session !== null && sessionState !== null;
  const chain: ChainUi | null = onTestnet ? { session, state: sessionState } : null;

  const client: GameClient = chain ? chain.session.client : demo;
  const game = useGame(client);
  const { refresh } = game;

  useEffect(() => {
    if (onTestnet) session.start();
  }, [onTestnet, session]);

  // A new account, or tokens that just arrived: fetch straight away.
  const version = sessionState?.version ?? 0;
  useEffect(() => {
    if (onTestnet && version > 0) void refresh();
  }, [onTestnet, version, refresh]);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    if (window.location.hash !== `#${next}`) window.history.replaceState(null, '', `#${next}`);
    window.scrollTo({ top: 0 });
  }, []);

  const restartDemo = useCallback(() => setDemo((d) => newDemo(d.roundSeconds())), []);

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Header
        tab={tab}
        onTab={selectTab}
        mode={mode}
        onMode={setMode}
        testnetAvailable={session !== null}
        network={chainConfig?.network ?? 'testnet'}
        chain={chain}
        theme={theme}
        onToggleTheme={toggle}
      />
      <main id="main" className="main" tabIndex={-1}>
        <div role="tabpanel" id="panel-play" aria-labelledby="tab-play" hidden={tab !== 'play'}>
          {tab === 'play' && (
            <Play
              game={game}
              mode={mode}
              demo={chain ? null : demo}
              chain={chain}
              onRestartDemo={restartDemo}
              onUseDemo={() => setMode('demo')}
              onShowRules={() => selectTab('rules')}
            />
          )}
        </div>
        <div role="tabpanel" id="panel-lab" aria-labelledby="tab-lab" hidden={tab !== 'lab'}>
          {tab === 'lab' && <Lab />}
        </div>
        <div role="tabpanel" id="panel-rules" aria-labelledby="tab-rules" hidden={tab !== 'rules'}>
          {tab === 'rules' && (
            <Rules config={game.snapshot?.config ?? null} mode={mode} lock={chain?.state.lock ?? null} onPlay={() => selectTab('play')} />
          )}
        </div>
      </main>
      <footer className="foot">
        <p>
          <strong>Not It</strong> is a hackathon experiment on NEAR testnet. Test tokens only. They have no value and
          nothing here is financial advice.
        </p>
      </footer>
    </div>
  );
}

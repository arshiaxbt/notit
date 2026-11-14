import { useEffect, useState } from 'react';
import type { CrowdMember, DemoControls } from '../../client/types';
import { ROUND_SPEEDS } from '../../client/types';
import type { Game } from '../../hooks/useGame';
import type { ChainUi } from '../../hooks/useSession';
import type { Mode } from '../Header';
import { useFlash } from '../ui';
import { ChainBar } from './Chain';
import { HeroSlab } from './HeroSlab';
import { Stats, Throne, You } from './Panels';
import { Crowd, HeroWall, RoundLog, RoundStrip } from './Rounds';

interface Props {
  game: Game;
  mode: Mode;
  demo: DemoControls | null;
  /** Set in Testnet mode. */
  chain: ChainUi | null;
  onRestartDemo(): void;
  onUseDemo(): void;
  onShowRules(): void;
}

function speedLabel(seconds: number): string {
  return seconds >= 60 ? `${seconds / 60} min` : `${seconds} s`;
}

function DemoBar({ demo, game, onRestart }: { demo: DemoControls; game: Game; onRestart(): void }) {
  const [seconds, setSeconds] = useState(demo.roundSeconds());
  useEffect(() => setSeconds(demo.roundSeconds()), [demo]);
  const pick = (s: number) => {
    demo.setRoundSeconds(s);
    setSeconds(s);
    void game.refresh();
  };
  return (
    <div className="demobar">
      <p className="demobar__text">
        <span className="chip chip--accent">Demo mode</span>
        <span>A simulated crowd on a fast clock, all in your browser. No wallet, no network.</span>
      </p>
      <div className="demobar__controls">
        <div className="seg" role="group" aria-label="How long a round takes">
          <span className="seg__label" aria-hidden="true">
            A round takes
          </span>
          {ROUND_SPEEDS.map((s) => (
            <button key={s} type="button" className="seg__opt" aria-pressed={seconds === s} onClick={() => pick(s)}>
              {speedLabel(s)}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--ghost" onClick={onRestart}>
          Restart
        </button>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="play" aria-busy="true">
      <div className="slab slab--loading">
        <p className="slab__ticker">
          <span className="slab__stamp">Loading</span>
          <span>Setting up the round…</span>
        </p>
        <div className="slab__body">
          <div className="slab__clock">
            <h2 className="slab__round">Round</h2>
            <div className="countdown" aria-hidden="true">
              –:––
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Play({ game, mode, demo, chain, onRestartDemo, onUseDemo, onShowRules }: Props) {
  const snap = game.snapshot;
  const flash = useFlash(game.lastClose, 3600);

  // The demo crowd is read straight from the mock, in step with each poll.
  const [crowd, setCrowd] = useState<CrowdMember[] | null>(null);
  useEffect(() => {
    setCrowd(demo && snap ? demo.crowd() : null);
  }, [demo, snap]);

  if (!snap) {
    if (game.error) {
      return (
        <div className="play">
          <div className="notice" role="alert">
            <h2>Could not reach NEAR testnet</h2>
            <p>The network did not answer ({game.error}). The demo runs the same rules in your browser, with no network.</p>
            <div className="notice__actions">
              <button type="button" className="btn" onClick={() => void game.refresh()}>
                Try again
              </button>
              {mode !== 'demo' && (
                <button type="button" className="btn" onClick={onUseDemo}>
                  Use demo mode
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    return <Skeleton />;
  }

  // One face per holder: the simulated crowd in Demo mode, the claims made so far on chain.
  const heads = demo ? (crowd?.length ?? 0) : Math.min(snap.state.claimsMade, 24);

  return (
    <div className="play">
      <h1 className="pitch">
        Somebody has to do it. <span className="pitch__hl">If nobody does, everybody pays the last person who did.</span>
      </h1>

      {game.error && (
        <p className="notice notice--inline" role="status">
          Having trouble reaching the network. Showing the last known state.
        </p>
      )}

      <div className="play__grid">
        <HeroSlab game={game} snap={snap} mode={mode} chain={chain} flash={flash} heads={heads} />
        <div className="play__side">
          <Throne snap={snap} flash={flash} />
          <You snap={snap} flash={flash} mode={mode} />
        </div>
      </div>

      {demo && <DemoBar demo={demo} game={game} onRestart={onRestartDemo} />}
      {chain && <ChainBar chain={chain} />}

      <Stats snap={snap} />
      <RoundStrip snap={snap} />

      <div className="play__two">
        <HeroWall snap={snap} crowd={crowd} />
        <RoundLog snap={snap} />
      </div>

      {crowd && <Crowd crowd={crowd} totalSupply={snap.state.totalSupply} />}

      <p className="play__more">
        New here?{' '}
        <button type="button" className="linkbtn" onClick={onShowRules}>
          Read the five rules
        </button>
        . It takes a minute.
      </p>
    </div>
  );
}

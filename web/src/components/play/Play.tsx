import { useEffect, useState } from 'react';
import type { CrowdMember, DemoControls } from '../../client/types';
import { ROUND_SPEEDS } from '../../client/types';
import type { Game } from '../../hooks/useGame';
import type { ChainUi } from '../../hooks/useSession';
import type { Mode } from '../Header';
import { useFlash } from '../ui';
import { ChainBar } from './Chain';
import { HeroWall, RoundStrip } from './Rounds';
import { Figures, LiveProvider, Scene, StageShell } from './Scene';

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
      <div className="demobar__controls">
        <div className="seg" role="group" aria-label="How long a round takes">
          <span className="seg__label" aria-hidden="true">
            Round
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
      // One line, and a way out: try again, or play the demo.
      return (
        <div className="play">
          <StageShell line="no answer from the network">
            <button type="button" className="act" onClick={() => void game.refresh()}>
              <span className="act__label">Try again</span>
            </button>
            <div className="act__note" role="alert" title={game.error}>
              {mode !== 'demo' && (
                <button type="button" className="act__link" onClick={onUseDemo}>
                  Use the demo
                </button>
              )}
            </div>
          </StageShell>
          {chain && (
            <div className="column">
              <ChainBar chain={chain} />
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="play">
        <StageShell busy />
      </div>
    );
  }

  // The demo can run a three-minute round in ten seconds; the clock shows the seconds you actually wait.
  const scale = demo ? Math.max(1, Number(snap.config.roundNs) / 1e9 / demo.roundSeconds()) : 1;

  return (
    <div className="play">
      <LiveProvider game={game}>
        <Scene game={game} snap={snap} chain={chain} flash={flash} crowd={crowd} scale={scale} onUseDemo={onUseDemo} />

        <div className="column">
          {game.error && (
            <p className="notice notice--inline" role="status">
              Network trouble. Showing the last known state.
            </p>
          )}
          <Figures snap={snap} flash={flash} />
          <RoundStrip snap={snap} />
          <HeroWall snap={snap} />
          {demo && <DemoBar demo={demo} game={game} onRestart={onRestartDemo} />}
          {chain && <ChainBar chain={chain} />}
        </div>
      </LiveProvider>
    </div>
  );
}

# @notit/engine

The rules engine and simulation lab for Not It ($NOTIT), in TypeScript with BigInt.

- `src/engine.ts` is a literal transcription of [`docs/SPEC.md`](../docs/SPEC.md) v2 (§2–§8): the `NotIt` class, `Config`, `FAST`, `LIVE`, `NotItError`. It reproduces the contract's integer arithmetic exactly; `snapshot()` is the canonical JSON a differential test compares with the contract.
- `src/strategies.ts` and `src/sim.ts` are a deterministic simulator: seeded agents with balances and strategies play rounds against the real engine.
- `src/experiments.ts` holds the lab experiments (`runBystander`, `runWhoPays`, `runDispersed`, `runMixedCrowd`) and `runLab` / `formatLab` / `labToJson`.
- `src/lab.ts` is the command-line entry: it prints the tables and writes `out/lab.json`.
- `src/scenarios.ts` generates `out/scenarios.json`: seeded call sequences with expected error codes and snapshots, for replaying against the Rust contract.

Everything exported from `src/index.ts` runs in a browser (no `node:` imports; only `src/lab.ts` and `src/scenarios.ts` use Node built-ins). The source uses erasable TypeScript only, so Node 22.18+ runs the `.ts` files directly and Vite imports them as they are. There is no build step.

## Run

From the repository root:

```sh
npm install
npm test -w engine          # node:test, 49 tests
npm run typecheck -w engine # tsc --noEmit
npm run lab                 # prints the tables, writes engine/out/lab.json (about 3 s)
npm run scenarios -w engine # writes engine/out/scenarios.json (687 KB)
```

The lab and the scenarios use fixed seeds and no clock, so two runs are byte-identical.

## Use

```ts
import { NotIt, FAST, simulate, runBystander } from '@notit/engine';

const game = new NotIt({ ...FAST, genesisNs: 0n });
game.claim('alice', 0n);                                  // every call takes `now` in nanoseconds
const round1 = FAST.roundNs;
const { cost } = game.volunteer('alice', round1, { round: 1, maxCost: 60n * 10n ** 18n });
game.state(round1 * 5n);                                  // views settle virtually as of `now`

const sim = simulate({
  seed: 7,
  rounds: 200,
  agents: [
    { balance: 1000n * 10n ** 18n, strategy: { kind: 'sniper', missRate: 0.2 } },
    { balance: 1000n * 10n ** 18n, strategy: { kind: 'freeRider' } },
  ],
});
```

Decisions, ambiguities in the spec and what each experiment does exactly are in [NOTES.md](./NOTES.md).

// Play the game on testnet.
//
//   node src/run.ts            loop until stopped (or for RUN_SECONDS)
//   node src/run.ts --once     one pass over the fleet, then exit (for cron)
//
// Each pass reads the public state, asks every bot's strategy whether to volunteer now, and
// sends at most one volunteer transaction, guarded by round and max cost.

import { fmt, getAccount, getConfig, getState, reason, signer, sleep, transfer, volunteer } from "./chain.ts";
import { loadFleet } from "./fleet.ts";
import { STRATEGIES } from "./strategies.ts";

const once = process.argv.includes("--once");
const runSeconds = Number(process.env.RUN_SECONDS ?? 0);
const fleet = loadFleet();
const config = await getConfig(fleet.contractId);
const roundNs = BigInt(config.round_ns);
// Check about 12 times a round, but no more often than every 4 s and no less than every 60 s.
const intervalMs = Math.min(60_000, Math.max(4_000, Number(roundNs / 1_000_000n / 12n)));

/** One random number per bot per round, derived from the round number so restarts agree. */
function roll(round: number, bot: number): number {
  let x = (Math.imul(round + 1, 0x9e3779b1) ^ Math.imul(bot + 1, 0x85ebca6b)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d) >>> 0;
  x ^= x >>> 12;
  return (x >>> 0) / 0x1_0000_0000;
}

function log(message: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
}

let lastRound = -1;

/** Balances and It flags, read once per round and again after one of our own transactions. */
let accounts: { balance: bigint; isIt: boolean }[] | null = null;

async function readAccounts(): Promise<{ balance: bigint; isIt: boolean }[]> {
  const views = [];
  for (const bot of fleet.bots) {
    const acct = await getAccount(fleet.contractId, bot.accountId);
    views.push({ balance: BigInt(acct.balance), isIt: acct.is_it });
  }
  return views;
}

/**
 * Fleet housekeeping, not part of the game's rules: the bots share one operator, and a
 * small closed crowd ends with one account holding almost everything, after which nobody
 * else can afford to volunteer and the game sleeps (the lab shows the same thing). When
 * one bot holds more than 60 % of the fleet's tokens, it deals them back out so that
 * every bot under 8 % is topped up to 12 %.
 */
async function redeal(): Promise<void> {
  accounts = await readAccounts();
  const balances = accounts.map((a) => a.balance);
  const total = balances.reduce((a, b) => a + b, 0n);
  if (total === 0n) return;
  const richest = balances.reduce((best, b, i) => (b > balances[best] ? i : best), 0);
  if (balances[richest] * 100n <= total * 60n) return;
  const target = (total * 12n) / 100n;
  for (const [i, bot] of fleet.bots.entries()) {
    if (i === richest || balances[i] * 100n >= total * 8n) continue;
    const amount = target - balances[i];
    try {
      const rich = fleet.bots[richest];
      await transfer(signer(rich.accountId, rich.secretKey), fleet.contractId, bot.accountId, amount);
      log(`  re-deal: ${rich.accountId} sent ${fmt(amount)} NOTIT to ${bot.accountId}`);
      accounts = null;
    } catch (error) {
      log(`  re-deal to ${bot.accountId} failed: ${reason(error)}`);
    }
  }
}

async function pass(): Promise<void> {
  const state = await getState(fleet.contractId);
  if (state.round !== lastRound) {
    lastRound = state.round;
    const it = state.it ?? "nobody";
    log(
      `round ${state.round} · supply ${fmt(state.total_supply)} · It: ${it} · ` +
        `${state.armed ? `armed, ${state.collapse_run}/${config.max_collapse_run} charged` : "dormant"} · ` +
        `saved ${state.stats.rounds_saved}, collapsed ${state.stats.rounds_collapsed}`,
    );
    await redeal();
  }
  if (state.saved || state.round_supply === "0") return;

  const elapsed = BigInt(state.now_ns) - BigInt(state.round_start_ns);
  const progress = Number((elapsed * 1000n) / roundNs) / 1000;
  const cost = BigInt(state.cost_now);

  accounts ??= await readAccounts();
  for (const [i, bot] of fleet.bots.entries()) {
    const strategy = STRATEGIES[bot.strategy];
    if (!strategy) continue;
    const { balance, isIt } = accounts[i];
    if (balance < cost) continue;
    const wants = strategy({ state, config, balance, isIt, progress, roll: roll(state.round, i) });
    if (!wants) continue;
    try {
      // The cost only falls within a round, so the cost just read is a safe ceiling.
      await volunteer(signer(bot.accountId, bot.secretKey), fleet.contractId, state.round, cost);
      log(`  ${bot.accountId} (${bot.strategy}) volunteered at ≤ ${fmt(cost)} NOTIT, ${Math.round((1 - progress) * 100)}% of the round left`);
    } catch (error) {
      log(`  ${bot.accountId} (${bot.strategy}) was refused: ${reason(error)}`);
    }
    accounts = null; // our balance or It changed, or somebody beat us: read again next pass
    return; // one attempt per pass; the round is saved or the next pass tries again
  }
}

const deadline = runSeconds > 0 ? Date.now() + runSeconds * 1000 : Infinity;
log(`fleet of ${fleet.bots.length} on ${fleet.contractId}, checking every ${intervalMs / 1000}s`);
do {
  try {
    await pass();
  } catch (error) {
    log(`pass failed: ${reason(error)}`);
  }
  if (once) break;
  await sleep(intervalMs);
} while (Date.now() < deadline);

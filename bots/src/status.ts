// Print the public state of a deployment and each bot's position. Read-only.
//
//   node src/status.ts [contract-id]

import { accessKeyCount, fmt, getAccount, getState } from "./chain.ts";
import { loadFleet } from "./fleet.ts";
import type { Fleet } from "./fleet.ts";

let fleet: Fleet;
try {
  fleet = loadFleet();
} catch {
  fleet = { contractId: process.argv[2] ?? "", bots: [] };
}
const contractId = process.argv[2] ?? fleet.contractId;
if (!contractId) {
  console.error("usage: node src/status.ts <contract-id>");
  process.exit(1);
}

const state = await getState(contractId);
const keys = await accessKeyCount(contractId);
console.log(`contract        ${contractId}`);
console.log(`access keys     ${keys} ${keys === 0 ? "(locked: nobody can redeploy or change it)" : "(NOT locked)"}`);
console.log(`round           ${state.round} ${state.saved ? `saved by ${state.hero}` : "not saved yet"}`);
console.log(`cost now        ${fmt(state.cost_now)} NOTIT`);
console.log(`It              ${state.it ?? "nobody"}`);
console.log(`armed           ${state.armed} (${state.collapse_run} unsaved rounds charged in a row)`);
console.log(`supply          ${fmt(state.total_supply)} NOTIT`);
console.log(`rounds          ${state.stats.rounds_saved} saved, ${state.stats.rounds_collapsed} collapsed`);
console.log(`burned / paid   ${fmt(state.stats.total_burned)} / ${fmt(state.stats.total_paid)} NOTIT`);
for (const bot of fleet.bots) {
  const acct = await getAccount(contractId, bot.accountId);
  console.log(
    `  ${bot.strategy.padEnd(9)} ${fmt(acct.balance).padStart(12)}  saves ${String(acct.saves).padStart(3)}  ` +
      `collected ${fmt(acct.collected).padStart(10)}  ${acct.is_it ? "← It" : ""}  ${bot.accountId}`,
  );
}

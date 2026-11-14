// Create a fleet of faucet-funded testnet accounts and claim NOTIT for each.
//
//   node src/setup.ts <contract-id> [count]
//
// Writes .bots.json (git-ignored; testnet keys only).

import { claim, createFaucetAccount, getAccount, reason, signer, sleep } from "./chain.ts";
import { loadFleet, saveFleet, fleetPath } from "./fleet.ts";
import type { Bot, Fleet } from "./fleet.ts";
import { LINEUP, STRATEGIES } from "./strategies.ts";

const [contractId, countArg] = process.argv.slice(2);
if (!contractId) {
  console.error("usage: node src/setup.ts <contract-id> [count]");
  process.exit(1);
}
const count = Number(countArg ?? LINEUP.length);

let fleet: Fleet;
try {
  fleet = loadFleet();
  if (fleet.contractId !== contractId) fleet = { contractId, bots: fleet.bots };
} catch {
  fleet = { contractId, bots: [] };
}

const stamp = Date.now().toString(36);
while (fleet.bots.length < count) {
  const i = fleet.bots.length;
  const strategy = LINEUP[i % LINEUP.length];
  if (!(strategy in STRATEGIES)) throw new Error(`unknown strategy ${strategy}`);
  const accountId = `notit-${strategy}-${stamp}${i}.testnet`;
  process.stdout.write(`creating ${accountId} … `);
  try {
    const secretKey = await createFaucetAccount(accountId);
    fleet.bots.push({ accountId, secretKey, strategy } satisfies Bot);
    saveFleet(fleet);
    console.log("ok");
  } catch (error) {
    console.log(`failed: ${reason(error)}`);
    await sleep(5_000);
  }
  await sleep(1_500); // be gentle with the public faucet
}

for (const bot of fleet.bots) {
  const acct = await getAccount(fleet.contractId, bot.accountId);
  if (acct.claimed) {
    console.log(`${bot.accountId} already claimed`);
    continue;
  }
  try {
    await claim(signer(bot.accountId, bot.secretKey), fleet.contractId);
    console.log(`${bot.accountId} claimed`);
  } catch (error) {
    console.log(`${bot.accountId} claim failed: ${reason(error)}`);
  }
}

saveFleet(fleet);
console.log(`fleet of ${fleet.bots.length} saved to ${fleetPath()}`);

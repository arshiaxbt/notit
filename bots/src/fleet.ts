// Where the bots' testnet keys live. Never commit this: the file is git-ignored, and in CI
// the same JSON comes from the BOTS_JSON secret.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Bot {
  accountId: string;
  secretKey: string;
  strategy: string;
}

export interface Fleet {
  contractId: string;
  bots: Bot[];
}

export function fleetPath(): string {
  return resolve(process.env.BOTS_FILE ?? ".bots.json");
}

export function loadFleet(): Fleet {
  const raw = process.env.BOTS_JSON ?? (existsSync(fleetPath()) ? readFileSync(fleetPath(), "utf8") : null);
  if (!raw) {
    throw new Error(`no fleet: run "npm run setup -w bots -- <contract>" first, or set BOTS_JSON`);
  }
  const fleet = JSON.parse(raw) as Fleet;
  if (process.env.CONTRACT_ID) fleet.contractId = process.env.CONTRACT_ID;
  return fleet;
}

export function saveFleet(fleet: Fleet): void {
  writeFileSync(fleetPath(), JSON.stringify(fleet, null, 2) + "\n", { mode: 0o600 });
}

/** Plain words for the contract's ERR_* codes (SPEC §10) and for client-side failures. */

const ERROR_TEXT: Record<string, string> = {
  ERR_ALREADY_CLAIMED: 'This account has already claimed its NOTIT.',
  ERR_CLAIMS_CLOSED: 'The faucet is closed: every claim has been taken.',
  ERR_STORAGE: 'The storage deposit was missing. Nothing was changed.',
  ERR_ALREADY_SAVED: 'Someone beat you to it. This round is already saved, and you paid nothing.',
  ERR_NOTHING_TO_SAVE: 'There is nothing to save this round yet. It starts counting next round.',
  ERR_WRONG_ROUND: 'That round ended before your move landed. Nothing was burned. Try again in this round.',
  ERR_COST_TOO_HIGH: 'The cost was higher than the one you agreed to, so nothing was burned.',
  ERR_INSUFFICIENT: 'Your balance is lower than the cost right now. Wait for it to fall.',
  ERR_UNREGISTERED: 'That account has no tokens yet.',
  // Client-side codes (not from the contract).
  ERR_NO_ACCOUNT: 'Sign in first: play as a guest or connect a wallet.',
  ERR_REJECTED: 'Cancelled in the wallet. Nothing was sent.',
  ERR_NETWORK: 'The network did not answer. Nothing was changed. Try again.',
  ERR_KEY_LIMITED: 'This browser key can only volunteer.',
  ERR_NO_GAS: 'This account has run out of testnet NEAR to pay for transactions.',
};

/** Outcomes that are not the player's mistake and cost them nothing. */
const GENTLE = new Set(['ERR_ALREADY_SAVED', 'ERR_WRONG_ROUND', 'ERR_COST_TOO_HIGH', 'ERR_REJECTED', 'ERR_ALREADY_CLAIMED']);

export function describeError(code: string): string {
  return ERROR_TEXT[code] ?? 'That did not go through. Nothing was changed.';
}

export function isGentle(code: string): boolean {
  return GENTLE.has(code);
}

function textOf(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const parts: string[] = [];
    const o = e as { message?: unknown; code?: unknown; type?: unknown; kind?: unknown };
    if (typeof o.code === 'string') parts.push(o.code);
    if (typeof o.message === 'string') parts.push(o.message);
    if (typeof o.type === 'string') parts.push(o.type);
    try {
      parts.push(JSON.stringify(e));
    } catch {
      /* circular: the message is enough */
    }
    return parts.join(' ');
  }
  return String(e);
}

/**
 * The error code behind a failed call: the contract's ERR_* code when the
 * panic message carries one, otherwise a client-side code.
 */
export function errorCode(e: unknown): string {
  const text = textOf(e);
  const m = /ERR_[A-Z_]+/.exec(text);
  if (m) return m[0];
  if (/reject|cancel|denied|closed by user|user closed/i.test(text)) return 'ERR_REJECTED';
  if (/NotEnoughBalance|LackBalanceForState|not enough balance/i.test(text)) return 'ERR_NO_GAS';
  if (/fetch|network|timeout|timed out|Exceeded \d+ providers|ECONN|503|502|429/i.test(text)) return 'ERR_NETWORK';
  return 'ERR_UNKNOWN';
}

# Not It ($NOTIT) — specification v2 (frozen)

This file is the single source of truth for the contract (`contract/`, Rust), the rules engine (`engine/`, TypeScript) and the web app (`web/`). The contract and the engine must produce identical integers for identical inputs. All arithmetic is integer arithmetic; every division states its rounding. Intermediate products use 256-bit integers.

**Changes from v1** (after an independent mechanism review): the uniform +3 % mint is gone; the 15 % cut is no longer burned but **paid to the last volunteer ("It")**; at most 8 unsaved rounds in a row are charged; `volunteer` takes optional `round` / `max_cost` guards; the dead state, `MAX_SETTLE`, `ERR_BEHIND`, `reward_ppm` and `supply_cap` are removed; a lazy rescale keeps the index from decaying to zero.

## 1. The game

1. Time is split into rounds.
2. In each round the **sacrifice cost** starts high and falls linearly until the deadline.
3. The first holder to **volunteer** in a round burns the current cost from their own balance. The round is **saved** and that holder becomes **It** — the last person who did it.
4. If a round ends unsaved, every balance is cut and the whole cut is paid to It. At most `MAX_COLLAPSE_RUN` unsaved rounds in a row are charged; after that the game is **dormant** until somebody volunteers again. Before the first volunteer ever there is no It and nothing is charged.
5. Nobody can change the rules after deployment.

Why the stakes are real: a save moves value from the volunteer to everyone (the burn); a collapse moves value from everyone to It. Neither is a uniform rebase.

## 2. Constants and parameters

| Constant | Value | Meaning |
|---|---|---|
| `DECIMALS` | 18 | 1 NOTIT = 10^18 units |
| `RAY` | 10^27 | fixed-point scale of `index` |
| `PPM` | 1_000_000 | parts-per-million scale for rates |
| `MAX_COLLAPSE_RUN` | 8 | unsaved rounds charged in a row |
| `RESCALE_BELOW` | 10^18 | rescale when `index` falls below this |
| `RESCALE_FACTOR` | 10^9 | rescale multiplier |

Init parameters (immutable after `new`):

| Name | Type | `fast` | `live` | Meaning |
|---|---|---|---|---|
| `round_ns` | u64 | 180 s | 3600 s | round length in nanoseconds |
| `max_cost_ppm` | u32 | 50_000 | 50_000 | cost rate at round open (5 % of round supply) |
| `min_cost_ppm` | u32 | 2_000 | 2_000 | cost rate at the deadline (0.2 %) |
| `cut_ppm` | u32 | 150_000 | 150_000 | cut paid to It after an unsaved round (15 %) |
| `claim_amount` | u128 | 1_000 × 10^18 | same | faucet claim per account |
| `claim_cap` | u32 | 100_000 | same | max number of claims ever |

Validation in `new` (`ERR_PARAMS`): `round_ns ≥ 10^9`; `0 < min_cost_ppm ≤ max_cost_ppm < PPM`; `0 < cut_ppm < PPM`; `claim_amount > 0`; `claim_amount × claim_cap ≤ 10^32`.

## 3. State

| Field | Type | Initial |
|---|---|---|
| `accounts[a]` | `{ shares: u256, scale: u32 }` | absent = unregistered |
| `total_shares` | u256 | 0 |
| `index` | u256 | `RAY` |
| `scale` | u32 | 0 |
| `genesis_ns` | u64 | block timestamp of `new` |
| `round` | u64 | 0 (the current, unsettled round) |
| `round_supply` | u128 | 0 (total supply when `round` opened) |
| `round_hero` | optional account | none |
| `it` | optional account | none (the last volunteer) |
| `collapse_run` | u32 | 0 |
| `claimed` | set of accounts | empty (survives unregistration) |
| `claims_made` | u32 | 0 |
| `stats` | §7 | zero |
| `history` | list of entries, §7 | empty |
| `heroes[a]` | `{ saves: u32, burned: u128, collected: u128 }` | absent (survives unregistration) |

Derived:

- `eff(a) = floor(accounts[a].shares / RESCALE_FACTOR^(scale − accounts[a].scale))` — effective shares at the current scale. Every write to an account first **normalises** it: `shares = eff(a)`, `accounts[a].scale = scale`.
- `balance_of(a) = floor(eff(a) × index / RAY)` (0 if unregistered)
- `total_supply = floor(total_shares × index / RAY)`
- Round `k` covers `[genesis_ns + k × round_ns, genesis_ns + (k+1) × round_ns)`; `current_round(now) = floor((now − genesis_ns) / round_ns)`.
- `armed = it is set and registered, and collapse_run < MAX_COLLAPSE_RUN, and round_supply > 0`. An unsaved round is charged only if the game is armed when it closes.

## 4. Settlement (run first in every state-changing call except `storage_deposit`, `storage_withdraw` and `ft_resolve_transfer`)

```
settle(now):
  target = current_round(now)
  while round < target:
    close_round()                       # §4.1
    round += 1
    round_hero = none
    round_supply = total_supply
    if not armed:                       # every further unattended round is dormant
      round = target
      break
```

The loop body runs at most `MAX_COLLAPSE_RUN + 1` times.

### 4.1 Closing round `round`

- **saved** (`round_hero` set): `rounds_saved += 1`; `current_streak += 1`; `longest_streak = max(longest_streak, current_streak)`. (The history entry was written at volunteer time.)
- **dormant** (not saved and not `armed`): nothing changes, nothing is recorded.
- **collapsed** (not saved and `armed`):
  1. `before = total_supply`
  2. `index = floor(index × (PPM − cut_ppm) / PPM)`
  3. normalise `it`; `pot = before − total_supply` (using the new index); `paid = max(0, pot − (floor(eff(it) × index_before / RAY) − floor(eff(it) × index / RAY)))` — It is cut like everyone else and gets that back inside the pot, so `paid` is what It collects from the other holders (the clamp matters only when the others hold dust: the floors are independent and the difference can be −1)
  4. `minted = floor(pot × RAY / index)`; `accounts[it].shares += minted`; `total_shares += minted`
  5. if `index < RESCALE_BELOW`: `index = index × RESCALE_FACTOR`; `total_shares = floor(total_shares / RESCALE_FACTOR)`; `scale += 1` (accounts catch up lazily through `eff`)
  6. stats: `rounds_collapsed += 1`; `current_streak = 0`; `collapse_run += 1`; `total_paid += paid`; `heroes[it].collected += paid`
  7. history: if the last entry is `collapsed` with `last_round == round − 1` and the same `it`, extend it (`last_round = round`, `count += 1`, `paid += paid`); else append `collapsed { first_round: round, last_round: round, count: 1, it, paid }`.

## 5. Actions

`to_shares_floor(x) = floor(x × RAY / index)`, `to_shares_ceil(x) = ceil(x × RAY / index)`.

### 5.1 `claim()` — payable

1. `settle(now)`.
2. Require `caller ∉ claimed` (`ERR_ALREADY_CLAIMED`) and `claims_made < claim_cap` (`ERR_CLAIMS_CLOSED`).
3. If caller is unregistered: require attached deposit ≥ the storage fee (`ERR_STORAGE`), register with zero shares at the current scale, refund the excess. If registered: refund the whole deposit.
4. Normalise caller; `s = to_shares_floor(claim_amount)`; `accounts[caller].shares += s`; `total_shares += s`; add caller to `claimed`; `claims_made += 1`.
5. Emit `ft_mint` with `amount = claim_amount`.

A claim in round `k` does not change `round_supply` of round `k`.

### 5.2 `volunteer(round?, max_cost?)` — no deposit required

1. `settle(now)`.
2. Require `round_hero` is none (`ERR_ALREADY_SAVED`) and `round_supply > 0` (`ERR_NOTHING_TO_SAVE`). If `round` is given, require it equals the current round (`ERR_WRONG_ROUND`).
3. Cost:
   ```
   elapsed  = now − (genesis_ns + round × round_ns)             # 0 ≤ elapsed < round_ns
   rate_ppm = max_cost_ppm − floor((max_cost_ppm − min_cost_ppm) × elapsed / round_ns)   # u128 math
   cost     = max(1, floor(round_supply × rate_ppm / PPM))
   ```
   If `max_cost` is given, require `cost ≤ max_cost` (`ERR_COST_TOO_HIGH`).
4. Normalise caller; `burn = to_shares_ceil(cost)`; require `burn ≤ accounts[caller].shares` (`ERR_INSUFFICIENT`, also for unregistered callers).
5. `accounts[caller].shares −= burn`; `total_shares −= burn`; `round_hero = caller`; `it = caller`; `collapse_run = 0`.
6. `ms_left = floor((round_ns − elapsed) / 10^6)`.
7. Stats: `total_burned += cost`; `heroes[caller].saves += 1`; `heroes[caller].burned += cost`; if `closest_call_ms` is unset or `ms_left < closest_call_ms`, set it.
8. History: append `saved { round, hero: caller, cost, ms_left }`.
9. Emit `ft_burn` (`amount = cost`) and `round_saved`. Returns `cost`.

### 5.3 `ft_transfer(receiver_id, amount, memo?)` — exactly 1 yoctoNEAR

1. `settle(now)`.
2. Require `amount > 0` (`ERR_ZERO_AMOUNT`), `receiver_id != caller` (`ERR_SELF_TRANSFER`), both registered (`ERR_UNREGISTERED`).
3. Normalise both; `s = to_shares_ceil(amount)`; require `s ≤ accounts[caller].shares` (`ERR_INSUFFICIENT`).
4. Move `s` shares. Emit `ft_transfer`.

`ft_transfer_call` (contract only): same debit of `s` shares, then `ft_on_transfer` on the receiver, then `ft_resolve_transfer(sender_id, receiver_id, amount, shares = s, scale)`, which never settles and never panics: with `s'` = `s` brought to the current scale and `unused` = the receiver's reply capped at `amount` (the whole `amount` if the call failed), it moves `back = min(floor(s' × unused / amount), eff(receiver))` shares to the sender (or burns them if the sender unregistered) and returns the used amount.

### 5.4 `poke()`

`settle(now)` only. Returns the number of rounds closed by the loop body (skipped dormant rounds are not counted).

### 5.5 Storage management (NEP-145) — only `storage_unregister` settles

`storage_deposit(account_id?, registration_only?)`, `storage_withdraw(amount?)`, `storage_unregister(force?)`, `storage_balance_bounds()`, `storage_balance_of(account_id)`. `min == max` (fixed fee of 0.005 NEAR). The contract's own account cannot be registered, so tokens can never be sent to it. `storage_unregister` returns half of the fee; the other half keeps paying for the records that outlive the account (`claimed`, `heroes`). `storage_unregister` runs `settle(now)` first (so an It with unsaved rounds pending is paid for them before leaving), then requires `eff(caller) == 0` unless `force`, in which case the shares are burned (`total_shares −= eff(caller)`, `ft_burn` emitted). If the caller is `it`, `it` becomes none.

## 6. Views

Views apply settlement **virtually** as of the current block time (same code as §4, without writing), so they are correct even when nobody has called the contract for many rounds. JSON: `u128`/`u256` as decimal strings, `u64` nanosecond timestamps as decimal strings, `u32` and round numbers as numbers.

```
get_config() -> { round_ns, max_cost_ppm, min_cost_ppm, cut_ppm, claim_amount, claim_cap,
                  genesis_ns, decimals: 18, max_collapse_run: 8 }

get_state() -> {
  now_ns, round, round_start_ns, round_end_ns,
  saved: bool, hero: string|null,          # this round's volunteer
  it: string|null,                         # the last volunteer (collects if this round collapses)
  armed: bool,                             # true if an unsaved close of this round would be charged
  collapse_run,                            # unsaved charged rounds in a row so far
  cost_now,                                # "0" if saved or round_supply == 0
  round_supply, total_supply, index, scale,
  claims_made, claim_open: bool,
  stats: { rounds_saved, rounds_collapsed, current_streak, longest_streak,
           closest_call_ms: number|null, total_burned, total_paid }
}

get_account(account_id) -> { registered, claimed, balance, saves, burned, collected, is_it }
get_history(from_index, limit) -> [entry]      # oldest first; limit ≤ 100
get_history_len() -> number
get_heroes(from_index, limit) -> [{ account_id, saves, burned, collected }]   # insertion order; limit ≤ 100
ft_total_supply() -> string
ft_balance_of(account_id) -> string
ft_metadata() -> { spec: "ft-1.0.0", name: "Not It", symbol: "NOTIT", decimals: 18, icon }
```

Virtual history: rounds that would close as collapsed right now are merged into the last stored entry when adjacent and paid to the same `it`; otherwise they appear as one extra trailing entry. `get_history_len` counts that extra entry.

## 7. History entries and events

```
{ "kind": "saved",     "round": 12, "hero": "alice.testnet", "cost": "…", "ms_left": 41000 }
{ "kind": "collapsed", "first_round": 13, "last_round": 15, "count": 3, "it": "alice.testnet", "paid": "…" }
```

Events (NEP-297, one `EVENT_JSON:` log line each):

- `nep141` / `1.0.0`: `ft_mint`, `ft_burn`, `ft_transfer` with the standard data arrays. A collapse is a transfer from all holders to `it` done through the index; it is reported by `rounds_closed`, not by per-holder `ft_transfer` events.
- `notit` / `1.0.0`:
  - `round_saved` — `{ round, hero, cost, ms_left }`
  - `rounds_closed` — `{ from_round, to_round, saved, collapsed, paid, it, index, scale }` (one per `settle` that advanced `round`)

## 8. Engine API (`engine/`, TypeScript, BigInt)

```ts
export interface Config { roundNs: bigint; maxCostPpm: number; minCostPpm: number; cutPpm: number;
  claimAmount: bigint; claimCap: number; genesisNs: bigint }
export const FAST: Omit<Config,'genesisNs'>;  export const LIVE: Omit<Config,'genesisNs'>;
export const MAX_COLLAPSE_RUN = 8;

export class NotIt {
  constructor(config: Config);
  // actions — `now` is ns since epoch; each throws NotItError(code) with the ERR_* codes below
  claim(caller: string, now: bigint): void;          // auto-registers
  register(account: string): void;
  unregister(account: string, force: boolean): boolean;
  volunteer(caller: string, now: bigint, guard?: { round?: number; maxCost?: bigint }): { cost: bigint; msLeft: number };
  transfer(from: string, to: string, amount: bigint, now: bigint): void;
  poke(now: bigint): number;
  // views — virtual settlement as of `now`
  state(now: bigint): State;         // same fields as get_state(), camelCase, bigint for u128/u256
  account(id: string, now: bigint): Account;
  balanceOf(id: string, now: bigint): bigint;
  totalSupply(now: bigint): bigint;
  costAt(now: bigint): bigint;
  history(now: bigint): HistoryEntry[];  heroes(): Hero[];
  snapshot(): string;                 // canonical JSON of all STORED state, for differential tests
}
```

The engine has no clock and no randomness of its own; callers pass `now`. `snapshot()` is JSON with keys in this order: `index`, `scale`, `total_shares`, `round`, `round_supply`, `round_hero`, `it`, `collapse_run`, `claims_made`, `stats`, `accounts` (array sorted by id of `{ id, shares, scale, claimed }`, stored values, not normalised), `heroes` (array sorted by id), `history`; all big numbers as decimal strings, snake_case keys.

## 9. Client interface used by the web app

```ts
export interface NotItClient {
  getConfig(): Promise<ConfigView>;  getState(): Promise<StateView>;
  getAccount(id: string): Promise<AccountView>;
  getHistory(from: number, limit: number): Promise<HistoryEntry[]>;  getHistoryLen(): Promise<number>;
  getHeroes(from: number, limit: number): Promise<Hero[]>;
  claim(): Promise<TxResult>;
  volunteer(guard: { round: number; maxCost: bigint }): Promise<TxResult>;
  poke(): Promise<TxResult>;
  accountId(): string | null;
}
```

Two implementations: `MockClient` (wraps the engine in the browser, with simulated bot holders and a controllable clock — no network) and `NearClient` (testnet RPC + wallet or guest key).

## 10. Error codes

`ERR_PARAMS`, `ERR_ALREADY_CLAIMED`, `ERR_CLAIMS_CLOSED`, `ERR_STORAGE`, `ERR_ALREADY_SAVED`, `ERR_NOTHING_TO_SAVE`, `ERR_WRONG_ROUND`, `ERR_COST_TOO_HIGH`, `ERR_INSUFFICIENT`, `ERR_UNREGISTERED`, `ERR_ZERO_AMOUNT`, `ERR_SELF_TRANSFER`. The contract panics with a message that starts with the code.

## 11. Payoffs (for strategies and the lab)

For a holder with balance `x` who is not It, in an armed round with current cost `c`:

- volunteer now: lose `c` (burned), become It;
- someone else volunteers: lose nothing;
- nobody volunteers: lose `cut × x` to It.

So a holder who ignores the value of becoming It ("myopic") prefers volunteering to a collapse only if `cut × x > c`. With `n` identical myopic holders (It excluded) facing cost `c` in the final block, the symmetric mixed equilibrium has each volunteer with probability `p = 1 − q^(1/(n−1))`, `q = c / (cut × x)`, and the round fails with probability `q^(n/(n−1))` (`q ≥ 1` means nobody volunteers). With `x = S/N` over `N = n + 1` equal holders and `c = min_cost × S`: `q = min_cost × N / cut`. Being It is worth the expected collapse income of later rounds; strategies may add that value to the benefit side. It has no reason to volunteer while collapses are being charged, but any volunteer resets `collapse_run`, including It: an It that volunteers again re-arms the game for up to 8 more charged rounds. The cap therefore protects holders from an absent It, not from an active one.

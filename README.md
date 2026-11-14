# Not It ($NOTIT)

A memecoin whose only mechanic is a volunteer's dilemma with real stakes, on NEAR.

**Somebody has to do it. If nobody does, everybody pays the last person who did.**

| | |
|---|---|
| Hackathon | Built at NEAR HACKATHON (development phase 1–14 November 2026). Track: `memecoins` (Memecoins With Mechanics) |
| Live demo | https://arshiaxbt.github.io/notit/ |
| Contracts (NEAR testnet) | `notit-play.testnet` (3-minute rounds), `notit-live.testnet` (1-hour rounds). Both locked: no access keys |
| Status | Testnet only. Test tokens with no value. Not audited |

## What it is

Not It is an NEP-141 token with one game built into the contract:

1. Time is split into rounds.
2. In each round a **sacrifice cost** starts at 5 % of the supply and falls linearly to 0.2 % at the deadline.
3. The first holder to volunteer burns the current cost from their own balance. The round is saved and that holder becomes **It**.
4. If a round ends with no volunteer, every balance is cut 15 % and the whole cut is paid to It. At most 8 unsaved rounds in a row are charged; then the game sleeps until somebody volunteers. Before the first volunteer there is no It and nothing is charged.
5. Nothing can be changed after deployment: the contract stores no owner, has no setter, and the deployed accounts have no access keys.

## The problem it addresses

The track asks for memecoins "where the meme does something" and says entries are "judged on the mechanic, not the chart". Many token mechanics are accounting illusions: cutting or paying every holder by the same percentage changes nobody's share of the supply.

Not It is built so that every event is a real transfer of ownership. A save moves value from the volunteer to everyone else (the burn). A collapse moves value from everyone to It. That makes each round a genuine volunteer's dilemma: everyone is better off if somebody acts, and everyone would rather it were somebody else. [docs/MECHANISM.md](docs/MECHANISM.md) works through the incentives and lists the weaknesses.

## How NEAR fits in

- **Rules nobody can change.** A NEAR account with no access keys cannot be redeployed or administered. Both deployments were locked by deleting every key (`scripts/lock.sh`); step 4 below shows how to check.
- **Standards.** NEP-141 token, NEP-145 storage management, NEP-148 metadata, NEP-297 events, so wallets and explorers read it without custom code.
- **Cheap, fast finality.** A round is decided in its last seconds; one-second blocks and negligible fees make a three-minute round playable.
- **One-click play.** The web app creates a faucet-funded testnet account in the browser, so a visitor can claim and volunteer without installing a wallet. Wallet login uses NEAR Connect.
- **Named accounts.** It, the volunteers and the bots are readable account names on the hero wall.
- **NEAR Sandbox** runs the compiled contract in the integration test.

## Try it

Run every command from the repository root unless a step says otherwise. Steps 1 and 2 need only Node 22.18 or newer (the TypeScript sources run directly, with no build step). No keys, no accounts, no network after `npm ci`.

### 1. Run the lab

```sh
npm ci
npm run lab
```

You should see four tables. The first compares the simulated failure rate with the theory in docs/MECHANISM.md; the output is deterministic, and `npm run --silent lab` matches [docs/lab-output.txt](docs/lab-output.txt) byte for byte:

```
A. Bystander effect - N equal players, all mixedFinalBlock, 2000 independent one-round trials each (seed 1001)
   One extra equal account became It in a setup round and never volunteers. x = player balance, c = final-slot cost.
   q = c / (cut * x);  p = 1 - q^(1/(N-1));  theory P(fail) = q^(N/(N-1)), or 1 if q >= 1

  N       q       p  theory P(fail)  simulated     diff
---  ------  ------  --------------  ---------  -------
  3  0.0533  0.7692          0.0123     0.0095  -0.0028
  5  0.0799  0.4684          0.0425     0.0460  +0.0035
 10  0.1464  0.1922          0.1183     0.1110  -0.0073
 20  0.2796  0.0649          0.2614     0.2710  +0.0096
 30  0.4127  0.0301          0.4003     0.3995  -0.0008
 45  0.6124  0.0111          0.6056     0.6050  -0.0006
 60  0.8121  0.0035          0.8093     0.7930  -0.0163
 75  1.0118  0.0000          1.0000     1.0000   0.0000
100  1.3446  0.0000          1.0000     1.0000   0.0000
```

### 2. Run the engine tests

```sh
npm test
```

You should see `pass 49` and `fail 0`.

### 3. Run the contract tests

Needs Rust (`rustup`; the pinned toolchain in `contract/rust-toolchain.toml` installs itself) and `cargo-near`. A cold build takes about 5 minutes and about 1 GB of disk:

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.23.0/cargo-near-installer.sh | sh
cd contract
cargo test
```

You should see `test result: ok. 43 passed` for the unit tests (they include `contract_matches_the_typescript_engine_on_generated_scenarios` and `random_operations_keep_the_invariants`, which take a minute or two each), and then `test result: ok. 1 passed` for the integration test `full_game_loop_on_sandbox`. The integration test builds the WebAssembly contract and plays a full game on a local NEAR Sandbox node (first run downloads the sandbox binary).

### 4. Read the live contract

No account needed:

```sh
node bots/src/status.ts notit-play.testnet
```

You should see the current round, the cost right now, who is It, and the line `access keys     0 (locked: nobody can redeploy or change it)`.

The same with plain RPC:

```sh
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"query",
  "params":{"request_type":"view_access_key_list","finality":"final","account_id":"notit-play.testnet"}}'
```

You should see `"keys":[]`.

The contract also reports where its source is (NEP-330):

```sh
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"query",
  "params":{"request_type":"call_function","finality":"final","account_id":"notit-play.testnet",
            "method_name":"contract_source_metadata","args_base64":"e30="}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'
```

You should see `"link":"https://github.com/arshiaxbt/notit"`.

### 5. Play in the browser

Open https://arshiaxbt.github.io/notit/.

1. The page opens in Testnet mode and shows the live round: countdown, falling cost, who is It.
2. Press **Play as guest**. You should see a new testnet account created and 1,000 NOTIT in your balance within about ten seconds.
3. Wait until the cost is something you are willing to burn and press **I'll do it**. You should see the round marked as saved by you, and your account shown as It.
4. Do nothing for a round. If nobody else volunteers, you should see every other balance cut 15 % and your "collected" total rise.
5. Switch to **Demo** in the header for the same game simulated in your browser on a fast clock, with no network.
6. Open the **Lab** tab and move the crowd-size slider. You should see the failure rate rise with the crowd, next to the theory curve.

### 6. Run the web app locally

```sh
npm run dev
```

Open the printed URL. You should see the same app.

## Deployments

| | `notit-play.testnet` | `notit-live.testnet` |
|---|---|---|
| Round length | 3 minutes | 1 hour |
| Parameters | cost 5 % → 0.2 % of supply, cut 15 %, at most 8 charged rounds in a row, claim 1,000 NOTIT | same |
| Funded for storage | 14 NEAR | 9.5 NEAR |
| Code hash | SHA-256 `6ad5c6c2e1151495d5860be629d3bca3d52195768b98f746d29961f637f9ff1d` (shown by NEAR RPC in base58 as `8C3HHxpY9N2FCmKkYJN6GdFPmBGXip3UMBfHg5nrecb6`) | same |

The contract pays for its own history records (see Limits). Anybody can send either account NEAR to extend that. The deployed WebAssembly is committed as [`contract/deployed/notit.wasm`](contract/deployed/notit.wasm): `sha256sum contract/deployed/notit.wasm` prints the hash above, and the `view_account` RPC query returns the same hash as `code_hash` for both accounts. A local rebuild can differ in a few bytes, because file paths and line numbers are part of the compiled code and the build is only bit-for-bit reproducible inside the cargo-near Docker image.

A small fleet of bots (`bots/`) plays both deployments so that rounds are sometimes saved and sometimes not.

## Repository layout

| Path | What |
|---|---|
| `contract/` | The contract (Rust, near-sdk). `src/lib.rs` is the game, `src/ft.rs` the token standard, `src/views.rs` the read methods, `tests/sandbox.rs` the integration test |
| `engine/` | The same rules in TypeScript, the simulator, and the lab |
| `web/` | The web app (Vite, React). Demo mode runs the engine in the browser; Testnet mode talks to the contract |
| `bots/` | Strategy bots that keep the testnet deployments alive |
| `docs/SPEC.md` | The specification both implementations were written from |
| `docs/MECHANISM.md` | Incentives, equilibrium analysis, parameters, limits |
| `scripts/` | `deploy.sh`, `lock.sh` |

## How correctness is checked

- **Two independent implementations.** The contract and the TypeScript engine were written separately from docs/SPEC.md. A generator in the engine produces 42 scenarios (2,075 steps: claims, volunteers, transfers, unregistrations, long idle gaps, refused actions). A contract test replays them and requires the stored state to match integer for integer.
- **Unit tests** for each rule in the specification, on both sides.
- **Integration test** on NEAR Sandbox with the compiled contract.
- **Independent reviews.** Before the contract was written, the design was reviewed as a mechanism; that review found that the first version's uniform cut was economically neutral, which led to the current rules (see docs/MECHANISM.md). Before the contract was locked, a separate adversarial code review fuzzed it and exercised it on a sandbox node; it found no way to block the contract or to create or take tokens, and its smaller findings were fixed or are listed as limits. Its fuzz test is in the repository (`contract/src/fuzz.rs`): random operations over 7 parameter sets, including extreme ones and transfer-and-call refunds, with invariants checked after every step. `cargo test` runs a quick version; the audit ran `NOTIT_FUZZ_SEEDS=40 NOTIT_FUZZ_STEPS=700`.
- **CI** runs all of the above and checks that the lab output is reproducible (`.github/workflows/ci.yml`).

## Limits

- Testnet only; the tokens have no value. Nothing here is financial advice.
- The faucet claim has no sybil resistance.
- Not audited. Known weaknesses are listed in [docs/MECHANISM.md](docs/MECHANISM.md#limits-and-known-weaknesses).
- The lab simulates scripted strategies. It shows what the rules imply for those strategies, not how people behave.

## Hackathon disclosures

- All code in this repository was written on 13 and 14 November 2026, inside the hackathon window (announcement on 19 October to the deadline on 14 November 2026). There is no earlier codebase.
- Built with AI assistance: Claude Code wrote most of the code under the team lead's direction, including the independent mechanism review and the two separate implementations.
- Libraries: near-sdk, primitive-types, near-sandbox, near-api, cargo-near-build, tokio, testresult (contract and its tests); near-api-js, @hot-labs/near-connect (chain access and wallets); React, Vite, Vitest, TypeScript (web); the contract was scaffolded with `cargo near new`.
- Solo developer.

## License

MIT. See [LICENSE](LICENSE).

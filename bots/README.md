# Bots

A small fleet of testnet accounts that play Not It, so a deployment has live rounds: some saved, some not.

| Strategy | What it does |
|---|---|
| `guardian` | In the last quarter of a round, volunteers once the cost is below what a collapse would cost it. Never while it is It. |
| `usurper` | Takes over when nobody is It, the game is dormant, or It has collected twice in a row. Otherwise defends like a guardian in 60 % of rounds. |
| `flaky` | A guardian that only shows up in 45 % of rounds. This is where collapses come from. |
| `saint` | Steps up early in one round out of five, whatever it costs. |
| `idle` | Holds and never acts. Idle holders are the ones who pay It. |

## Re-dealing

The bots share one operator. A small closed crowd ends with one account holding almost everything, after which nobody else can afford to volunteer and the game goes to sleep (lab experiments B2 and C show the same). So when one bot holds more than 60 % of the fleet's tokens, it sends some back to the others with ordinary `ft_transfer` calls. This is fleet housekeeping to keep the demonstration running. It is not part of the contract, and it does not touch any account outside the fleet.

## Run

From the repository root:

```sh
npm ci
node bots/src/setup.ts <contract.testnet> 6   # create 6 faucet-funded accounts, claim NOTIT; writes .bots.json
node bots/src/run.ts                          # play until stopped
node bots/src/run.ts --once                   # one pass, for cron
node bots/src/status.ts <contract.testnet>    # read-only: state, lock status, each bot's position
```

`.bots.json` holds testnet secret keys and is git-ignored. In GitHub Actions each fleet is read from a repository secret, `BOTS_FAST_JSON` and `BOTS_LIVE_JSON` (`.github/workflows/bots.yml`).

Environment: `NEAR_RPC_URLS` (comma-separated), `NEAR_FAUCET_URL`, `BOTS_FILE`, `CONTRACT_ID` (override the contract in the fleet file), `RUN_SECONDS`.

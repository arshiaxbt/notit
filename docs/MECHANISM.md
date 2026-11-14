# The mechanic

Not It is a repeated volunteer's dilemma with real transfers. This page states the rules, shows why the stakes are not an accounting illusion, works out what rational holders do, and lists what the mechanic does not do. The normative rules are in [SPEC.md](SPEC.md); the code is in [`contract/src/lib.rs`](../contract/src/lib.rs).

## Rules

1. Time is split into rounds (3 minutes on the `fast` deployment, 1 hour on `live`).
2. In each round the **sacrifice cost** starts at 5 % of the supply and falls linearly to 0.2 % at the deadline.
3. The first holder to call `volunteer` burns the current cost from their own balance. The round is **saved** and that holder becomes **It**.
4. If a round ends with no volunteer, every balance is cut 15 % and the whole cut is paid to It. At most 8 unsaved rounds in a row are charged; then the game is dormant until somebody volunteers. Before the first volunteer there is no It and nothing is charged.
5. No parameter can change after deployment. The contract stores no owner, and the deployed account has no access keys.

## Why a uniform cut would be fake, and what replaced it

The first draft cut every balance by 15 % and burned the cut, and paid every holder 3 % after a saved round. An independent review pointed out that this is economically neutral: if everybody loses the same percentage, nobody's share of the supply changes, so in ownership terms nobody loses anything and "never volunteer" is the dominant strategy. A closed token system cannot impose a loss on all holders at once, because ownership shares always add up to one.

So the penalty has to be a transfer between holders. In the shipped rules:

- **A save** moves value from the volunteer to everybody: the burn shrinks the supply, so every other holder's share grows.
- **A collapse** moves value from everybody to It: 15 % of every balance, including It's own, is collected and credited to It. The total supply does not change.

Both are real changes in ownership. The 3 % mint was removed because it was neutral.

## One round, for one holder

Take a holder with balance `x` who is not It, in a round where a collapse would be charged ("armed"), facing cost `c`:

| What happens | Effect on this holder |
|---|---|
| They volunteer | lose `c`, become It |
| Somebody else volunteers | lose nothing (their share rises slightly from the burn) |
| Nobody volunteers | lose `0.15 × x` to It |

This is the volunteer's dilemma: everybody is better off if somebody acts, and everybody would rather it were somebody else.

### Who can afford to care

Ignoring the value of becoming It, volunteering beats a collapse only if `0.15 × x > c`. At the floor price (`c` = 0.2 % of supply) that needs `x` above **1.33 % of the supply**. Smaller holders cannot rationally save the round alone at any moment. With 75 or more equal holders nobody clears the threshold, and a crowd that only looks one round ahead lets every round collapse.

### The bystander effect

Suppose `n` identical holders (It excluded) each clear the threshold and decide in the final block, where the cost is `c`. In the symmetric mixed equilibrium each volunteers with probability `p = 1 − q^(1/(n−1))`, where `q = c / (0.15 × x)`, and the round fails with probability

```
P(fail) = q^(n / (n − 1))
```

With equal holders, `x` shrinks as the crowd grows, so `q` and the failure rate both rise. More people who could act means it is less likely that anybody does. `npm run lab` runs this experiment against the real rules and prints the simulated failure rate next to the formula.

### The falling price is an auction for being It

Being It is worth the expected collapse income of the following rounds: up to 8 rounds of 15 % of everybody else's balance. When the crowd is unreliable, that is worth a lot, so somebody volunteers early and pays a high price for it. When the crowd is reliable, being It is worth almost nothing, and rounds are saved near the deadline at the floor price, if at all.

So the moment a round is saved is a market price for how much holders distrust each other. The contract records it (`ms_left` on every save, and the "closest call" statistic).

It has no reason to volunteer while collapses are being charged. After 8 charged rounds the game goes dormant and It earns nothing more; volunteering again re-arms it, at the price of a fresh burn.

## What rational play looks like

- **Two large holders.** Whichever one is not It saves each round near the deadline, because a collapse would cost them 15 % and the floor price is far less. They alternate being It and never collect. Each save burns part of their balance, which benefits the small holders who do nothing. Large holders are taxed for everybody's protection.
- **Many small holders, nobody above the threshold.** Nobody can save a round rationally on their own. Whoever is It collects for 8 rounds. Being It is then worth far more than the floor price, so somebody takes it over. The outcome is a contest to be It, paid for with burns.
- **Idle holders.** An account that claims tokens and leaves is charged every time a round collapses. Value moves from holders who do not show up to holders who do.
- **A bot that always saves at the last second.** It becomes It after its first save and then has no reason to save the next round, so it cannot simply protect its own balance forever. Timing also matters: a transaction aimed at the last block can miss it, and then the round collapses. The `round` and `max_cost` guards on `volunteer` stop a late transaction from saving the next round at the top price instead.

## What the lab shows

`npm run lab` runs the real rules with scripted strategies (output in [lab-output.txt](lab-output.txt)):

- **A. Bystander effect.** With identical holders deciding in the final block, the simulated failure rate follows the formula above: about 1 % with 3 players, 12 % with 10, 40 % with 30, 79 % with 60, and 100 % from 75 players up, where nobody clears the threshold.
- **B. Large holders present.** With 50 holders and Pareto-distributed balances, no round ever fails. The five largest holders pay 54 % of all burns and their share of the supply falls from 45 % to 10 %. Protection is paid for by the largest holders.
- **B2. A dispersed crowd.** With 100 equal holders at 1 % each, holders who only look one round ahead never volunteer: It collects for 8 rounds, ends with 73 % of the supply, and the game sleeps. Holders who value being It save 99 % of rounds, but burn 88 % of the supply competing for it.
- **C. Idle holders.** With 30 holders who never act among 40, the idle holders' share of the supply goes from 75 % to 0 %.

## Parameters

| Parameter | Value | Why |
|---|---|---|
| Cut | 15 % | Large enough that a holder above the threshold cares, small enough that one failure is survivable |
| Cost at round open | 5 % of supply | Above the one-round collapse loss for any holder with less than a third of the supply, so nobody saves at the top price for defence alone |
| Cost at the deadline | 0.2 % of supply | Sets the threshold at 1.33 % of supply |
| Charged rounds in a row | 8 | Bounds what an unattended game can take from idle holders: at most 1 − 0.85^8 = 73 % |
| Faucet claim | 1,000 NOTIT, once per account | A newcomer can afford the floor price while the supply is under 500,000 NOTIT |

## Limits and known weaknesses

- **Sybil claims.** The faucet gives 1,000 NOTIT to any account once. Creating accounts is cheap, so claims can be farmed. Splitting a balance across accounts gains nothing inside the game (the cost is fixed and the cut is proportional), but farming the faucet dilutes everybody. This is a testnet demonstration with no sybil resistance; a real launch would need a different distribution.
- **A claim rush makes a cheap, lasting It.** The cost is priced on the supply when the round opened. If many accounts claim during one round, whoever volunteers in that round becomes It at the old, low price, and from the next round the floor price may be more than any single claim can pay. It then collects for 8 rounds and is the only one who can afford to re-arm the game.
- **Large crowds price out newcomers.** The cost is a share of the supply, so once the supply passes 500,000 NOTIT a fresh 1,000-NOTIT claim cannot pay the floor. Those holders can only be charged, or buy more.
- **An active It can keep collecting.** The 8-round cap protects holders from an absent It, not an active one: It can volunteer again at the floor price and re-arm the game. Holders who never act are drained by whoever keeps paying the floor price (lab experiment C). Competition is the protection: when two or more holders want to be It, rounds get saved and nobody is charged.
- **It is favoured by speed.** After a collapse run, being It is valuable and the first transaction wins. Faster participants win more often.
- **Function-call keys can burn.** `volunteer` needs no deposit, so an application holding a function-call key for this contract can burn up to 5 % of the supply from the user's balance per round. This is deliberate, to allow one-tap play; `ft_transfer` still requires 1 yoctoNEAR, so such a key cannot move tokens to somebody else.
- **Block timestamps.** Rounds are measured with the block timestamp, which block producers set once per block. "Seconds left" is therefore accurate to about one block.
- **Indexers.** A collapse changes every balance through one index update and is reported by a single `rounds_closed` event, not by a transfer event per holder. An indexer that only replays NEP-141 transfer events will drift from `ft_balance_of`.
- **Storage.** The contract pays for the history and hero records from its own balance: about 0.0015 NEAR per saved round and 0.0022 NEAR per new volunteer. If the balance runs out, calls that add a record fail until somebody sends the account NEAR, which anybody can do. The deployments were funded before they were locked (amounts in the README).
- **What it does not show.** The lab uses scripted strategies. It shows what the rules imply for those strategies, not how people behave.

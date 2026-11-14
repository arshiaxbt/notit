# The mechanic

**What it is, in one sentence:** a recurring Dutch auction for a seat ("It") that collects 15 % from every other holder whenever a round finds no bidder. For large holders it is a volunteer's dilemma; for everyone else it is a last-mover contest in the family of Fomo3D, with a falling entry price and a levy on holders in place of a pot. It is zero-sum in ownership, and close to zero expected value under competitive play.

This page states the rules, shows why the stakes are not an accounting illusion, works out what rational holders do, and lists the objections we know of. It was reviewed twice as a mechanism, both times by a separate Claude session that had the rules but not the reasoning behind them (there was no human review): once before the contract was written, and once against the rules as deployed. The second review corrected several claims that an earlier version of this page got wrong; the corrections are marked. The normative rules are in [SPEC.md](SPEC.md); the code is in [`contract/src/lib.rs`](../contract/src/lib.rs).

## Rules

1. Time is split into rounds (3 minutes on `notit-play.testnet`, 1 hour on `notit-live.testnet`).
2. In each round the **cost** starts at 5 % of the supply at round open and falls linearly to 0.2 % at the deadline.
3. The first holder to call `volunteer` burns the current cost from their own balance. The round is **saved** and that holder becomes **It**. Later callers in the same round are refused and pay nothing.
4. If a round ends with no volunteer, every balance is cut 15 % and the whole cut is paid to It. At most 8 unsaved rounds in a row are charged; then the game is asleep until somebody volunteers. Before the first volunteer there is no It and nothing is charged.
5. No parameter can change after deployment. The contract stores no owner, and the deployed accounts have no access keys.

## Why a uniform cut would be fake, and what replaced it

The first draft cut every balance by 15 % and burned the cut, and paid every holder 3 % after a saved round. The first review pointed out that this is economically neutral: if everybody loses the same percentage, nobody's share of the supply changes, so in ownership terms nobody loses anything and "never volunteer" is dominant. A closed token system cannot impose a loss on all holders at once, because ownership shares always add up to one.

So the penalty has to be a transfer between holders. In the shipped rules:

- **A save** moves value from the volunteer to everybody: the burn shrinks the supply, so every other holder's share grows.
- **An unsaved round** moves value from everybody to It: 15 % of every balance, It's own included, is collected and credited to It. It gets its own cut back, so in effect It is exempt. The total supply does not change.

## One round, for one holder

Take a holder with balance `x` who is not It, in a round where an unsaved close would be charged, facing cost `c`:

| What happens | Effect on this holder |
|---|---|
| They volunteer | lose `c`, become It |
| Somebody else volunteers | lose nothing (their share rises slightly from the burn) |
| Nobody volunteers | lose `0.15 × x` to It |

Every holder except It is better off if somebody acts, and would rather it were somebody else. It is better off if nobody does.

### Who can afford to care

Ignoring the value of becoming It, volunteering beats an unsaved round only if `0.15 × x > c`. At the floor price (`c` = 0.2 % of the supply at round open) that needs a balance above **1.33 % of that supply**. Smaller holders cannot rationally save the round alone at any moment. With 75 or more equal holders nobody clears the threshold.

### The bystander effect, for holders who look one round ahead

Suppose `n` identical holders (It excluded) each clear the threshold, ignore the value of being It, and decide at the same moment in the final block, where the cost is `c`. Write `q = c / (0.15 × x)`.

In the textbook volunteer's dilemma every volunteer pays. Then each volunteers with probability `p = 1 − q^(1/(n−1))` and the round fails with probability `q^(n/(n−1))`.

**Correction.** An earlier version of this page used that formula for our rules. It does not apply as is: under rule 3 only the first volunteer pays. A holder who submits pays `c` only if their transaction is first among the submitters, which happens with probability `(1 − (1−p)^n) / (n·p)`. The indifference condition is therefore

```
q · (1 − (1−p)^n) / (n·p) = (1−p)^(n−1)        P(fail) = (1−p)^n
```

Volunteering is cheaper in expectation, so holders volunteer more readily and rounds fail less often than in the textbook game: about 0.3 % with 3 holders, 3.6 % with 10, 20 % with 30 and 66 % with 60, against 1.2 %, 12 %, 40 % and 81 % if every volunteer paid; in both cases 100 % from 75 holders up, where nobody clears the threshold. The direction is the same: with equal holders, `x` shrinks as the crowd grows, so the failure rate rises with the crowd.

The lab plays this equilibrium probability as a script. Agreement between the simulated rate and the formula checks the arithmetic and the rules engine; it does not show that people behave this way.

### Forward-looking holders: the seat is an auction, and its rents are competed away

Being It is worth exemption from the cut plus 15 % of everyone else per unsaved round. Let `π` be the chance a round goes unsaved and `W` the advantage of being It when a round opens, with `S` the supply. If the round is unsaved, It gains `0.15 × (S − x)` and anyone else loses `0.15 × x`, a difference of `0.15 × S`, and It keeps the seat; if it is saved, somebody else takes the seat. So

```
W = π · (0.15·S + W)      →      W = 0.15·S · π / (1 − π)
```

If `W` exceeded the floor price, every holder who could afford it would submit in the final block (a refused transaction costs nothing) and the round would always be saved, a contradiction. So `W ≤ 0.2 % × S`, which gives

```
π ≤ 0.2 / (15 + 0.2) ≈ 1.3 %
```

With risk-neutral, equally fast, non-colluding holders, rounds are saved at or near the floor price about 98.7 % of the time. It's expected income per round (`π × 15 %`, about 0.2 % of supply) equals the next volunteer's burn. The rents are fully dissipated: in expectation nobody gains share, idle holders included, and the supply burns about 0.2 % per round. Lab experiment D reports this bound next to the simulated rate.

Two consequences:

- The bystander table above describes holders who look one round ahead only. Forward-looking holders save far more often.
- Profits go to whoever is faster than the rest, or who faces a crowd that fails more often than 1.3 %. "Idle holders are taxed" is what happens out of equilibrium, when too few holders compete for the seat.

**What the save time tells you.** While the seat is worth between the floor and the top price (0.2 % to 5 % of supply), the moment a round is saved is a price: the earlier the save, the more the seat was worth, which means the more often holders expect rounds to go unsaved. Outside that range it is not a price. If the seat is worth more than 5 % (a failure chance above roughly a quarter), it sells in the first block and latency decides who gets it. The contract records the save time (`ms_left` on every save).

## What rational play looks like

- **Two or more large, non-colluding holders.** Whichever is not It saves each round near the deadline, because an unsaved round would cost them 15 % and the floor price is far less. They alternate being It and rarely collect. Each save burns part of their balance, which benefits the small holders who do nothing. *Correction: this needs at least two such holders. A single large holder becomes It at its first save and then collects.*
- **Many small holders, nobody above the threshold.** Nobody can save a round rationally for defence alone. Being It is then worth more than the floor price, so somebody takes it over. The outcome is a contest for the seat, paid for with burns.
- **Idle holders.** An account that claims tokens and leaves is charged every time a round goes unsaved, which in equilibrium is rare and out of equilibrium is not.
- **A bot that saves whenever it is not It.** *Correction: an earlier version said such a bot "cannot protect its balance forever". It can.* While it is It, it is exempt from the cut; when somebody else takes the seat, it saves the next round. That costs at most the floor price per round, is worth it only for a balance above the threshold, and fails when its transaction misses the last block. The `round` and `max_cost` guards on `volunteer` stop a late transaction from saving the next round at the top price instead.
- **An It that stays active.** It has no reason to volunteer while unsaved rounds are being charged. Once 8 have been charged and the game is asleep, volunteering again at the floor re-arms it. A lone active It facing holders who never act went from 73 % to 92.6 % to 98 % to 99.4 % of the supply over four such cycles (checked against the rules engine). Re-arming pays while the other holders own more than about 0.3 % of the supply.

## What the lab shows

`npm run lab` runs the real rules with scripted strategies (output in [lab-output.txt](lab-output.txt)):

- **A. Bystander effect.** With identical holders deciding in the final block and playing the equilibrium probability, the simulated share of unsaved rounds follows the first-pays equilibrium: 0.3 % with 3 holders, 3.7 % with 10, 20 % with 30, 67 % with 60, and 100 % from 75 up. The table prints the textbook figure (every volunteer pays) beside it for comparison.
- **B. Large holders present.** With 50 holders and Pareto-distributed balances (18 of the 50 above the threshold), no round ever fails. The five largest holders pay 54 % of all burns and their share of the supply falls from 45 % to 10 %.
- **B2. A dispersed crowd.** With 100 equal holders at 1 % each, holders who only look one round ahead never volunteer: It collects for 8 rounds, ends with 73 % of the supply, and the game sleeps. Holders who value being It save 99 % of rounds, but burn 88 % of the supply competing for it.
- **C. Idle holders.** With 30 holders who never act among 40, the idle holders' share of the supply goes from 75 % to 0 %.
- **D. Forward-looking holders.** The bound above is 1.32 % with the deployed parameters. A scripted strategy that values the seat from the last 20 rounds stays within it at 20, 50 and 100 equal holders (0 %, 0 %, 1.0 % unsaved) and exceeds it at 200 (4.0 %), because its short memory lets a round fail every twenty-odd rounds; the table says so. The symmetric equilibrium in A is also not the only one: there are asymmetric ones in which one designated holder always volunteers and no round fails.

## Parameters

| Parameter | Value | Why |
|---|---|---|
| Cut | 15 % | Large enough that a holder above the threshold cares, small enough that one unsaved round is survivable |
| Cost at round open | 5 % of supply | Caps what one round can charge for the seat. A defender of any size waits anyway, because the price only falls |
| Cost at the deadline | 0.2 % of supply | Sets the one-round threshold at 1.33 % of supply, and the competitive failure rate at about 1.3 % |
| Charged rounds in a row | 8 | Bounds what an unattended game can take from idle holders while It is absent: at most 1 − 0.85^8 = 73 % |
| Faucet claim | 1,000 NOTIT, once per account, at most 100,000 claims | A newcomer can afford the floor price while the supply is under 500,000 NOTIT |
| Storage fee | 0.005 NEAR per registered account | Pays for the account record and the records that outlive it; half is returned on unregistering |

## Objections we know of

- **"This is Fomo3D."** Structurally, yes: a last-mover game. The last actor collects when the timer runs out. The differences are a Dutch entry price in place of a rising one, and a levy on holders in place of a pot funded by entries. The volunteer's dilemma applies only to holders above the threshold.
- **Pooling restores neutrality.** A balance held in It's account is exempt from the cut. Holders can pool inside It's account, or in a contract that volunteers on their behalf, and then tax everyone outside the pool. If everyone pools, the cut is uniform again and nothing is at stake. Two large holders also do better colluding than alternating.
- **Zero expected value under rational play.** See "Forward-looking holders" above: with competition the seat's rents are burned away. What remains for a participant is speed, risk appetite, and other holders' mistakes.
- **Speed and congestion.** The first transaction wins. After several unsaved rounds the seat is valuable and faster participants win more often. As with Fomo3D's winner, It could also profit by congesting the final blocks of a round; we have not tested how feasible that is on NEAR.
- **An active It never lets the game sleep.** The 8-round cap protects holders from an absent It, not an active one (see above). Competition for the seat is the protection.

## Limits

- **Sybil claims.** The faucet gives 1,000 NOTIT to any account once. Creating accounts is cheap, so claims can be farmed. Splitting a balance across accounts gains nothing inside the game (the cost is fixed and the cut is proportional), but farming the faucet dilutes everybody. This is a testnet demonstration with no sybil resistance; a real launch would need a different distribution.
- **A claim rush makes a cheap, lasting It.** The cost is priced on the supply when the round opened. If many accounts claim during one round, whoever volunteers in that round becomes It at the old, low price, and from the next round the floor price may be more than any single claim can pay.
- **Large crowds price out newcomers.** The cost is a share of the supply, so once the supply passes 500,000 NOTIT a fresh 1,000-NOTIT claim cannot pay the floor. Those holders can only be charged, or buy more.
- **Function-call keys can burn.** `volunteer` needs no deposit, so a function-call key for this contract can burn up to 5 % of the supply from the holder's balance per round. This is deliberate: it is what lets a guest's browser hold a key that can only volunteer. `ft_transfer` still requires 1 yoctoNEAR, so such a key cannot move tokens to somebody else.
- **Block timestamps.** Rounds are measured with the block timestamp, which block producers set once per block. "Seconds left" is therefore accurate to about one block.
- **Indexers.** An unsaved round changes every balance through one index update and is reported by a single `rounds_closed` event, not by a transfer event per holder. An indexer that only replays NEP-141 transfer events will drift from `ft_balance_of`.
- **Storage.** The contract pays for the history and volunteer records from its own balance: about 0.0015 NEAR per saved round and 0.0022 NEAR per new volunteer. If the balance runs out, calls that add a record fail until somebody sends the account NEAR, which anybody can do. The deployments were funded before they were locked; the README gives the amounts and how long they last.
- **What the lab does not show.** It uses scripted strategies. It shows what the rules imply for those strategies, not how people behave. The forward-looking result is derived by hand and compared with one family of scripted strategies; it is not a proof for all strategies.
- **Rule changes we considered and did not make.** A higher opening price (15 %) would widen the range in which the save time is a price. Barring It from volunteering would not stop re-arming, because a second account does the same job. A random winner among same-block volunteers would blunt the speed advantage but is untested code. The deployed rules are locked.

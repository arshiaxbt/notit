//! Unit tests for the rules in docs/SPEC.md. Time is driven through the mocked block timestamp.

use crate::math::{PPM, RAY};
use crate::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{PromiseResult, testing_env};

const SEC: u64 = 1_000_000_000;
const ROUND: u64 = 100 * SEC;
const T0: u64 = 1_000_000 * SEC;
const NOTIT: u128 = 1_000_000_000_000_000_000;
const CLAIM: u128 = 1_000 * NOTIT;
const FEE: u128 = 5_000_000_000_000_000_000_000;

fn at(who: &str, now: u64, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(who.parse().unwrap())
        .current_account_id("notit.test".parse().unwrap())
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}

fn params() -> Params {
    Params {
        round_ns: U64(ROUND),
        max_cost_ppm: 50_000,
        min_cost_ppm: 2_000,
        cut_ppm: 150_000,
        claim_amount: U128(CLAIM),
        claim_cap: 100_000,
    }
}

fn deploy() -> Contract {
    at("deployer.test", T0, 0);
    Contract::new(params())
}

/// Start of round `k` plus `offset` nanoseconds.
fn t(round: u64, offset: u64) -> u64 {
    T0 + round * ROUND + offset
}

fn id(who: &str) -> AccountId {
    who.parse().unwrap()
}

fn claim(c: &mut Contract, who: &str, now: u64) {
    at(who, now, FEE);
    c.claim();
}

fn volunteer(c: &mut Contract, who: &str, now: u64) -> u128 {
    at(who, now, 0);
    c.volunteer(None, None).0
}

fn bal(c: &Contract, who: &str, now: u64) -> u128 {
    at("viewer.test", now, 0);
    c.ft_balance_of(id(who)).0
}

fn state(c: &Contract, now: u64) -> StateView {
    at("viewer.test", now, 0);
    c.get_state()
}

fn close(a: u128, b: u128, tolerance: u128) -> bool {
    a.abs_diff(b) <= tolerance
}

/// alice, bob and carol each claim 1,000 NOTIT in round 0.
fn three_holders() -> Contract {
    let mut c = deploy();
    for who in ["alice.test", "bob.test", "carol.test"] {
        claim(&mut c, who, t(0, SEC));
    }
    c
}

/// Three holders; alice volunteers at the start of round 1 and is It.
fn alice_is_it() -> (Contract, u128) {
    let mut c = three_holders();
    let cost = volunteer(&mut c, "alice.test", t(1, 0));
    (c, cost)
}

// ---------------------------------------------------------------- claims

#[test]
fn claim_mints_once_and_registers() {
    let mut c = deploy();
    claim(&mut c, "alice.test", t(0, SEC));
    assert_eq!(bal(&c, "alice.test", t(0, 2 * SEC)), CLAIM);
    let acct = c.get_account(id("alice.test"));
    assert!(acct.registered && acct.claimed && !acct.is_it);
    assert_eq!(c.ft_total_supply().0, CLAIM);
    assert_eq!(c.get_state().claims_made, 1);
}

#[test]
#[should_panic(expected = "ERR_ALREADY_CLAIMED")]
fn claim_twice_is_rejected() {
    let mut c = deploy();
    claim(&mut c, "alice.test", t(0, SEC));
    claim(&mut c, "alice.test", t(0, 2 * SEC));
}

#[test]
#[should_panic(expected = "ERR_STORAGE")]
fn claim_without_storage_fee_is_rejected() {
    let mut c = deploy();
    at("alice.test", t(0, SEC), 0);
    c.claim();
}

#[test]
#[should_panic(expected = "ERR_CLAIMS_CLOSED")]
fn claim_cap_closes_the_faucet() {
    at("deployer.test", T0, 0);
    let mut c = Contract::new(Params {
        claim_cap: 1,
        ..params()
    });
    claim(&mut c, "alice.test", t(0, SEC));
    claim(&mut c, "bob.test", t(0, 2 * SEC));
}

#[test]
fn a_claim_does_not_change_the_cost_of_the_open_round() {
    let mut c = three_holders();
    let before = state(&c, t(1, 10 * SEC)).cost_now.0;
    claim(&mut c, "dave.test", t(1, 10 * SEC));
    assert_eq!(state(&c, t(1, 10 * SEC)).cost_now.0, before);
    assert_eq!(state(&c, t(2, 0)).round_supply.0, 4 * CLAIM);
}

// ---------------------------------------------------------------- dormant before anyone is It

#[test]
fn nothing_is_charged_before_the_first_volunteer() {
    let mut c = three_holders();
    let s = state(&c, t(40, SEC));
    assert_eq!(s.round, 40);
    assert!(s.it.is_none());
    assert!(!s.armed);
    assert_eq!(s.stats.rounds_collapsed, 0);
    assert_eq!(s.index, RAY.to_string());
    assert_eq!(bal(&c, "bob.test", t(40, SEC)), CLAIM);

    at("anyone.test", t(40, SEC), 0);
    assert_eq!(
        c.poke(),
        1,
        "one loop pass, then the dormant rounds are skipped"
    );
    assert_eq!(c.get_history_len(), 0);
    assert_eq!(c.get_state().round_supply.0, 3 * CLAIM);
}

#[test]
#[should_panic(expected = "ERR_NOTHING_TO_SAVE")]
fn cannot_volunteer_while_nobody_holds_anything() {
    let mut c = three_holders();
    // Round 0 opened before the claims, so its supply snapshot is zero.
    volunteer(&mut c, "alice.test", t(0, 50 * SEC));
}

// ---------------------------------------------------------------- cost and volunteering

#[test]
fn cost_falls_linearly_from_max_to_min() {
    let c = three_holders();
    let supply = 3 * CLAIM;
    assert_eq!(state(&c, t(1, 0)).cost_now.0, supply * 50_000 / PPM);
    assert_eq!(state(&c, t(1, ROUND / 2)).cost_now.0, supply * 26_000 / PPM);
    // floor(48_000 × (ROUND − 1) / ROUND) = 47_999 → 2_001 ppm one nanosecond before the deadline.
    assert_eq!(state(&c, t(1, ROUND - 1)).cost_now.0, supply * 2_001 / PPM);
}

#[test]
fn volunteer_burns_the_cost_and_becomes_it() {
    let (c, cost) = alice_is_it();
    assert_eq!(cost, 3 * CLAIM * 50_000 / PPM); // 150 NOTIT
    assert_eq!(bal(&c, "alice.test", t(1, SEC)), CLAIM - cost);
    assert_eq!(bal(&c, "bob.test", t(1, SEC)), CLAIM);

    let s = state(&c, t(1, SEC));
    assert!(s.saved);
    assert_eq!(s.hero, Some(id("alice.test")));
    assert_eq!(s.it, Some(id("alice.test")));
    assert_eq!(s.cost_now.0, 0);
    assert_eq!(s.total_supply.0, 3 * CLAIM - cost);
    assert_eq!(s.stats.total_burned.0, cost);
    assert_eq!(s.stats.closest_call_ms, Some(100_000));
    assert!(c.get_account(id("alice.test")).is_it);

    // The save is counted when the round closes; nobody's balance moves.
    let s = state(&c, t(2, SEC));
    assert_eq!(s.stats.rounds_saved, 1);
    assert_eq!(s.stats.current_streak, 1);
    assert!(!s.saved && s.armed);
    assert_eq!(bal(&c, "bob.test", t(2, SEC)), CLAIM);

    assert_eq!(
        c.get_history(0, 10),
        vec![Entry::Saved {
            round: 1,
            hero: id("alice.test"),
            cost: U128(cost),
            ms_left: 100_000
        }]
    );
    let heroes = c.get_heroes(0, 10);
    assert_eq!(
        (heroes.len(), heroes[0].saves, heroes[0].burned.0),
        (1, 1, cost)
    );
}

#[test]
#[should_panic(expected = "ERR_ALREADY_SAVED")]
fn second_volunteer_in_a_round_is_rejected() {
    let (mut c, _) = alice_is_it();
    volunteer(&mut c, "bob.test", t(1, SEC));
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT")]
fn volunteer_needs_enough_balance() {
    let mut c = three_holders();
    volunteer(&mut c, "stranger.test", t(1, 0));
}

#[test]
#[should_panic(expected = "ERR_WRONG_ROUND")]
fn round_guard_rejects_a_late_transaction() {
    let mut c = three_holders();
    // Signed for round 1, lands in round 2 at the top of the cost curve.
    at("alice.test", t(2, 0), 0);
    c.volunteer(Some(1), None);
}

#[test]
#[should_panic(expected = "ERR_COST_TOO_HIGH")]
fn cost_guard_rejects_an_unexpected_price() {
    let mut c = three_holders();
    at("alice.test", t(1, 0), 0);
    c.volunteer(Some(1), Some(U128(10 * NOTIT)));
}

#[test]
fn guards_pass_when_they_match() {
    let mut c = three_holders();
    at("alice.test", t(1, ROUND - SEC), 0);
    let cost = c.volunteer(Some(1), Some(U128(10 * NOTIT))).0;
    assert!(cost <= 10 * NOTIT);
}

#[test]
fn closest_call_tracks_the_minimum() {
    let mut c = three_holders();
    volunteer(&mut c, "alice.test", t(1, ROUND - 5 * SEC));
    volunteer(&mut c, "bob.test", t(2, ROUND - 20 * SEC));
    assert_eq!(c.get_state().stats.closest_call_ms, Some(5_000));
    assert_eq!(state(&c, t(3, SEC)).stats.longest_streak, 2);
    assert_eq!(state(&c, t(3, SEC)).it, Some(id("bob.test")));
}

// ---------------------------------------------------------------- collapse pays It

#[test]
fn an_unsaved_round_pays_the_cut_to_it() {
    let (mut c, cost) = alice_is_it();
    let now = t(3, SEC); // round 2 ended with no volunteer
    let supply = 3 * CLAIM - cost; // 2,850
    let pot = supply - supply * 85 / 100; // 427.5

    assert_eq!(bal(&c, "bob.test", now), CLAIM * 85 / 100);
    assert_eq!(bal(&c, "carol.test", now), CLAIM * 85 / 100);
    // It is cut like everyone else and then receives the whole pot.
    assert!(close(
        bal(&c, "alice.test", now),
        (CLAIM - cost) * 85 / 100 + pot,
        1
    ));
    // A collapse moves value; it does not create or destroy it.
    assert!(close(state(&c, now).total_supply.0, supply, 1));

    at("anyone.test", now, 0);
    assert_eq!(c.poke(), 2);
    let s = c.get_state();
    assert_eq!(s.stats.rounds_collapsed, 1);
    assert_eq!(s.stats.current_streak, 0);
    // `total_paid` and `collected` count what It took from the others, not It's own cut coming back.
    let net = pot - ((CLAIM - cost) - (CLAIM - cost) * 85 / 100);
    assert_eq!(s.stats.total_paid.0, net);
    assert_eq!(s.collapse_run, 1);
    assert!(s.armed);
    assert_eq!(c.get_account(id("alice.test")).collected.0, net);
    let h = c.get_history(0, 10);
    assert_eq!(h.len(), 2);
    assert_eq!(
        h[1],
        Entry::Collapsed {
            first_round: 2,
            last_round: 2,
            count: 1,
            it: id("alice.test"),
            paid: U128(net)
        }
    );
}

#[test]
fn at_most_eight_unsaved_rounds_in_a_row_are_charged() {
    let (mut c, _) = alice_is_it();
    let now = t(500, SEC);
    let s = state(&c, now);
    assert_eq!(s.round, 500);
    assert_eq!(s.stats.rounds_collapsed, 8);
    assert_eq!(s.collapse_run, 8);
    assert!(!s.armed, "dormant until somebody volunteers again");

    // bob lost 15 % eight times: 1000 × 0.85^8.
    let mut expected = CLAIM;
    for _ in 0..8 {
        expected = expected * 85 / 100;
    }
    assert!(close(bal(&c, "bob.test", now), expected, 8));

    at("anyone.test", now, 0);
    assert_eq!(
        c.poke(),
        9,
        "one saved round and eight collapsed ones; the rest is skipped"
    );
    assert_eq!(
        c.get_history(0, 10)[1],
        Entry::Collapsed {
            first_round: 2,
            last_round: 9,
            count: 8,
            it: id("alice.test"),
            paid: c.get_state().stats.total_paid,
        }
    );
    // Far in the future nothing more has happened.
    assert_eq!(state(&c, t(1_000_000, SEC)).stats.rounds_collapsed, 8);
    assert!(close(bal(&c, "bob.test", t(1_000_000, SEC)), expected, 8));
}

#[test]
fn a_new_volunteer_takes_over_and_rearms_the_game() {
    let (mut c, _) = alice_is_it();
    // Game is dormant by round 500; bob steps up near the deadline.
    volunteer(&mut c, "bob.test", t(500, ROUND - SEC));
    let s = state(&c, t(500, ROUND - SEC));
    assert_eq!(s.it, Some(id("bob.test")));
    assert_eq!(s.collapse_run, 0);
    assert!(s.armed);

    // The next unsaved round now pays bob, not alice.
    let alice_before = bal(&c, "alice.test", t(501, SEC));
    let bob_before = bal(&c, "bob.test", t(501, SEC));
    let alice_after = bal(&c, "alice.test", t(502, SEC));
    let bob_after = bal(&c, "bob.test", t(502, SEC));
    assert!(close(alice_after, alice_before * 85 / 100, 1));
    assert!(bob_after > bob_before);

    at("anyone.test", t(502, SEC), 0);
    c.poke();
    let h = c.get_history(0, 10);
    assert!(matches!(&h[2], Entry::Saved { round: 500, hero, .. } if hero == &id("bob.test")));
    assert!(
        matches!(&h[3], Entry::Collapsed { first_round: 501, it, .. } if it == &id("bob.test"))
    );
}

#[test]
fn collapsed_runs_merge_across_calls_only_for_the_same_it() {
    let (mut c, _) = alice_is_it();
    at("anyone.test", t(4, SEC), 0);
    c.poke(); // rounds 2 and 3 collapsed
    at("anyone.test", t(6, SEC), 0);
    c.poke(); // rounds 4 and 5 collapsed
    let h = c.get_history(0, 10);
    assert_eq!(h.len(), 2);
    assert!(matches!(
        h[1],
        Entry::Collapsed {
            first_round: 2,
            last_round: 5,
            count: 4,
            ..
        }
    ));
}

#[test]
fn views_equal_state_after_poke() {
    let (mut c, _) = alice_is_it();
    let now = t(7, 33 * SEC);

    at("viewer.test", now, 0);
    let before = c.get_state();
    let hist_before = c.get_history(0, 100);
    let len_before = c.get_history_len();
    let alice_before = c.get_account(id("alice.test"));
    let bob_before = c.ft_balance_of(id("bob.test")).0;
    let supply_before = c.ft_total_supply().0;
    let heroes_before = c.get_heroes(0, 10)[0].collected.0;

    at("anyone.test", now, 0);
    c.poke();
    let after = c.get_state();
    assert_eq!(before.round, after.round);
    assert_eq!(before.index, after.index);
    assert_eq!(before.round_supply.0, after.round_supply.0);
    assert_eq!(before.cost_now.0, after.cost_now.0);
    assert_eq!(before.collapse_run, after.collapse_run);
    assert_eq!(before.armed, after.armed);
    assert_eq!(before.stats, after.stats);
    assert_eq!(hist_before, c.get_history(0, 100));
    assert_eq!(len_before, c.get_history_len());
    let alice_after = c.get_account(id("alice.test"));
    assert_eq!(alice_before.balance.0, alice_after.balance.0);
    assert_eq!(alice_before.collected.0, alice_after.collected.0);
    assert_eq!(bob_before, c.ft_balance_of(id("bob.test")).0);
    assert_eq!(supply_before, c.ft_total_supply().0);
    assert_eq!(heroes_before, c.get_heroes(0, 10)[0].collected.0);
}

#[test]
fn if_it_unregisters_nobody_is_it_and_nothing_is_charged() {
    let (mut c, _) = alice_is_it();
    at("alice.test", t(1, 2 * SEC), 1);
    assert!(c.storage_unregister(Some(true)));
    let s = state(&c, t(20, SEC));
    assert!(s.it.is_none());
    assert!(!s.armed);
    assert_eq!(s.stats.rounds_collapsed, 0);
    assert_eq!(bal(&c, "bob.test", t(20, SEC)), CLAIM);
    let acct = c.get_account(id("alice.test"));
    assert!(!acct.registered);
    assert!(acct.claimed, "an unregistered account cannot claim again");
}

// ---------------------------------------------------------------- rescale

/// Drive the index below 10^18 so that a rescale happens: each cycle bob or carol
/// volunteers at the floor price, then eight rounds collapse.
fn after_many_collapses(cycles: u64) -> (Contract, u64) {
    let mut c = three_holders();
    let mut round = 1;
    for k in 0..cycles {
        let who = if k % 2 == 0 { "bob.test" } else { "carol.test" };
        volunteer(&mut c, who, t(round, ROUND - SEC));
        round += 10; // the saved round, eight collapsed rounds, one dormant round
    }
    (c, round)
}

#[test]
fn the_index_is_rescaled_and_balances_survive() {
    // 17 cycles × 8 collapses = 136 collapses; 0.85^128 × 10^27 < 10^18.
    let (mut c, round) = after_many_collapses(17);
    let now = t(round, SEC);
    let s = state(&c, now);
    assert_eq!(s.stats.rounds_collapsed, 136);
    assert_eq!(s.scale, 1, "exactly one rescale so far");

    // Nothing was lost beyond rounding dust: the three balances add up to the supply.
    let total: u128 = ["alice.test", "bob.test", "carol.test"]
        .iter()
        .map(|w| bal(&c, w, now))
        .sum();
    let supply = s.total_supply.0;
    assert!(total <= supply);
    assert!(
        supply - total < NOTIT / 1_000_000,
        "dust only: {}",
        supply - total
    );

    // alice was never It and never wrote her account after the claim: her stored
    // shares are from generation 0 and still read correctly.
    let alice = bal(&c, "alice.test", now);
    assert!(
        alice > 0 && alice < NOTIT / 1_000_000,
        "0.85^136 of 1,000 NOTIT is dust: {alice}"
    );

    // Accounts keep working after the rescale: transfers and volunteering.
    let bob = bal(&c, "bob.test", now);
    let carol = bal(&c, "carol.test", now);
    at("bob.test", now, 1);
    c.ft_transfer(id("alice.test"), U128(bob / 2), None);
    assert!(close(bal(&c, "alice.test", now), alice + bob / 2, 2));
    assert!(close(bal(&c, "bob.test", now), bob - bob / 2, 2));
    assert_eq!(bal(&c, "carol.test", now), carol);
    volunteer(&mut c, "alice.test", t(round, ROUND - SEC));
    assert_eq!(state(&c, t(round, ROUND - SEC)).it, Some(id("alice.test")));
}

#[test]
fn views_match_poke_across_a_rescale() {
    let (mut c, round) = after_many_collapses(15); // 120 collapses: just above the threshold
    volunteer(&mut c, "bob.test", t(round, ROUND - SEC));
    let now = t(round + 20, SEC); // eight more collapses cross the threshold virtually
    at("viewer.test", now, 0);
    let before = c.get_state();
    assert_eq!(before.scale, 1);
    let balances: Vec<u128> = ["alice.test", "bob.test", "carol.test"]
        .iter()
        .map(|w| c.ft_balance_of(id(w)).0)
        .collect();
    at("anyone.test", now, 0);
    c.poke();
    let after = c.get_state();
    assert_eq!(
        (before.index, before.scale, before.total_supply.0),
        (after.index, after.scale, after.total_supply.0)
    );
    let balances_after: Vec<u128> = ["alice.test", "bob.test", "carol.test"]
        .iter()
        .map(|w| c.ft_balance_of(id(w)).0)
        .collect();
    assert_eq!(balances, balances_after);
}

// ---------------------------------------------------------------- settlement cost

#[test]
fn settlement_skips_any_number_of_dormant_rounds_in_one_call() {
    let (mut c, _) = alice_is_it();
    at("anyone.test", t(10_000_000, SEC), 0);
    assert_eq!(c.poke(), 9);
    assert_eq!(c.get_state().round, 10_000_000);
    assert_eq!(c.poke(), 0);
}

// ---------------------------------------------------------------- transfers

#[test]
fn transfer_moves_shares_and_conserves_supply() {
    let (mut c, _) = alice_is_it();
    let now = t(4, 2 * SEC); // two collapses: the index is no longer 10^27
    at("anyone.test", now, 0);
    c.poke();
    let supply = c.ft_total_supply().0;
    let a0 = bal(&c, "bob.test", now);
    let b0 = bal(&c, "carol.test", now);
    at("bob.test", now, 1);
    c.ft_transfer(id("carol.test"), U128(123 * NOTIT + 7), None);
    let a1 = bal(&c, "bob.test", now);
    let b1 = bal(&c, "carol.test", now);
    // Rounding is at most one unit per side and never creates value.
    assert!(b1 - b0 >= 123 * NOTIT + 7 && b1 - b0 <= 123 * NOTIT + 8);
    assert!(a0 - a1 >= 123 * NOTIT + 7 && a0 - a1 <= 123 * NOTIT + 8);
    at("viewer.test", now, 0);
    assert_eq!(c.ft_total_supply().0, supply);
}

#[test]
#[should_panic(expected = "ERR_UNREGISTERED")]
fn transfer_to_unregistered_is_rejected() {
    let mut c = three_holders();
    at("alice.test", t(0, 5 * SEC), 1);
    c.ft_transfer(id("nobody.test"), U128(NOTIT), None);
}

#[test]
#[should_panic(expected = "ERR_SELF_TRANSFER")]
fn transfer_to_self_is_rejected() {
    let mut c = three_holders();
    at("alice.test", t(0, 5 * SEC), 1);
    c.ft_transfer(id("alice.test"), U128(NOTIT), None);
}

#[test]
#[should_panic(expected = "ERR_ZERO_AMOUNT")]
fn transfer_of_zero_is_rejected() {
    let mut c = three_holders();
    at("alice.test", t(0, 5 * SEC), 1);
    c.ft_transfer(id("bob.test"), U128(0), None);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT")]
fn transfer_above_balance_is_rejected() {
    let mut c = three_holders();
    at("alice.test", t(0, 5 * SEC), 1);
    c.ft_transfer(id("bob.test"), U128(CLAIM + 1), None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn transfer_requires_one_yocto() {
    let mut c = three_holders();
    at("alice.test", t(0, 5 * SEC), 0);
    c.ft_transfer(id("bob.test"), U128(NOTIT), None);
}

// ---------------------------------------------------------------- storage, metadata, parameters

#[test]
fn unregister_with_force_burns_the_balance() {
    let mut c = three_holders();
    let now = t(0, 9 * SEC);
    at("alice.test", now, 1);
    assert!(c.storage_unregister(Some(true)));
    at("viewer.test", now, 0);
    assert_eq!(c.ft_total_supply().0, 2 * CLAIM);
    assert!(c.storage_balance_of(id("alice.test")).is_none());
    at("alice.test", now, 1);
    assert!(!c.storage_unregister(None), "already unregistered");
}

#[test]
#[should_panic(expected = "ERR_STORAGE")]
fn unregister_with_balance_needs_force() {
    let mut c = three_holders();
    at("alice.test", t(0, 9 * SEC), 1);
    c.storage_unregister(None);
}

#[test]
fn storage_deposit_registers_and_bounds_are_fixed() {
    let mut c = deploy();
    at("payer.test", t(0, SEC), FEE * 2);
    let b = c.storage_deposit(Some(id("dave.test")), None);
    assert_eq!(b.total.as_yoctonear(), FEE);
    assert!(c.storage_balance_of(id("dave.test")).is_some());
    let bounds = c.storage_balance_bounds();
    assert_eq!(bounds.min, bounds.max.unwrap());
}

#[test]
#[should_panic(expected = "ERR_PARAMS")]
fn bad_parameters_are_rejected() {
    at("deployer.test", T0, 0);
    Contract::new(Params {
        min_cost_ppm: 60_000,
        ..params()
    });
}

#[test]
fn config_and_metadata_are_reported() {
    let c = deploy();
    let m = c.ft_metadata();
    assert_eq!(
        (m.spec.as_str(), m.symbol.as_str(), m.decimals),
        ("ft-1.0.0", "NOTIT", 18)
    );
    let cfg = c.get_config();
    assert_eq!(
        (cfg.max_cost_ppm, cfg.min_cost_ppm, cfg.cut_ppm),
        (50_000, 2_000, 150_000)
    );
    assert_eq!(cfg.max_collapse_run, 8);
    assert_eq!(cfg.genesis_ns.0, T0);
}

#[test]
fn an_it_that_leaves_is_paid_for_rounds_that_already_ended() {
    let (mut c, _) = alice_is_it();
    let now = t(4, SEC); // rounds 2 and 3 ended unsaved; nobody has called since
    let alice_view = bal(&c, "alice.test", now);
    let bob_view = bal(&c, "bob.test", now);

    // Unregistering settles first: the pending collapses are charged and paid, so what
    // the views showed a moment ago is what happened. alice now holds tokens and needs force.
    at("alice.test", now, 1);
    assert!(c.storage_unregister(Some(true)));
    assert_eq!(bal(&c, "bob.test", now), bob_view);
    let s = state(&c, now);
    assert_eq!(s.stats.rounds_collapsed, 2);
    assert!(s.it.is_none() && !s.armed);
    assert!(
        alice_view > CLAIM,
        "It had collected before leaving: {alice_view}"
    );
    // Her tokens were burned with the account; nobody is charged afterwards.
    assert_eq!(bal(&c, "bob.test", t(30, SEC)), bob_view);
}

#[test]
#[should_panic(expected = "ERR_STORAGE")]
fn the_contract_account_cannot_be_registered() {
    let mut c = deploy();
    at("payer.test", t(0, SEC), FEE);
    c.storage_deposit(Some(id("notit.test")), None);
}

// ---------------------------------------------------------------- transfer-and-call refunds

/// Debit `amount` from alice to bob as `ft_transfer_call` does, then run the callback
/// with the receiver's reply. Returns the amount the callback reports as used.
fn resolve(c: &mut Contract, amount: u128, now: u64, reply: PromiseResult) -> u128 {
    at("alice.test", now, 1);
    c.settle();
    let moved = c.internal_transfer(&id("alice.test"), &id("bob.test"), amount, None);
    let scale = c.scale;
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(id("notit.test"))
        .current_account_id(id("notit.test"))
        .block_timestamp(now);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![reply]
    );
    c.ft_resolve_transfer(
        id("alice.test"),
        id("bob.test"),
        U128(amount),
        moved.to_string(),
        scale,
    )
    .0
}

#[test]
fn transfer_call_refunds_everything_when_the_receiver_fails() {
    let mut c = three_holders();
    let now = t(0, 5 * SEC);
    assert_eq!(resolve(&mut c, 300 * NOTIT, now, PromiseResult::Failed), 0);
    assert_eq!(bal(&c, "alice.test", now), CLAIM);
    assert_eq!(bal(&c, "bob.test", now), CLAIM);
}

#[test]
fn transfer_call_keeps_what_the_receiver_used() {
    let mut c = three_holders();
    let now = t(0, 5 * SEC);
    let reply = PromiseResult::Successful(format!("\"{}\"", 100 * NOTIT).into_bytes());
    assert_eq!(resolve(&mut c, 300 * NOTIT, now, reply), 200 * NOTIT);
    assert_eq!(bal(&c, "alice.test", now), CLAIM - 200 * NOTIT);
    assert_eq!(bal(&c, "bob.test", now), CLAIM + 200 * NOTIT);
}

#[test]
fn transfer_call_treats_a_garbage_reply_as_unused_and_caps_an_oversized_one() {
    let mut c = three_holders();
    let now = t(0, 5 * SEC);
    assert_eq!(
        resolve(
            &mut c,
            300 * NOTIT,
            now,
            PromiseResult::Successful(b"garbage".to_vec())
        ),
        0
    );
    let oversized = PromiseResult::Successful(format!("\"{}\"", u128::MAX).into_bytes());
    assert_eq!(resolve(&mut c, 300 * NOTIT, now, oversized), 0);
    assert_eq!(bal(&c, "alice.test", now), CLAIM);
    assert_eq!(c.ft_total_supply().0, 3 * CLAIM);
}

#[test]
fn a_collapse_between_debit_and_refund_cannot_take_extra_from_the_receiver() {
    let (mut c, _) = alice_is_it();
    let now = t(1, 50 * SEC);
    // carol sends 400 to bob with transfer-and-call; before the callback runs, a round
    // collapses. The refund is the same shares that were debited, now worth 15 % less.
    at("carol.test", now, 1);
    c.settle();
    let moved = c.internal_transfer(&id("carol.test"), &id("bob.test"), 400 * NOTIT, None);
    let scale = c.scale;
    let later = t(3, SEC);
    let bob_own = CLAIM * 85 / 100;
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(id("notit.test"))
        .current_account_id(id("notit.test"))
        .block_timestamp(later);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    c.ft_resolve_transfer(
        id("carol.test"),
        id("bob.test"),
        U128(400 * NOTIT),
        moved.to_string(),
        scale,
    );
    // bob is left with exactly his own (cut) balance; carol has her 1,000 back, cut once.
    assert!(close(bal(&c, "bob.test", later), bob_own, 2));
    assert!(close(bal(&c, "carol.test", later), CLAIM * 85 / 100, 2));
}

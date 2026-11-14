//! Randomised invariant test, written by the independent reviewer during the pre-lock audit.
//!
//! Random legal operations (claim, volunteer, transfer, transfer-and-call with mocked
//! receiver replies, forced unregister, register, poke) at random times, over several
//! parameter sets including extreme ones. After every step it checks that:
//! - nothing panics, in calls or in views;
//! - the sum of effective shares never exceeds `total_shares`;
//! - balances never add up to more than the supply, and the supply only grows by claims;
//! - no account gains more than it claimed or was sent;
//! - the index never falls below the rescale threshold.
use crate::math::shares_ceil;
use crate::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{PromiseResult, testing_env};

const FEE: u128 = 5_000_000_000_000_000_000_000;
const SEC: u64 = 1_000_000_000;
const ROUND: u64 = 100 * SEC;
const T0: u64 = 1_000_000 * SEC;
const NAMES: [&str; 6] = [
    "a0.test", "a1.test", "a2.test", "a3.test", "a4.test", "a5.test",
];

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn big(&mut self, n: u128) -> u128 {
        if n == 0 {
            return 0;
        }
        (((self.next() as u128) << 64) | self.next() as u128) % n
    }
}

fn ctx(who: &str, now: u64, deposit: u128) -> near_sdk::VMContext {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(who.parse().unwrap())
        .current_account_id("notit.test".parse().unwrap())
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit));
    b.build()
}
fn at(who: &str, now: u64, deposit: u128) {
    testing_env!(ctx(who, now, deposit));
}
fn at_resolve(now: u64, result: PromiseResult) {
    testing_env!(
        ctx("notit.test", now, 0),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}
fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

struct Pending {
    sender: usize,
    receiver: usize,
    amount: u128,
    shares: U256,
    scale: u32,
}

fn bals(c: &Contract, now: u64) -> (Vec<u128>, u128) {
    at("viewer.test", now, 0);
    let b: Vec<u128> = NAMES.iter().map(|n| c.ft_balance_of(id(n)).0).collect();
    (b, c.ft_total_supply().0)
}

fn check(c: &Contract, now: u64, tag: &str, deep: bool) {
    // stored invariant: sum of effective shares never exceeds total_shares
    let mut sum = U256::zero();
    for n in NAMES {
        sum += c.shares_of(&id(n));
    }
    let total: U256 = c.total_shares.into();
    assert!(sum <= total, "{tag}: sum eff {sum} > total_shares {total}");
    // views do not panic and balances never exceed supply
    let (b, supply) = bals(c, now);
    let s: u128 = b.iter().sum();
    assert!(s <= supply, "{tag}: balances {s} > supply {supply}");
    let st = c.get_state();
    assert!(
        U256::from_dec_str(&st.index).unwrap() >= U256::from(10u128.pow(18)),
        "{tag}: index low"
    );
    let len = c.get_history_len();
    if !deep {
        return;
    }
    let mut got = 0;
    let mut from = 0;
    loop {
        let page = c.get_history(from, 100);
        if page.is_empty() {
            break;
        }
        got += page.len() as u32;
        from += 100;
    }
    assert_eq!(got, len, "{tag}: history len");
    let _ = c.get_heroes(0, 100);
    for n in NAMES {
        let _ = c.get_account(id(n));
    }
}

fn run(
    seed: u64,
    cut: u32,
    claim: u128,
    cap: u32,
    min_cost: u32,
    max_cost: u32,
    steps: u32,
) -> (u32, u32, u32) {
    let mut r = Rng(seed | 1);
    at("deployer.test", T0, 0);
    let mut c = Contract::new(Params {
        round_ns: U64(ROUND),
        max_cost_ppm: max_cost,
        min_cost_ppm: min_cost,
        cut_ppm: cut,
        claim_amount: U128(claim),
        claim_cap: cap,
    });
    let mut now = T0;
    let mut pending: Vec<Pending> = vec![];
    let (mut resolves, mut vols, mut unregs) = (0u32, 0u32, 0u32);
    for step in 0..steps {
        now += match r.below(10) {
            0..=4 => r.below(ROUND / 3),
            5..=7 => r.below(2 * ROUND),
            8 => r.below(12 * ROUND),
            _ => r.below(40 * ROUND),
        };
        let (before, supply_before) = bals(&c, now);
        let it_before = c.it.clone();
        let who = r.below(6) as usize;
        let name = NAMES[who];
        let acct = id(name);
        let tag = format!("seed {seed} cut {cut} step {step}");
        let mut gain: Vec<u128> = vec![0; 6];
        let mut minted = 0u128;
        let mut skip_gain_check = false;
        match r.below(12) {
            0 | 1 => {
                if !c.claimed.contains(&acct) && c.claims_made < cap {
                    at(name, now, FEE);
                    c.claim();
                    gain[who] = claim;
                    minted = claim;
                }
            }
            2..=4 => {
                at("viewer.test", now, 0);
                let st = c.get_state();
                if !st.saved
                    && st.round_supply.0 > 0
                    && c.accounts.contains_key(&acct)
                    && before[who] >= st.cost_now.0
                {
                    at(name, now, 0);
                    let cost = c.volunteer(Some(st.round), Some(st.cost_now)).0;
                    assert_eq!(cost, st.cost_now.0, "{tag}: cost view");
                    vols += 1;
                }
            }
            5 | 6 => {
                let to = r.below(6) as usize;
                if to != who
                    && c.accounts.contains_key(&acct)
                    && c.accounts.contains_key(&id(NAMES[to]))
                    && before[who] > 0
                {
                    let amount = if r.below(4) == 0 {
                        before[who]
                    } else {
                        1 + r.big(before[who])
                    };
                    if r.below(2) == 0 {
                        at(name, now, 1);
                        c.ft_transfer(id(NAMES[to]), U128(amount), None);
                    } else {
                        at(name, now, 1);
                        let _ =
                            c.ft_transfer_call(id(NAMES[to]), U128(amount), None, String::new());
                        pending.push(Pending {
                            sender: who,
                            receiver: to,
                            amount,
                            shares: shares_ceil(amount, c.index.into()),
                            scale: c.scale,
                        });
                    }
                    gain[to] = amount + 1;
                }
            }
            7 => {
                let is_it = c.it.as_ref() == Some(&acct);
                if c.accounts.contains_key(&acct) && (!is_it || r.below(4) == 0) && r.below(2) == 0
                {
                    if is_it {
                        skip_gain_check = true;
                    }
                    at(name, now, 1);
                    assert!(c.storage_unregister(Some(true)));
                    unregs += 1;
                }
            }
            8 => {
                at(name, now, FEE);
                c.storage_deposit(None, None);
            }
            9 | 10 => {
                if !pending.is_empty() {
                    let p = pending.swap_remove(r.below(pending.len() as u64) as usize);
                    let (res, unused) = match r.below(5) {
                        0 => (PromiseResult::Failed, p.amount),
                        1 => (PromiseResult::Successful(b"garbage".to_vec()), p.amount),
                        2 => (PromiseResult::Successful(b"\"0\"".to_vec()), 0),
                        3 => (
                            PromiseResult::Successful(format!("\"{}\"", u128::MAX).into_bytes()),
                            p.amount,
                        ),
                        _ => {
                            let u = r.big(p.amount + 1);
                            (
                                PromiseResult::Successful(format!("\"{u}\"").into_bytes()),
                                u,
                            )
                        }
                    };
                    at_resolve(now, res);
                    let used = c
                        .ft_resolve_transfer(
                            id(NAMES[p.sender]),
                            id(NAMES[p.receiver]),
                            U128(p.amount),
                            p.shares.to_string(),
                            p.scale,
                        )
                        .0;
                    assert!(used <= p.amount, "{tag}: used");
                    assert!(
                        p.amount - used <= unused,
                        "{tag}: returned more than unused"
                    );
                    gain[p.sender] = unused + 1;
                    resolves += 1;
                }
            }
            _ => {
                at("poker.test", now, 0);
                c.poke();
            }
        }
        check(&c, now, &tag, step % 20 == 0);
        let (after, supply_after) = bals(&c, now);
        if !skip_gain_check {
            assert!(
                supply_after <= supply_before + minted,
                "{tag}: supply grew {supply_before} -> {supply_after}"
            );
            for i in 0..6 {
                // +1: independent floors
                assert!(
                    after[i] <= before[i] + gain[i] + 1,
                    "{tag}: {} gained {} -> {} (allowed {}) it_before {:?}",
                    NAMES[i],
                    before[i],
                    after[i],
                    gain[i],
                    it_before
                );
            }
        }
        // views equal the state that a poke writes
        if r.below(3) == 0 {
            at("poker.test", now, 0);
            c.poke();
            let (poked, supply_poked) = bals(&c, now);
            assert_eq!(after, poked, "{tag}: views differ from poke");
            assert_eq!(
                supply_after, supply_poked,
                "{tag}: supply view differs from poke"
            );
            check(&c, now, &tag, false);
        }
    }
    println!(
        "RUN seed {seed} cut {cut}: resolves {resolves} vols {vols} unregs {unregs} scale {} collapsed {} saved {}",
        c.scale, c.stats.rounds_collapsed, c.stats.rounds_saved
    );
    (resolves, vols, unregs)
}

#[test]
fn random_operations_keep_the_invariants() {
    let n18 = 10u128.pow(18);
    let configs: [(u32, u128, u32, u32, u32); 7] = [
        (150_000, 1000 * n18, 100_000, 2_000, 50_000),
        (500_000, 1000 * n18, 100_000, 2_000, 50_000),
        (900_000, 1000 * n18, 4, 2_000, 50_000),
        (999_999, 1000 * n18, 100_000, 1, 999_999),
        (999_999, 10u128.pow(31), 10, 2_000, 50_000),
        (150_000, 10u128.pow(31), 10, 1, 1),
        (1, 7, 100_000, 1, 999_999),
    ];
    // Defaults keep `cargo test` quick. The pre-lock audit ran
    // NOTIT_FUZZ_SEEDS=40 NOTIT_FUZZ_STEPS=700 (and longer) over the same parameter sets.
    let seeds: u64 = std::env::var("NOTIT_FUZZ_SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2);
    let steps: u32 = std::env::var("NOTIT_FUZZ_STEPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(250);
    let mut jobs = vec![];
    for (ci, cfg) in configs.into_iter().enumerate() {
        for seed in 1..=seeds {
            jobs.push((ci, cfg, seed));
        }
    }
    let jobs = std::sync::Arc::new(std::sync::Mutex::new(jobs));
    let mut handles = vec![];
    for _ in 0..5 {
        let jobs = jobs.clone();
        handles.push(std::thread::spawn(move || {
            let mut out = vec![];
            loop {
                let job = jobs.lock().unwrap().pop();
                let Some((ci, cfg, seed)) = job else { break };
                let s = seed * 7919 + ci as u64 * 104729;
                // fresh mocked chain (and storage) per run
                let res =
                    std::thread::spawn(move || run(s, cfg.0, cfg.1, cfg.2, cfg.3, cfg.4, steps))
                        .join();
                out.push((ci, res.ok()));
            }
            out
        }));
    }
    let mut tot = [(0u32, 0u32, 0u32); 7];
    let mut failed = 0;
    let mut done = 0;
    for h in handles {
        for (ci, res) in h.join().unwrap() {
            done += 1;
            match res {
                Some((a, b, d)) => {
                    tot[ci].0 += a;
                    tot[ci].1 += b;
                    tot[ci].2 += d;
                }
                None => failed += 1,
            }
        }
    }
    println!("runs completed: {done}, steps each: {steps}");
    println!("per-config (resolves, volunteers, unregisters): {tot:?}");
    assert_eq!(failed, 0, "{failed} runs failed");
}

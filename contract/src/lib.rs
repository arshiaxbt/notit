//! Not It ($NOTIT) — a volunteer's-dilemma memecoin on NEAR.
//!
//! Somebody has to do it. Every round the first holder to volunteer burns a
//! falling cost from their own balance and becomes "It". If a round ends with
//! no volunteer, every balance is cut and the whole cut is paid to It — the
//! last person who did it.
//!
//! The rules are fixed at deployment: this contract stores no owner and has no
//! method that changes a parameter.
//!
//! The normative specification is docs/SPEC.md. Section numbers in comments
//! refer to it.

mod events;
mod ft;
mod math;
mod storage;
mod views;

#[cfg(test)]
mod differential;
#[cfg(test)]
mod tests;

use math::{
    Account, PPM, RESCALE_BELOW, RESCALE_FACTOR, Wide, amount_of, mul_div_floor, ray, shares_ceil,
    shares_floor,
};
use near_sdk::json_types::{U64, U128};
use near_sdk::store::{IterableMap, LookupMap, LookupSet, Vector};
use near_sdk::{AccountId, NearToken, PanicOnDefault, Promise, env, near, require};
use primitive_types::U256;

pub use views::{AccountView, ConfigView, HeroView, StateView};

/// Unsaved rounds charged in a row before the game goes dormant (§2).
pub const MAX_COLLAPSE_RUN: u32 = 8;
/// Token decimals (§2).
pub const DECIMALS: u8 = 18;
/// Fixed storage fee for registering one account (NEP-145): 0.005 NEAR, about 500 bytes.
/// It pays for the account record and for the records that outlive it (the claim
/// marker and the volunteer totals).
pub const STORAGE_FEE: NearToken = NearToken::from_yoctonear(5_000_000_000_000_000_000_000);
/// Returned by `storage_unregister`: the part of the fee that paid for the account record.
/// The rest stays with the contract to keep paying for the permanent records.
pub const STORAGE_REFUND: NearToken = NearToken::from_yoctonear(2_500_000_000_000_000_000_000);

/// Init parameters as JSON (§2).
#[near(serializers = [json])]
pub struct Params {
    pub round_ns: U64,
    pub max_cost_ppm: u32,
    pub min_cost_ppm: u32,
    pub cut_ppm: u32,
    pub claim_amount: U128,
    pub claim_cap: u32,
}

/// Immutable parameters in storage (§2).
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Config {
    pub round_ns: u64,
    pub max_cost_ppm: u32,
    pub min_cost_ppm: u32,
    pub cut_ppm: u32,
    pub claim_amount: u128,
    pub claim_cap: u32,
}

/// Running statistics (§6).
#[near(serializers = [borsh, json])]
#[derive(Clone, Default, Debug, PartialEq)]
pub struct Stats {
    pub rounds_saved: u64,
    pub rounds_collapsed: u64,
    pub current_streak: u64,
    pub longest_streak: u64,
    pub closest_call_ms: Option<u64>,
    pub total_burned: U128,
    pub total_paid: U128,
}

/// One history entry (§7).
#[near(serializers = [borsh, json])]
#[serde(tag = "kind", rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    Saved {
        round: u64,
        hero: AccountId,
        cost: U128,
        ms_left: u64,
    },
    Collapsed {
        first_round: u64,
        last_round: u64,
        count: u64,
        it: AccountId,
        paid: U128,
    },
}

/// Per-volunteer totals (§3).
#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct HeroStat {
    pub saves: u32,
    pub burned: u128,
    pub collected: u128,
}

/// The part of the state that settlement reads and writes (§4).
/// Views run the same code on a copy, which is how they stay correct when
/// nobody has called the contract for many rounds (§6).
#[derive(Clone)]
pub(crate) struct Core {
    pub index: U256,
    pub total_shares: U256,
    pub scale: u32,
    pub round: u64,
    pub round_supply: u128,
    pub saved: bool,
    /// It is set and still registered.
    pub it_present: bool,
    /// It's effective shares at `scale`.
    pub it_shares: U256,
    /// The rescale generation `it_shares` is recorded at (§3). It only catches up
    /// when It's account is written, exactly like every other account.
    pub it_scale: u32,
    pub collapse_run: u32,
    pub stats: Stats,
}

/// What one settlement pass did.
#[derive(Default)]
pub(crate) struct Closed {
    /// Rounds closed by the loop body (skipped dormant rounds are not counted).
    pub n: u32,
    pub saved: u64,
    pub collapsed: u64,
    /// Total collected by It from the other holders in the collapsed rounds.
    pub paid: u128,
    /// Collapsed rounds closed in one pass are contiguous: `(first, last)`.
    pub run: Option<(u64, u64)>,
}

impl Core {
    pub fn supply(&self) -> u128 {
        amount_of(self.total_shares, self.index)
    }

    /// §3: would an unsaved close of the current round be charged?
    pub fn armed(&self) -> bool {
        self.it_present && self.collapse_run < MAX_COLLAPSE_RUN && self.round_supply > 0
    }

    /// §4: close rounds until `target` is the current round.
    pub fn advance(&mut self, cfg: &Config, target: u64) -> Closed {
        let mut closed = Closed::default();
        while self.round < target {
            if self.saved {
                // §4.1 saved
                self.stats.rounds_saved += 1;
                self.stats.current_streak += 1;
                if self.stats.current_streak > self.stats.longest_streak {
                    self.stats.longest_streak = self.stats.current_streak;
                }
                closed.saved += 1;
            } else if self.armed() {
                // §4.1 collapsed: cut everyone, pay the whole cut to It.
                let before = self.supply();
                // Step 3: normalise It, as for any write to an account.
                while self.it_scale < self.scale {
                    self.it_shares /= U256::from(RESCALE_FACTOR);
                    self.it_scale += 1;
                }
                let it_before = amount_of(self.it_shares, self.index);
                self.index = mul_div_floor(
                    self.index,
                    U256::from(PPM - cfg.cut_ppm as u128),
                    U256::from(PPM),
                );
                let pot = before - self.supply();
                // It is cut like everyone else and gets that back inside the pot, so
                // what It collects from the others is the pot minus It's own cut.
                // The floors are independent, so with only dust left outside It's account the
                // difference can come out one unit below zero: clamp it. (A panic here would
                // block every later call, because every call settles first.)
                let paid = pot.saturating_sub(it_before - amount_of(self.it_shares, self.index));
                let minted = shares_floor(pot, self.index);
                self.it_shares += minted;
                self.total_shares += minted;
                if self.index < U256::from(RESCALE_BELOW) {
                    let factor = U256::from(RESCALE_FACTOR);
                    self.index *= factor;
                    self.total_shares /= factor;
                    self.scale += 1;
                }
                self.stats.rounds_collapsed += 1;
                self.stats.current_streak = 0;
                self.stats.total_paid = U128(self.stats.total_paid.0 + paid);
                self.collapse_run += 1;
                closed.paid += paid;
                closed.run = Some(match closed.run {
                    Some((first, _)) => (first, self.round),
                    None => (self.round, self.round),
                });
                closed.collapsed += 1;
            }
            // §4.1 dormant: nothing to do.
            self.round += 1;
            self.saved = false;
            self.round_supply = self.supply();
            closed.n += 1;
            if !self.armed() {
                // Every further unattended round is dormant.
                self.round = target;
                break;
            }
        }
        closed
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) config: Config,
    pub(crate) genesis_ns: u64,
    pub(crate) accounts: LookupMap<AccountId, Account>,
    pub(crate) claimed: LookupSet<AccountId>,
    pub(crate) total_shares: Wide,
    pub(crate) index: Wide,
    pub(crate) scale: u32,
    pub(crate) round: u64,
    pub(crate) round_supply: u128,
    pub(crate) round_hero: Option<AccountId>,
    pub(crate) it: Option<AccountId>,
    pub(crate) collapse_run: u32,
    pub(crate) claims_made: u32,
    pub(crate) stats: Stats,
    pub(crate) history: Vector<Entry>,
    pub(crate) heroes: IterableMap<AccountId, HeroStat>,
}

#[near]
impl Contract {
    /// Deploy-time initialisation. There is no owner and no setter: after this
    /// call nothing in `Config` can change.
    #[init]
    pub fn new(params: Params) -> Self {
        let cfg = Config {
            round_ns: params.round_ns.0,
            max_cost_ppm: params.max_cost_ppm,
            min_cost_ppm: params.min_cost_ppm,
            cut_ppm: params.cut_ppm,
            claim_amount: params.claim_amount.0,
            claim_cap: params.claim_cap,
        };
        require!(
            cfg.round_ns >= 1_000_000_000,
            "ERR_PARAMS: round_ns must be at least one second"
        );
        require!(
            cfg.min_cost_ppm > 0
                && cfg.min_cost_ppm <= cfg.max_cost_ppm
                && (cfg.max_cost_ppm as u128) < PPM,
            "ERR_PARAMS: need 0 < min_cost_ppm <= max_cost_ppm < 1_000_000"
        );
        require!(
            cfg.cut_ppm > 0 && (cfg.cut_ppm as u128) < PPM,
            "ERR_PARAMS: need 0 < cut_ppm < 1_000_000"
        );
        require!(
            cfg.claim_amount > 0,
            "ERR_PARAMS: claim_amount must be positive"
        );
        // Keeps every balance inside u128 and every product inside u256.
        require!(
            cfg.claim_amount
                .checked_mul(cfg.claim_cap as u128)
                .is_some_and(|total| total <= 10u128.pow(32)),
            "ERR_PARAMS: claim_amount × claim_cap must not exceed 10^32"
        );
        Self {
            config: cfg,
            genesis_ns: env::block_timestamp(),
            accounts: LookupMap::new(b"a"),
            claimed: LookupSet::new(b"c"),
            total_shares: Wide::default(),
            index: ray().into(),
            scale: 0,
            round: 0,
            round_supply: 0,
            round_hero: None,
            it: None,
            collapse_run: 0,
            claims_made: 0,
            stats: Stats::default(),
            history: Vector::new(b"h"),
            heroes: IterableMap::new(b"r"),
        }
    }

    /// §5.1 Faucet claim: once per account while claims are open.
    /// Attach the storage fee if the account is not registered yet; any excess is refunded.
    #[payable]
    pub fn claim(&mut self) {
        self.settle();
        let caller = env::predecessor_account_id();
        require!(!self.claimed.contains(&caller), "ERR_ALREADY_CLAIMED");
        require!(
            self.claims_made < self.config.claim_cap,
            "ERR_CLAIMS_CLOSED"
        );

        let deposit = env::attached_deposit();
        let refund = if self.accounts.contains_key(&caller) {
            deposit
        } else {
            require!(
                deposit >= STORAGE_FEE,
                "ERR_STORAGE: attach the storage fee to register"
            );
            self.accounts.insert(
                caller.clone(),
                Account {
                    shares: Wide::default(),
                    scale: self.scale,
                },
            );
            deposit.saturating_sub(STORAGE_FEE)
        };

        let amount = self.config.claim_amount;
        let minted = shares_floor(amount, self.index.into());
        let held = self.shares_of(&caller);
        self.set_shares(&caller, held + minted);
        self.total_shares = (U256::from(self.total_shares) + minted).into();
        self.claimed.insert(caller.clone());
        self.claims_made += 1;
        events::ft_mint(&caller, amount, "claim");

        if !refund.is_zero() {
            Promise::new(caller).transfer(refund).detach();
        }
    }

    /// §5.2 Save the current round by burning the current sacrifice cost and become It.
    /// Only the first caller in a round succeeds, so nobody pays twice.
    ///
    /// `round` and `max_cost` are optional guards against a transaction that lands
    /// later than intended (in the next round, at a higher cost).
    pub fn volunteer(&mut self, round: Option<u64>, max_cost: Option<U128>) -> U128 {
        self.settle();
        let caller = env::predecessor_account_id();
        require!(self.round_hero.is_none(), "ERR_ALREADY_SAVED");
        require!(self.round_supply > 0, "ERR_NOTHING_TO_SAVE");
        require!(round.is_none_or(|r| r == self.round), "ERR_WRONG_ROUND");

        let now = env::block_timestamp();
        let elapsed = now - self.round_start_ns(self.round);
        let cost = cost_at(&self.config, self.round_supply, elapsed);
        require!(
            max_cost.is_none_or(|max| cost <= max.0),
            "ERR_COST_TOO_HIGH"
        );

        let burn = shares_ceil(cost, self.index.into());
        let held = self.shares_of(&caller);
        require!(
            self.accounts.contains_key(&caller) && burn <= held,
            "ERR_INSUFFICIENT"
        );

        self.set_shares(&caller, held - burn);
        self.total_shares = (U256::from(self.total_shares) - burn).into();
        self.round_hero = Some(caller.clone());
        self.it = Some(caller.clone());
        self.collapse_run = 0;

        let ms_left = (self.config.round_ns - elapsed) / 1_000_000;
        self.stats.total_burned = U128(self.stats.total_burned.0 + cost);
        if self.stats.closest_call_ms.is_none_or(|best| ms_left < best) {
            self.stats.closest_call_ms = Some(ms_left);
        }
        let mut hero = self.heroes.get(&caller).cloned().unwrap_or_default();
        hero.saves += 1;
        hero.burned += cost;
        self.heroes.insert(caller.clone(), hero);
        self.history.push(Entry::Saved {
            round: self.round,
            hero: caller.clone(),
            cost: U128(cost),
            ms_left,
        });

        events::ft_burn(&caller, cost, "volunteer");
        events::round_saved(self.round, &caller, cost, ms_left);
        U128(cost)
    }

    /// §5.4 Settle elapsed rounds. Anyone may call this; returns how many rounds the loop closed.
    pub fn poke(&mut self) -> u32 {
        self.settle()
    }
}

/// §5.2 step 3: the sacrifice cost `elapsed` nanoseconds into a round.
pub(crate) fn cost_at(cfg: &Config, round_supply: u128, elapsed: u64) -> u128 {
    let elapsed = elapsed.min(cfg.round_ns) as u128;
    let span = (cfg.max_cost_ppm - cfg.min_cost_ppm) as u128;
    let rate_ppm = cfg.max_cost_ppm as u128 - span * elapsed / cfg.round_ns as u128;
    let cost = math::to_u128(mul_div_floor(
        U256::from(round_supply),
        U256::from(rate_ppm),
        U256::from(PPM),
    ));
    cost.max(1)
}

impl Contract {
    pub(crate) fn round_start_ns(&self, round: u64) -> u64 {
        self.genesis_ns + round * self.config.round_ns
    }

    pub(crate) fn current_round(&self, now: u64) -> u64 {
        (now - self.genesis_ns) / self.config.round_ns
    }

    /// `eff(account)` at the stored scale; zero for unregistered accounts.
    pub(crate) fn shares_of(&self, account: &AccountId) -> U256 {
        self.accounts
            .get(account)
            .map(|a| a.eff(self.scale))
            .unwrap_or_default()
    }

    /// Write normalised shares for a registered account.
    pub(crate) fn set_shares(&mut self, account: &AccountId, shares: U256) {
        self.accounts.insert(
            account.clone(),
            Account {
                shares: shares.into(),
                scale: self.scale,
            },
        );
    }

    /// It, if set and still registered.
    pub(crate) fn it_registered(&self) -> Option<&AccountId> {
        self.it
            .as_ref()
            .filter(|it| self.accounts.contains_key(*it))
    }

    pub(crate) fn core(&self) -> Core {
        let it = self.it_registered();
        Core {
            index: self.index.into(),
            total_shares: self.total_shares.into(),
            scale: self.scale,
            round: self.round,
            round_supply: self.round_supply,
            saved: self.round_hero.is_some(),
            it_present: it.is_some(),
            it_shares: it.map(|it| self.shares_of(it)).unwrap_or_default(),
            it_scale: self.scale,
            collapse_run: self.collapse_run,
            stats: self.stats.clone(),
        }
    }

    /// §4 settlement. Returns the number of rounds closed by the loop body.
    pub(crate) fn settle(&mut self) -> u32 {
        let target = self.current_round(env::block_timestamp());
        if self.round >= target {
            return 0;
        }
        let from_round = self.round;
        let mut core = self.core();
        let closed = core.advance(&self.config, target);

        self.index = core.index.into();
        self.total_shares = core.total_shares.into();
        self.scale = core.scale;
        self.round = core.round;
        self.round_supply = core.round_supply;
        self.round_hero = None;
        self.collapse_run = core.collapse_run;
        self.stats = core.stats;

        if let (Some((first, last)), Some(it)) = (closed.run, self.it.clone()) {
            // The collapsed rounds paid `closed.paid` to It: write It's shares and totals.
            self.accounts.insert(
                it.clone(),
                Account {
                    shares: core.it_shares.into(),
                    scale: core.it_scale,
                },
            );
            let mut hero = self.heroes.get(&it).cloned().unwrap_or_default();
            hero.collected += closed.paid;
            self.heroes.insert(it.clone(), hero);

            let len = self.history.len();
            let merged = len > 0
                && match self.history.get_mut(len - 1) {
                    Some(Entry::Collapsed {
                        last_round,
                        count,
                        it: prev,
                        paid,
                        ..
                    }) if *last_round + 1 == first && *prev == it => {
                        *last_round = last;
                        *count += last - first + 1;
                        *paid = U128(paid.0 + closed.paid);
                        true
                    }
                    _ => false,
                };
            if !merged {
                self.history.push(Entry::Collapsed {
                    first_round: first,
                    last_round: last,
                    count: last - first + 1,
                    it,
                    paid: U128(closed.paid),
                });
            }
        }

        events::rounds_closed(
            from_round,
            self.round - 1,
            closed.saved,
            closed.collapsed,
            closed.paid,
            self.it.as_ref(),
            core.index.to_string(),
            core.scale,
        );
        closed.n
    }
}

// Declared last so that adding it did not shift any line number above: panic locations are
// part of the compiled code, and the deployed build predates this module.
#[cfg(test)]
mod fuzz;

//! Read-only methods. Each applies settlement virtually as of the current block
//! time, so answers are correct even if nobody has called the contract for many
//! rounds (§6).

use crate::math::{Account, amount_of};
use crate::{
    Closed, Contract, ContractExt, Core, DECIMALS, Entry, MAX_COLLAPSE_RUN, Stats, cost_at,
};
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, env, near};
use primitive_types::U256;

#[near(serializers = [json])]
pub struct ConfigView {
    pub round_ns: U64,
    pub max_cost_ppm: u32,
    pub min_cost_ppm: u32,
    pub cut_ppm: u32,
    pub claim_amount: U128,
    pub claim_cap: u32,
    pub genesis_ns: U64,
    pub decimals: u8,
    pub max_collapse_run: u32,
}

#[near(serializers = [json])]
pub struct StateView {
    pub now_ns: U64,
    pub round: u64,
    pub round_start_ns: U64,
    pub round_end_ns: U64,
    pub saved: bool,
    pub hero: Option<AccountId>,
    pub it: Option<AccountId>,
    pub armed: bool,
    pub collapse_run: u32,
    pub cost_now: U128,
    pub round_supply: U128,
    pub total_supply: U128,
    pub index: String,
    pub scale: u32,
    pub claims_made: u32,
    pub claim_open: bool,
    pub stats: Stats,
}

#[near(serializers = [json])]
pub struct AccountView {
    pub registered: bool,
    pub claimed: bool,
    pub balance: U128,
    pub saves: u32,
    pub burned: U128,
    pub collected: U128,
    pub is_it: bool,
}

#[near(serializers = [json])]
pub struct HeroView {
    pub account_id: AccountId,
    pub saves: u32,
    pub burned: U128,
    pub collected: U128,
}

/// The state as it would be after `settle()` at the current block time.
pub(crate) struct Projection {
    pub core: Core,
    pub closed: Closed,
    pub now: u64,
}

impl Contract {
    pub(crate) fn project(&self) -> Projection {
        let now = env::block_timestamp();
        let mut core = self.core();
        let closed = core.advance(&self.config, self.current_round(now));
        Projection { core, closed, now }
    }

    /// An account's effective shares after virtual settlement.
    pub(crate) fn projected_shares(&self, p: &Projection, account_id: &AccountId) -> U256 {
        if p.core.it_present && self.it.as_ref() == Some(account_id) {
            return Account {
                shares: p.core.it_shares.into(),
                scale: p.core.it_scale,
            }
            .eff(p.core.scale);
        }
        self.accounts
            .get(account_id)
            .map(|a| a.eff(p.core.scale))
            .unwrap_or_default()
    }

    /// Is the virtual collapsed run a continuation of the last stored entry?
    fn run_extends_last(&self, first: u64) -> bool {
        let stored = self.history.len();
        stored > 0
            && matches!(self.history.get(stored - 1),
                Some(Entry::Collapsed { last_round, it, .. })
                    if *last_round + 1 == first && Some(it) == self.it.as_ref())
    }

    fn merged_history_len(&self, p: &Projection) -> u32 {
        match p.closed.run {
            Some((first, _)) if !self.run_extends_last(first) => self.history.len() + 1,
            _ => self.history.len(),
        }
    }
}

#[near]
impl Contract {
    pub fn get_config(&self) -> ConfigView {
        let c = &self.config;
        ConfigView {
            round_ns: U64(c.round_ns),
            max_cost_ppm: c.max_cost_ppm,
            min_cost_ppm: c.min_cost_ppm,
            cut_ppm: c.cut_ppm,
            claim_amount: U128(c.claim_amount),
            claim_cap: c.claim_cap,
            genesis_ns: U64(self.genesis_ns),
            decimals: DECIMALS,
            max_collapse_run: MAX_COLLAPSE_RUN,
        }
    }

    pub fn get_state(&self) -> StateView {
        let p = self.project();
        let core = &p.core;
        let round_start = self.round_start_ns(core.round);
        // The stored volunteer only belongs to the stored round; a virtually opened round has none.
        let hero = if core.round == self.round {
            self.round_hero.clone()
        } else {
            None
        };
        let cost_now = if hero.is_some() || core.round_supply == 0 {
            0
        } else {
            cost_at(&self.config, core.round_supply, p.now - round_start)
        };
        StateView {
            now_ns: U64(p.now),
            round: core.round,
            round_start_ns: U64(round_start),
            round_end_ns: U64(round_start + self.config.round_ns),
            saved: hero.is_some(),
            hero,
            it: self.it_registered().cloned(),
            armed: core.armed(),
            collapse_run: core.collapse_run,
            cost_now: U128(cost_now),
            round_supply: U128(core.round_supply),
            total_supply: U128(core.supply()),
            index: core.index.to_string(),
            scale: core.scale,
            claims_made: self.claims_made,
            claim_open: self.claims_made < self.config.claim_cap,
            stats: core.stats.clone(),
        }
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        let p = self.project();
        let hero = self.heroes.get(&account_id).cloned().unwrap_or_default();
        let is_it = self.it_registered() == Some(&account_id);
        AccountView {
            registered: self.accounts.contains_key(&account_id),
            claimed: self.claimed.contains(&account_id),
            balance: U128(amount_of(
                self.projected_shares(&p, &account_id),
                p.core.index,
            )),
            saves: hero.saves,
            burned: U128(hero.burned),
            collected: U128(hero.collected + if is_it { p.closed.paid } else { 0 }),
            is_it,
        }
    }

    pub fn get_history_len(&self) -> u32 {
        self.merged_history_len(&self.project())
    }

    /// Oldest first. Rounds that would close as collapsed right now are merged into
    /// the last stored entry when adjacent and paid to the same It; otherwise they
    /// appear as one extra trailing entry.
    pub fn get_history(&self, from_index: u32, limit: u32) -> Vec<Entry> {
        let p = self.project();
        let stored = self.history.len();
        let end = self
            .merged_history_len(&p)
            .min(from_index.saturating_add(limit.min(100)));
        let run = p.closed.run.zip(self.it.clone());
        (from_index..end)
            .filter_map(|i| match (self.history.get(i), &run) {
                (
                    Some(Entry::Collapsed {
                        first_round,
                        count,
                        it,
                        paid,
                        ..
                    }),
                    Some(((first, last), _)),
                ) if i + 1 == stored && self.run_extends_last(*first) => Some(Entry::Collapsed {
                    first_round: *first_round,
                    last_round: *last,
                    count: count + (last - first + 1),
                    it: it.clone(),
                    paid: U128(paid.0 + p.closed.paid),
                }),
                (Some(entry), _) => Some(entry.clone()),
                (None, Some(((first, last), it))) => Some(Entry::Collapsed {
                    first_round: *first,
                    last_round: *last,
                    count: last - first + 1,
                    it: it.clone(),
                    paid: U128(p.closed.paid),
                }),
                (None, None) => None,
            })
            .collect()
    }

    /// Insertion order; sort client-side. `collected` includes what It would be paid right now.
    pub fn get_heroes(&self, from_index: u32, limit: u32) -> Vec<HeroView> {
        let p = self.project();
        let it = self.it_registered();
        self.heroes
            .iter()
            .skip(from_index as usize)
            .take(limit.min(100) as usize)
            .map(|(account_id, hero)| HeroView {
                account_id: account_id.clone(),
                saves: hero.saves,
                burned: U128(hero.burned),
                collected: U128(
                    hero.collected
                        + if it == Some(account_id) {
                            p.closed.paid
                        } else {
                            0
                        },
                ),
            })
            .collect()
    }
}

//! NEP-297 events: standard `nep141` events plus custom `notit` events (docs/SPEC.md §7).

use near_sdk::serde_json::{Value, json};
use near_sdk::{AccountId, env};

fn emit(standard: &str, event: &str, data: Value) {
    let line = json!({
        "standard": standard,
        "version": "1.0.0",
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{line}"));
}

pub fn ft_mint(owner_id: &AccountId, amount: u128, memo: &str) {
    emit(
        "nep141",
        "ft_mint",
        json!([{ "owner_id": owner_id, "amount": amount.to_string(), "memo": memo }]),
    );
}

pub fn ft_burn(owner_id: &AccountId, amount: u128, memo: &str) {
    emit(
        "nep141",
        "ft_burn",
        json!([{ "owner_id": owner_id, "amount": amount.to_string(), "memo": memo }]),
    );
}

pub fn ft_transfer(
    old_owner_id: &AccountId,
    new_owner_id: &AccountId,
    amount: u128,
    memo: Option<&str>,
) {
    let mut item = json!({
        "old_owner_id": old_owner_id,
        "new_owner_id": new_owner_id,
        "amount": amount.to_string(),
    });
    if let Some(memo) = memo {
        item["memo"] = json!(memo);
    }
    emit("nep141", "ft_transfer", json!([item]));
}

pub fn round_saved(round: u64, hero: &AccountId, cost: u128, ms_left: u64) {
    emit(
        "notit",
        "round_saved",
        json!({ "round": round, "hero": hero, "cost": cost.to_string(), "ms_left": ms_left }),
    );
}

#[allow(clippy::too_many_arguments)]
pub fn rounds_closed(
    from_round: u64,
    to_round: u64,
    saved: u64,
    collapsed: u64,
    paid: u128,
    it: Option<&AccountId>,
    index: String,
    scale: u32,
) {
    emit(
        "notit",
        "rounds_closed",
        json!({
            "from_round": from_round,
            "to_round": to_round,
            "saved": saved,
            "collapsed": collapsed,
            "paid": paid.to_string(),
            "it": it,
            "index": index,
            "scale": scale,
        }),
    );
}

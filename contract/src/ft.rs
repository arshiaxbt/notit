//! NEP-141 fungible token core and NEP-148 metadata on top of the share model (§5.3).

use crate::math::{Account, Wide, amount_of, mul_div_floor, shares_ceil};
use crate::{Contract, ContractExt, DECIMALS, events};
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, Gas, PromiseOrValue, assert_one_yocto, env, ext_contract, near, require,
};
use primitive_types::U256;

const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(30);

const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Ccircle cx='48' cy='48' r='48' fill='%23ff4d2e'/%3E%3Ctext x='48' y='44' font-family='Arial,sans-serif' font-size='26' font-weight='900' text-anchor='middle' fill='%23fff'%3ENOT%3C/text%3E%3Ctext x='48' y='72' font-family='Arial,sans-serif' font-size='30' font-weight='900' text-anchor='middle' fill='%23111'%3EIT%3C/text%3E%3C/svg%3E";

/// NEP-148 metadata.
#[near(serializers = [json])]
pub struct FungibleTokenMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[allow(dead_code)]
#[ext_contract(ext_ft_receiver)]
pub trait FungibleTokenReceiver {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128>;
}

#[near]
impl Contract {
    /// NEP-141 transfer. Requires exactly 1 yoctoNEAR so that function-call keys cannot move tokens.
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        self.settle();
        let sender_id = env::predecessor_account_id();
        self.internal_transfer(&sender_id, &receiver_id, amount.0, memo.as_deref());
    }

    /// NEP-141 transfer-and-call.
    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        require!(
            env::prepaid_gas() > GAS_FOR_FT_TRANSFER_CALL.saturating_add(GAS_FOR_RESOLVE_TRANSFER),
            "ERR_GAS: more gas is required"
        );
        self.settle();
        let sender_id = env::predecessor_account_id();
        let moved = self.internal_transfer(&sender_id, &receiver_id, amount.0, memo.as_deref());
        ext_ft_receiver::ext(receiver_id.clone())
            .with_static_gas(
                env::prepaid_gas()
                    .saturating_sub(GAS_FOR_FT_TRANSFER_CALL)
                    .saturating_sub(GAS_FOR_RESOLVE_TRANSFER),
            )
            .ft_on_transfer(sender_id.clone(), amount, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .ft_resolve_transfer(
                        sender_id,
                        receiver_id,
                        amount,
                        moved.to_string(),
                        self.scale,
                    ),
            )
            .into()
    }

    /// NEP-141 callback: returns the unused part of a transfer-and-call to the sender.
    ///
    /// The refund is computed in the shares that were debited, not in units, so a
    /// collapse that settles between the debit and this callback cannot make the
    /// receiver return more than it was given. This method never settles and never
    /// panics on game state. Returns the amount used by the receiver.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
        shares: String,
        scale: u32,
    ) -> U128 {
        let amount = amount.0;
        // The receiver reports how much it did NOT use; a failed call means nothing was used.
        let unused = match env::promise_result_checked(0, 64) {
            Ok(bytes) => match near_sdk::serde_json::from_slice::<U128>(&bytes) {
                Ok(unused) => unused.0.min(amount),
                Err(_) => amount,
            },
            Err(_) => amount,
        };
        if unused == 0 || amount == 0 {
            return U128(amount);
        }
        // The debited shares, brought to the current rescale generation.
        let debited = U256::from_dec_str(&shares).unwrap_or_default();
        let debited = Account {
            shares: Wide::from(debited),
            scale: scale.min(self.scale),
        }
        .eff(self.scale);
        let refund = mul_div_floor(debited, U256::from(unused), U256::from(amount));
        let back = refund.min(self.shares_of(&receiver_id));
        if back.is_zero() || !self.accounts.contains_key(&receiver_id) {
            return U128(amount);
        }
        // Report the returned units pro rata when the receiver could not cover the refund.
        let returned = if back == refund {
            unused
        } else {
            mul_div_floor(U256::from(unused), back, refund).as_u128()
        };
        let receiver_shares = self.shares_of(&receiver_id);
        self.set_shares(&receiver_id, receiver_shares - back);
        if self.accounts.contains_key(&sender_id) {
            let sender_shares = self.shares_of(&sender_id);
            self.set_shares(&sender_id, sender_shares + back);
            events::ft_transfer(&receiver_id, &sender_id, returned, Some("refund"));
        } else {
            // The sender unregistered in the meantime: the refund is burned.
            self.total_shares = (U256::from(self.total_shares) - back).into();
            events::ft_burn(&receiver_id, returned, "refund to unregistered sender");
        }
        U128(amount - returned)
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.project().core.supply())
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        let p = self.project();
        U128(amount_of(
            self.projected_shares(&p, &account_id),
            p.core.index,
        ))
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: "ft-1.0.0".to_string(),
            name: "Not It".to_string(),
            symbol: "NOTIT".to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }
}

impl Contract {
    /// §5.3 steps 2–4. The same number of shares leaves the sender and reaches the
    /// receiver, so a transfer can neither create nor destroy shares. Returns the
    /// shares moved.
    pub(crate) fn internal_transfer(
        &mut self,
        sender_id: &AccountId,
        receiver_id: &AccountId,
        amount: u128,
        memo: Option<&str>,
    ) -> U256 {
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        require!(sender_id != receiver_id, "ERR_SELF_TRANSFER");
        require!(
            self.accounts.contains_key(sender_id),
            "ERR_UNREGISTERED: sender is not registered"
        );
        require!(
            self.accounts.contains_key(receiver_id),
            "ERR_UNREGISTERED: receiver is not registered"
        );

        let moved = shares_ceil(amount, self.index.into());
        let sender_shares = self.shares_of(sender_id);
        require!(moved <= sender_shares, "ERR_INSUFFICIENT");
        let receiver_shares = self.shares_of(receiver_id);
        self.set_shares(sender_id, sender_shares - moved);
        self.set_shares(receiver_id, receiver_shares + moved);
        events::ft_transfer(sender_id, receiver_id, amount, memo);
        moved
    }
}

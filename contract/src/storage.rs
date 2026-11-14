//! NEP-145 storage management with a fixed registration fee (§5.5).
//! Only `storage_unregister` settles.

use crate::math::{Account, Wide, amount_of};
use crate::{Contract, ContractExt, STORAGE_FEE, STORAGE_REFUND, events};
use near_sdk::{AccountId, NearToken, Promise, assert_one_yocto, env, near, require};
use primitive_types::U256;

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: NearToken,
    pub available: NearToken,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: NearToken,
    pub max: Option<NearToken>,
}

#[near]
impl Contract {
    /// Register `account_id` (default: the caller). The fee is fixed; any excess is refunded.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only; // min == max, so every deposit is registration-only
        let deposit = env::attached_deposit();
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        // Tokens sent to the contract's own account could never be moved again.
        require!(
            account_id != env::current_account_id(),
            "ERR_STORAGE: the contract account cannot hold tokens"
        );
        let refund = if self.accounts.contains_key(&account_id) {
            deposit
        } else {
            require!(
                deposit >= STORAGE_FEE,
                "ERR_STORAGE: attach the storage fee to register"
            );
            self.accounts.insert(
                account_id,
                Account {
                    shares: Wide::default(),
                    scale: self.scale,
                },
            );
            deposit.saturating_sub(STORAGE_FEE)
        };
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(refund)
                .detach();
        }
        StorageBalance {
            total: STORAGE_FEE,
            available: NearToken::from_yoctonear(0),
        }
    }

    /// Nothing is ever withdrawable above the fixed fee; kept for NEP-145 compatibility.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        require!(self.accounts.contains_key(&caller), "ERR_UNREGISTERED");
        require!(
            amount.is_none_or(|a| a.is_zero()),
            "ERR_STORAGE: nothing is available to withdraw"
        );
        StorageBalance {
            total: STORAGE_FEE,
            available: NearToken::from_yoctonear(0),
        }
    }

    /// Unregister the caller and return `STORAGE_REFUND` (half the fee; the other half
    /// keeps paying for the caller's permanent claim and volunteer records). Non-zero
    /// shares require `force`, which burns them. If the caller is It, nobody is It afterwards.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        // Settle first, so rounds that already ended are charged and paid before the
        // account leaves. An It with unsaved rounds pending is paid for them here.
        self.settle();
        let caller = env::predecessor_account_id();
        if !self.accounts.contains_key(&caller) {
            return false;
        }
        let shares = self.shares_of(&caller);
        if !shares.is_zero() {
            require!(
                force.unwrap_or(false),
                "ERR_STORAGE: balance is not zero; pass force to burn it"
            );
            let burned = amount_of(shares, self.index.into());
            self.total_shares = (U256::from(self.total_shares) - shares).into();
            events::ft_burn(&caller, burned, "unregister");
        }
        self.accounts.remove(&caller);
        if self.it.as_ref() == Some(&caller) {
            self.it = None;
        }
        Promise::new(caller)
            .transfer(STORAGE_REFUND.saturating_add(NearToken::from_yoctonear(1)))
            .detach();
        true
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: STORAGE_FEE,
            max: Some(STORAGE_FEE),
        }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.accounts
            .contains_key(&account_id)
            .then_some(StorageBalance {
                total: STORAGE_FEE,
                available: NearToken::from_yoctonear(0),
            })
    }
}

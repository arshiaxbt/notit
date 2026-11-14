//! Fixed-point helpers. Every division states its rounding (docs/SPEC.md §3, §5).

use near_sdk::near;
use primitive_types::{U256, U512};

/// Fixed-point scale of `index`: 10^27.
pub const RAY: u128 = 1_000_000_000_000_000_000_000_000_000;
/// Parts-per-million scale for rates.
pub const PPM: u128 = 1_000_000;
/// Rescale when `index` falls below this (§2).
pub const RESCALE_BELOW: u128 = 1_000_000_000_000_000_000;
/// Rescale multiplier (§2).
pub const RESCALE_FACTOR: u128 = 1_000_000_000;

/// 256-bit value in contract storage (four little-endian u64 limbs).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct Wide(pub [u64; 4]);

impl From<U256> for Wide {
    fn from(v: U256) -> Self {
        Wide(v.0)
    }
}

impl From<Wide> for U256 {
    fn from(v: Wide) -> Self {
        U256(v.0)
    }
}

/// An account's shares, recorded at the rescale generation they were last written in (§3).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default, Debug)]
pub struct Account {
    pub shares: Wide,
    pub scale: u32,
}

impl Account {
    /// `eff`: shares at generation `scale` = floor(shares / RESCALE_FACTOR^(scale − self.scale)).
    pub fn eff(&self, scale: u32) -> U256 {
        let mut shares: U256 = self.shares.into();
        for _ in self.scale..scale {
            if shares.is_zero() {
                break;
            }
            shares /= U256::from(RESCALE_FACTOR);
        }
        shares
    }
}

pub fn ray() -> U256 {
    U256::from(RAY)
}

/// floor(a × b / d). The product is formed in 512 bits, so it cannot overflow.
pub fn mul_div_floor(a: U256, b: U256, d: U256) -> U256 {
    let q = a.full_mul(b) / U512::from(d);
    U256::try_from(q).expect("ERR_OVERFLOW")
}

/// ceil(a × b / d). The product is formed in 512 bits, so it cannot overflow.
pub fn mul_div_ceil(a: U256, b: U256, d: U256) -> U256 {
    let p = a.full_mul(b);
    let d = U512::from(d);
    let q = U256::try_from(p / d).expect("ERR_OVERFLOW");
    if (p % d).is_zero() {
        q
    } else {
        q + U256::one()
    }
}

pub fn to_u128(v: U256) -> u128 {
    assert!(v <= U256::from(u128::MAX), "ERR_OVERFLOW");
    v.as_u128()
}

/// amount = floor(shares × index / RAY)
pub fn amount_of(shares: U256, index: U256) -> u128 {
    to_u128(mul_div_floor(shares, index, ray()))
}

/// shares = floor(amount × RAY / index); `index` is never zero (§4.1 step 5).
pub fn shares_floor(amount: u128, index: U256) -> U256 {
    mul_div_floor(U256::from(amount), ray(), index)
}

/// shares = ceil(amount × RAY / index); `index` is never zero (§4.1 step 5).
pub fn shares_ceil(amount: u128, index: U256) -> U256 {
    mul_div_ceil(U256::from(amount), ray(), index)
}

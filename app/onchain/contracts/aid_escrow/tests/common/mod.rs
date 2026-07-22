//! Shared test helpers for the `aid_escrow` integration-test suite.
//!
//! Currently exposes a minimal Soroban contract whose `decimals()`
//! function returns a configurable value, so the test suite can drive the
//! `validate_token` boundary branches without spinning up a full Stellar
//! asset contract (which always reports 7 decimals).

#![cfg(test)]

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

const KEY_DECIMALS: Symbol = symbol_short!("decimals");

/// A mock token whose `decimals()` is set in storage by `init()` and
/// returns that value on every call.  `balance` and `transfer` are
/// intentional no-ops so the contract never accidentally moves tokens in
/// tests that only care about decimal validation.
#[contract]
pub struct MockDecimalsToken;

#[contractimpl]
impl MockDecimalsToken {
    /// Sets the decimals value returned by subsequent `decimals()` calls.
    ///
    /// Intentionally has **no authorization check** — this is a test
    /// helper only, and forcing `require_auth()` on the constructor
    /// would mean every test would have to call `mock_all_auths()` for
    /// the mock side, which is unnecessary friction.
    pub fn init(env: Env, decimals: u32) {
        env.storage().instance().set(&KEY_DECIMALS, &decimals);
    }

    /// Returns the decimals value previously stored by `init()`.
    /// Defaults to 0 for uninitialized contracts.
    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&KEY_DECIMALS).unwrap_or(0)
    }

    /// Returns 0 — kept here so the SDK can match the SAC token
    /// interface shape; never relied on by validate_token.
    pub fn balance(_env: Env, _account: Address) -> i128 {
        0
    }

    /// No-op — kept for SAC compatibility; transfer validation is
    /// deliberately not exercised here.
    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
}

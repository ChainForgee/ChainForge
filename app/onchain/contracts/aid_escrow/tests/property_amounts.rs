//! Property-based (fuzz) tests for aid-escrow amount math  (issue #230)
//!
//! # What is tested
//!
//! Every property runs 1 000 random sequences (configured via
//! `PROPTEST_CASES=1000` or the `ProptestConfig` override below).
//!
//! The three core invariants asserted after every sequence:
//!
//! 1. **Decimal alignment** — every amount stored in a package is a
//!    multiple of `UNIT` (10^7 for 7-decimal Stellar assets).
//! 2. **Non-negativity** — `total_locked` and `total_claimed` are always
//!    `>= 0` for the token under test.
//! 3. **Conservation of value** — `total_claimed + contract_balance ==
//!    total_funded` at all times (no tokens are created or destroyed).
//!
//! # Shrinking
//!
//! proptest automatically shrinks a failing case.  The minimal
//! reproduction is printed together with the PRNG seed so CI can replay
//! the exact sequence with `PROPTEST_SEED=<seed>`.
//!
//! # Running
//!
//! ```bash
//! cargo test --test property_amounts -- --nocapture
//! # Override case count (default already 1 000):
//! PROPTEST_CASES=1000 cargo test --test property_amounts
//! ```

#![cfg(test)]

use aid_escrow::{AidEscrow, AidEscrowClient};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, Map,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Smallest whole unit for a 7-decimal Stellar asset (one "stroop" group).
const UNIT: i128 = 10_000_000;

/// Maximum amount per package in whole units.  Keeping it small speeds up
/// shrinking while still exercising a wide range of sums.
const MAX_UNITS_PER_PKG: i128 = 100;

/// Maximum packages per sequence.  At 1 000 cases × 20 packages the suite
/// stays well within the 30 s CI budget.
const MAX_PACKAGES: usize = 20;

// ---------------------------------------------------------------------------
// Operations the fuzzer can apply
// ---------------------------------------------------------------------------

/// All state-changing operations the property engine can interleave.
#[derive(Debug, Clone)]
enum Op {
    /// Fund the escrow pool with `whole_units` whole tokens.
    Fund { whole_units: i128 },
    /// Create a package for `whole_units` whole tokens.
    CreatePackage { whole_units: i128 },
    /// Claim the package at index `idx` (wraps around if out of range).
    Claim { idx: usize },
    /// Disburse the package at index `idx`.
    Disburse { idx: usize },
    /// Revoke the package at index `idx`.
    Revoke { idx: usize },
    /// Refund the package at index `idx`.
    Refund { idx: usize },
}

// ---------------------------------------------------------------------------
// Proptest strategies
// ---------------------------------------------------------------------------

fn arb_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        // Fund: 1–50 whole units
        (1i128..=50i128).prop_map(|u| Op::Fund { whole_units: u }),
        // CreatePackage: 1–MAX_UNITS_PER_PKG whole units
        (1i128..=MAX_UNITS_PER_PKG).prop_map(|u| Op::CreatePackage { whole_units: u }),
        // Claim / Disburse / Revoke / Refund by index
        any::<usize>().prop_map(|i| Op::Claim { idx: i }),
        any::<usize>().prop_map(|i| Op::Disburse { idx: i }),
        any::<usize>().prop_map(|i| Op::Revoke { idx: i }),
        any::<usize>().prop_map(|i| Op::Refund { idx: i }),
    ]
}

fn arb_ops() -> impl Strategy<Value = Vec<Op>> {
    prop::collection::vec(arb_op(), 1..=MAX_PACKAGES)
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/// Execute a sequence of operations against a real Soroban test environment
/// and assert all three invariants after every step.
fn run_sequence(ops: Vec<Op>) {
    let env = Env::default();
    env.mock_all_auths();

    // Setup participants
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);

    // Deploy a 7-decimal Stellar asset
    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = token_contract.address();
    let token = TokenClient::new(&env, &token_addr);
    let token_sa = StellarAssetClient::new(&env, &token_addr);

    // Pre-mint a large reserve to the admin so Fund ops never hit a
    // wallet-balance error (we test contract math, not token minting).
    let reserve: i128 = 10_000 * UNIT;
    token_sa.mint(&admin, &reserve);

    // Deploy and initialise the escrow contract
    let contract_id = env.register(AidEscrow, ());
    let client = AidEscrowClient::new(&env, &contract_id);
    client.init(&admin);

    // Bookkeeping mirrors
    let mut total_funded: i128 = 0;
    // total_withdrawn tracks ALL tokens that left the contract to any address
    // (claim, disburse → recipient; refund → admin). This is broader than
    // get_total_claimed(), which only counts recipient-initiated claims.
    let mut total_withdrawn: i128 = 0;
    let mut active_pkg_ids: Vec<u64> = Vec::new();
    let mut next_id: u64 = 1_000; // start high to avoid collision with auto-ids

    for op in ops {
        match op {
            // ── Fund ────────────────────────────────────────────────────
            Op::Fund { whole_units } => {
                let amount = whole_units * UNIT;
                // Make sure admin wallet can cover this (top up if needed)
                let wallet_balance = token.balance(&admin);
                if wallet_balance < amount {
                    token_sa.mint(&admin, &(amount - wallet_balance + UNIT));
                }
                if client.try_fund(&token_addr, &admin, &amount).is_ok() {
                    total_funded += amount;
                }
            }

            // ── CreatePackage ────────────────────────────────────────────
            Op::CreatePackage { whole_units } => {
                let amount = whole_units * UNIT;
                let id = next_id;
                next_id += 1;
                let metadata = Map::new(&env);
                if client
                    .try_create_package(
                        &admin,
                        &id,
                        &recipient,
                        &amount,
                        &token_addr,
                        &0,
                        &metadata,
                    )
                    .is_ok()
                {
                    active_pkg_ids.push(id);
                }
            }

            // ── Claim ────────────────────────────────────────────────────
            // claim() → finalize_claim() → increments KEY_TOTAL_CLAIMED and
            // transfers amount to recipient.
            Op::Claim { idx } => {
                if !active_pkg_ids.is_empty() {
                    let id = active_pkg_ids[idx % active_pkg_ids.len()];
                    // Peek the package amount before the call so we can mirror
                    // the withdrawal regardless of which accounting key the
                    // contract uses internally.
                    if let Ok(Ok(pkg)) = client.try_get_package(&id) {
                        if client.try_claim(&id).is_ok() {
                            total_withdrawn += pkg.amount;
                            active_pkg_ids.retain(|&x| x != id);
                        }
                    }
                }
            }

            // ── Disburse ─────────────────────────────────────────────────
            // disburse() transfers amount to recipient but does NOT increment
            // KEY_TOTAL_CLAIMED — so we track it in total_withdrawn instead.
            Op::Disburse { idx } => {
                if !active_pkg_ids.is_empty() {
                    let id = active_pkg_ids[idx % active_pkg_ids.len()];
                    if let Ok(Ok(pkg)) = client.try_get_package(&id) {
                        if client.try_disburse(&id).is_ok() {
                            total_withdrawn += pkg.amount;
                            active_pkg_ids.retain(|&x| x != id);
                        }
                    }
                }
            }

            // ── Revoke ───────────────────────────────────────────────────
            // revoke() unlocks funds back to the pool (no token transfer out).
            Op::Revoke { idx } => {
                if !active_pkg_ids.is_empty() {
                    let id = active_pkg_ids[idx % active_pkg_ids.len()];
                    if client.try_revoke(&id).is_ok() {
                        active_pkg_ids.retain(|&x| x != id);
                    }
                }
            }

            // ── Refund ───────────────────────────────────────────────────
            // refund() transfers amount back to admin (out of the contract).
            Op::Refund { idx } => {
                if !active_pkg_ids.is_empty() {
                    let id = active_pkg_ids[idx % active_pkg_ids.len()];
                    if let Ok(Ok(pkg)) = client.try_get_package(&id) {
                        if client.try_refund(&id).is_ok() {
                            total_withdrawn += pkg.amount;
                            active_pkg_ids.retain(|&x| x != id);
                        }
                    }
                }
            }
        }

        // ── Assert invariants after every operation ──────────────────────

        let total_locked = client.get_total_locked(&token_addr);
        let total_claimed = client.get_total_claimed(&token_addr);
        let contract_balance = token.balance(&contract_id);

        // Invariant 1: locked and claimed are never negative
        assert!(
            total_locked >= 0,
            "INVARIANT VIOLATED: total_locked < 0  (locked={})",
            total_locked
        );
        assert!(
            total_claimed >= 0,
            "INVARIANT VIOLATED: total_claimed < 0  (claimed={})",
            total_claimed
        );

        // Invariant 2: contract is solvent (locked ≤ balance)
        assert!(
            contract_balance >= total_locked,
            "INVARIANT VIOLATED: contract_balance < total_locked  \
             (balance={}, locked={})",
            contract_balance,
            total_locked
        );

        // Invariant 3: conservation of value.
        //
        // The contract has two exit paths that move tokens out:
        //   a) claim / disburse  → recipient receives pkg.amount
        //   b) refund            → admin receives pkg.amount back
        //
        // get_total_claimed() only tracks path (a) when the recipient calls
        // claim(); admin-initiated disburse() does NOT update that counter.
        // We therefore use our own total_withdrawn mirror which covers both
        // paths, giving:
        //
        //   total_funded == contract_balance + total_withdrawn
        assert_eq!(
            contract_balance + total_withdrawn,
            total_funded,
            "INVARIANT VIOLATED: conservation of value failed  \
             (balance={}, withdrawn={}, sum={}, funded={})",
            contract_balance,
            total_withdrawn,
            contract_balance + total_withdrawn,
            total_funded
        );
    }
}

// ---------------------------------------------------------------------------
// Property: decimal alignment
// ---------------------------------------------------------------------------

// Every amount stored in a successfully created package must be an exact
// multiple of UNIT.  We generate amounts directly as multiples so this
// property verifies the contract does not silently mangle the value.
proptest! {
    #![proptest_config(ProptestConfig {
        cases: 1_000,
        max_shrink_iters: 10_000,
        ..ProptestConfig::default()
    })]

    #[test]
    fn prop_amount_is_multiple_of_unit(whole_units in 1i128..=MAX_UNITS_PER_PKG) {
        let env = Env::default();
        env.mock_all_auths();

        let admin    = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();
        let token_sa   = StellarAssetClient::new(&env, &token_addr);

        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        let amount = whole_units * UNIT;
        token_sa.mint(&admin, &amount);
        client.fund(&token_addr, &admin, &amount);

        let metadata = Map::new(&env);
        client
            .create_package(&admin, &1, &recipient, &amount, &token_addr, &0, &metadata);

        let pkg = client.get_package(&1);
        prop_assert_eq!(
            pkg.amount % UNIT,
            0,
            "Package amount {} is not a multiple of UNIT {}",
            pkg.amount,
            UNIT
        );
    }
}

// ---------------------------------------------------------------------------
// Property: non-negativity + conservation of value under random sequences
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 1_000,
        max_shrink_iters: 10_000,
        ..ProptestConfig::default()
    })]

    #[test]
    fn prop_invariants_under_random_sequence(ops in arb_ops()) {
        run_sequence(ops);
    }
}

// ---------------------------------------------------------------------------
// Property: fractional amounts (not multiples of UNIT) are always rejected
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 1_000,
        max_shrink_iters: 10_000,
        ..ProptestConfig::default()
    })]

    #[test]
    fn prop_fractional_amount_rejected(
        whole_units in 1i128..=50i128,
        remainder in 1i128..(UNIT - 1),
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin       = Address::generate(&env);
        let recipient   = Address::generate(&env);
        let token_admin = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();
        let token_sa   = StellarAssetClient::new(&env, &token_addr);

        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        // Fund with a clean amount first
        let clean_amount = whole_units * UNIT;
        token_sa.mint(&admin, &(clean_amount + remainder + UNIT));
        client.fund(&token_addr, &admin, &clean_amount);

        // Attempt to create a package with a fractional amount
        let fractional_amount = clean_amount + remainder;
        let metadata = Map::new(&env);
        let result = client.try_create_package(
            &admin, &1, &recipient, &fractional_amount, &token_addr, &0, &metadata,
        );

        prop_assert!(
            result.is_err(),
            "Expected fractional amount {} to be rejected, but it was accepted",
            fractional_amount
        );

        // Fund operation should also reject fractional amounts
        let fund_result = client.try_fund(&token_addr, &admin, &fractional_amount);
        prop_assert!(
            fund_result.is_err(),
            "Expected fund with fractional amount {} to be rejected",
            fractional_amount
        );
    }
}

// ---------------------------------------------------------------------------
// Property: locked never exceeds contract balance
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 1_000,
        max_shrink_iters: 10_000,
        ..ProptestConfig::default()
    })]

    #[test]
    fn prop_locked_never_exceeds_balance(
        fund_units   in 1i128..=200i128,
        pkg_units_a  in 1i128..=50i128,
        pkg_units_b  in 1i128..=50i128,
        pkg_units_c  in 1i128..=50i128,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin       = Address::generate(&env);
        let recipient   = Address::generate(&env);
        let token_admin = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();
        let token       = TokenClient::new(&env, &token_addr);
        let token_sa    = StellarAssetClient::new(&env, &token_addr);

        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        let fund_amount = fund_units * UNIT;
        token_sa.mint(&admin, &fund_amount);
        client.fund(&token_addr, &admin, &fund_amount);

        let amounts = [pkg_units_a * UNIT, pkg_units_b * UNIT, pkg_units_c * UNIT];
        let metadata = Map::new(&env);

        for (i, &amount) in amounts.iter().enumerate() {
            let _ = client.try_create_package(
                &admin, &(i as u64 + 1), &recipient, &amount, &token_addr, &0, &metadata,
            );
        }

        let total_locked    = client.get_total_locked(&token_addr);
        let contract_balance = token.balance(&contract_id);

        prop_assert!(
            contract_balance >= total_locked,
            "Solvency violated: balance={} < locked={}",
            contract_balance,
            total_locked
        );
        prop_assert!(total_locked >= 0, "locked is negative: {}", total_locked);
    }
}

// ---------------------------------------------------------------------------
// Property: conservation of value through full claim lifecycle
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 1_000,
        max_shrink_iters: 10_000,
        ..ProptestConfig::default()
    })]

    #[test]
    fn prop_conservation_through_full_lifecycle(
        whole_units in 1i128..=MAX_UNITS_PER_PKG,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin       = Address::generate(&env);
        let recipient   = Address::generate(&env);
        let token_admin = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();
        let token       = TokenClient::new(&env, &token_addr);
        let token_sa    = StellarAssetClient::new(&env, &token_addr);

        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        let amount = whole_units * UNIT;
        token_sa.mint(&admin, &amount);
        client.fund(&token_addr, &admin, &amount);

        // Before any packages: funded == balance
        prop_assert_eq!(
            token.balance(&contract_id),
            amount,
            "Initial balance mismatch"
        );

        let metadata = Map::new(&env);
        client
            .create_package(&admin, &1, &recipient, &amount, &token_addr, &0, &metadata);

        // After create: balance unchanged, locked == amount
        prop_assert_eq!(client.get_total_locked(&token_addr), amount);
        prop_assert_eq!(token.balance(&contract_id), amount);

        // Claim
        client.claim(&1);

        let total_claimed    = client.get_total_claimed(&token_addr);
        let contract_balance = token.balance(&contract_id);
        let total_locked     = client.get_total_locked(&token_addr);

        // After claim: locked back to 0
        prop_assert_eq!(total_locked, 0, "locked should be 0 after claim");

        // Conservation: what was claimed + what remains == what was funded
        prop_assert_eq!(
            total_claimed + contract_balance,
            amount,
            "Conservation violated: claimed={} balance={} funded={}",
            total_claimed,
            contract_balance,
            amount
        );

        // Recipient received the funds
        prop_assert_eq!(
            token.balance(&recipient),
            amount,
            "Recipient did not receive correct amount"
        );
    }
}

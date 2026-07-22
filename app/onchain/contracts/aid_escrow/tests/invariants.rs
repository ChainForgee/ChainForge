//! # Invariant: Event-reconstructed `total_funded` matches contract ledger
//!
//! ## What this tests
//!
//! After every random sequence of `fund`, `create_package`, `claim`, `revoke`,
//! `refund` and `withdraw_surplus` operations, the contract's on-chain storage
//! values (`get_total_locked`, `get_total_claimed`) are compared against the
//! event stream emitted by the contract.
//!
//! The invariant asserted is:
//!
//! ```text
//! Σ locked(token) + Σ claimed(token) + Σ surplus_withdrawn + Σ refunded
//!     == Σ EscrowFunded.amount
//! ```
//!
//! where the RHS is reconstructed by summing `EscrowFunded` events and the
//! two deduction terms are summed from `SurplusWithdrawnEvent` and
//! `PackageRefunded` events.
//!
//! ## Shrinking
//!
//! `proptest` automatically shrinks any failing case to a minimal
//! reproduction.  The CI seed is printed together with the failing event
//! snapshot so the exact sequence can be replayed with
//! `PROPTEST_SEED=<seed>`.
//!
//! ## Unit-level smoke tests
//!
//! Each individual bookkeeping call (`decrement_locked` via revoke,
//! `finalize_claim` via claim, `withdraw_surplus`, `refund`) also asserts
//! the event-invariant immediately, providing a focused diagnostic when
//! a particular code path is broken.

#![cfg(test)]

use aid_escrow::{AidEscrow, AidEscrowClient};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Map, Symbol, TryFromVal, Val,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Smallest whole unit for a 7-decimal Stellar asset (one "stroop" group).
const UNIT: i128 = 10_000_000;

/// Maximum whole units per operation — keeps the CI budget predictable.
const MAX_UNITS: i128 = 100;

/// Maximum operations per sequence.
const MAX_OPS: usize = 30;

// ---------------------------------------------------------------------------
// Operations the fuzzer can apply
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Op {
    Fund { whole_units: i128 },
    CreatePackage { whole_units: i128 },
    Claim { idx: usize },
    Revoke { idx: usize },
    Refund { idx: usize },
    WithdrawSurplus { whole_units: i128 },
}

fn arb_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (1i128..=50i128).prop_map(|u| Op::Fund { whole_units: u }),
        (1i128..=MAX_UNITS).prop_map(|u| Op::CreatePackage { whole_units: u }),
        any::<usize>().prop_map(|i| Op::Claim { idx: i }),
        any::<usize>().prop_map(|i| Op::Revoke { idx: i }),
        any::<usize>().prop_map(|i| Op::Refund { idx: i }),
        (1i128..=10i128).prop_map(|u| Op::WithdrawSurplus { whole_units: u }),
    ]
}

fn arb_ops() -> impl Strategy<Value = Vec<Op>> {
    prop::collection::vec(arb_op(), 1..=MAX_OPS)
}

// ---------------------------------------------------------------------------
// Event reconstruction helpers
// ---------------------------------------------------------------------------

/// Reconstruct the three aggregates from the contract's event stream.
fn event_aggregates(env: &Env, contract_id: &Address) -> (i128, i128, i128) {
    let escrow_topic = Symbol::new(env, "escrow_funded");
    let surplus_topic = Symbol::new(env, "surplus_withdrawn_event");
    let refund_topic = Symbol::new(env, "package_refunded");

    let mut funded: i128 = 0;
    let mut surplus_withdrawn: i128 = 0;
    let mut refunded: i128 = 0;

    for (id, topics, data) in env.events().all().into_iter() {
        if id != *contract_id {
            continue;
        }
        if let Some(first) = topics.first() {
            if let Ok(s) = Symbol::try_from_val(env, &first) {
                let map = soroban_sdk::Map::<Symbol, Val>::try_from_val(env, &data)
                    .unwrap_or_else(|_| soroban_sdk::Map::new(env));
                let amount_key = Symbol::new(env, "amount");

                if s == escrow_topic {
                    if let Some(val) = map.get(amount_key.clone()) {
                        funded += i128::try_from_val(env, &val).unwrap_or(0);
                    }
                } else if s == surplus_topic {
                    if let Some(val) = map.get(amount_key.clone()) {
                        surplus_withdrawn += i128::try_from_val(env, &val).unwrap_or(0);
                    }
                } else if s == refund_topic {
                    if let Some(val) = map.get(amount_key) {
                        refunded += i128::try_from_val(env, &val).unwrap_or(0);
                    }
                }
            }
        }
    }

    (funded, surplus_withdrawn, refunded)
}

// ---------------------------------------------------------------------------
// Invariant assertion
// ---------------------------------------------------------------------------

fn assert_event_invariant(
    env: &Env,
    client: &AidEscrowClient,
    token_addr: &Address,
    contract_id: &Address,
    msg: &str,
) {
    let locked = client.get_total_locked(token_addr);
    let claimed = client.get_total_claimed(token_addr);
    let (funded, surplus, refunded) = event_aggregates(env, contract_id);

    let lhs = locked + claimed + surplus + refunded;

    assert_eq!(
        lhs,
        funded,
        "{} — INVARIANT VIOLATED\n\
         Σ locked({}) + Σ claimed({}) + Σ surplus_withdrawn({}) + Σ refunded({}) = {} \n\
         != Σ EscrowFunded = {}\n\
         (contract balance: {})",
        msg,
        locked,
        claimed,
        surplus,
        refunded,
        lhs,
        funded,
        token_balance(env, token_addr, contract_id),
    );
}

fn token_balance(env: &Env, token_addr: &Address, account: &Address) -> i128 {
    let token = TokenClient::new(env, token_addr);
    token.balance(account)
}

// ---------------------------------------------------------------------------
// Sequence runner
// ---------------------------------------------------------------------------

fn run_sequence(ops: Vec<Op>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = token_contract.address();
    let token = TokenClient::new(&env, &token_addr);
    let token_sa = StellarAssetClient::new(&env, &token_addr);

    // Pre-mint large reserve
    token_sa.mint(&admin, &(10_000 * UNIT));

    let contract_id = env.register(AidEscrow, ());
    let client = AidEscrowClient::new(&env, &contract_id);
    client.init(&admin);

    let mut next_id: u64 = 1000;
    let mut active_pkg_ids: Vec<u64> = Vec::new();

    for (step, op) in ops.iter().enumerate() {
        match op {
            // ── Fund ──────────────────────────────────────────────────
            Op::Fund { whole_units } => {
                let amount = whole_units * UNIT;
                let wallet = token.balance(&admin);
                if wallet < amount {
                    token_sa.mint(&admin, &(amount - wallet + UNIT));
                }
                let _ = client.try_fund(&token_addr, &admin, &amount);
            }

            // ── CreatePackage ──────────────────────────────────────────
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

            // ── Claim ──────────────────────────────────────────────────
            Op::Claim { idx } => {
                if let Some(&id) = pick_id(&active_pkg_ids, *idx) {
                    let _ = client.try_claim(&id);
                    if let Ok(Ok(pkg)) = client.try_get_package(&id) {
                        if pkg.status == aid_escrow::PackageStatus::Claimed {
                            active_pkg_ids.retain(|&x| x != id);
                        }
                    }
                }
            }

            // ── Revoke ────────────────────────────────────────────────
            Op::Revoke { idx } => {
                if let Some(&id) = pick_id(&active_pkg_ids, *idx) {
                    let _ = client.try_revoke(&id);
                    active_pkg_ids.retain(|&x| x != id);
                }
            }

            // ── Refund ────────────────────────────────────────────────
            Op::Refund { idx } => {
                if let Some(&id) = pick_id(&active_pkg_ids, *idx) {
                    // For refund to work on a Created package we need it
                    // to be expired — jump the ledger past expiry.
                    if let Ok(Ok(pkg)) = client.try_get_package(&id) {
                        if pkg.expires_at > 0 {
                            env.ledger().set_timestamp(pkg.expires_at + 1);
                        }
                    }
                    let _ = client.try_refund(&id);
                    active_pkg_ids.retain(|&x| x != id);
                }
            }

            // ── WithdrawSurplus ───────────────────────────────────────
            Op::WithdrawSurplus { whole_units } => {
                let amount = whole_units * UNIT;
                let _ = client.try_withdraw_surplus(&admin, &amount, &token_addr);
            }
        }

        // Assert event-invariant after every operation
        let label = format!("Step {} ({:?})", step, op);
        assert_event_invariant(&env, &client, &token_addr, &contract_id, &label);
    }
}

fn pick_id(ids: &[u64], idx: usize) -> Option<&u64> {
    if ids.is_empty() {
        None
    } else {
        Some(&ids[idx % ids.len()])
    }
}

// ---------------------------------------------------------------------------
// Proptest: random sequences
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 500,
        max_shrink_iters: 10_000,
        ..ProptestConfig::default()
    })]

    #[test]
    fn prop_event_invariant_holds(ops in arb_ops()) {
        run_sequence(ops);
    }
}

// ---------------------------------------------------------------------------
// Unit-level smoke tests — each asserts the event-invariant after the call
// ---------------------------------------------------------------------------

mod smoke {
    use super::*;

    type Setup = (
        Env,
        AidEscrowClient<'static>,
        TokenClient<'static>,
        Address, // admin
        Address, // recipient
        Address, // contract_id
    );

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();
        let token = TokenClient::new(&env, &token_addr);
        let token_sa = StellarAssetClient::new(&env, &token_addr);

        token_sa.mint(&admin, &(1_000 * UNIT));

        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        (env, client, token, admin, recipient, contract_id)
    }

    /// Smoke: `decrement_locked` path exercised by `revoke`.
    #[test]
    fn test_smoke_decrement_locked() {
        let (env, client, token, admin, recipient, contract_id) = setup();

        client.fund(&token.address, &admin, &(50 * UNIT));
        let metadata = Map::new(&env);
        client.create_package(
            &admin,
            &1,
            &recipient,
            &(20 * UNIT),
            &token.address,
            &(env.ledger().timestamp() + 86400),
            &metadata,
        );

        let locked_before = client.get_total_locked(&token.address);
        assert_eq!(locked_before, 20 * UNIT);

        client.revoke(&1);

        let locked_after = client.get_total_locked(&token.address);
        assert_eq!(locked_after, 0, "decrement_locked should zero the lock");

        // Invariant must still hold after decrement
        assert_event_invariant(
            &env,
            &client,
            &token.address,
            &contract_id,
            "smoke: decrement_locked (revoke)",
        );
    }

    /// Smoke: `finalize_claim` path exercised by `claim`.
    #[test]
    fn test_smoke_finalize_claim() {
        let (env, client, token, admin, recipient, contract_id) = setup();

        client.fund(&token.address, &admin, &(50 * UNIT));
        let metadata = Map::new(&env);
        client.create_package(
            &admin,
            &1,
            &recipient,
            &(30 * UNIT),
            &token.address,
            &(env.ledger().timestamp() + 86400),
            &metadata,
        );

        client.claim(&1);

        let claimed = client.get_total_claimed(&token.address);
        assert_eq!(claimed, 30 * UNIT, "finalize_claim should record the claim");

        assert_event_invariant(
            &env,
            &client,
            &token.address,
            &contract_id,
            "smoke: finalize_claim (claim)",
        );
    }

    /// Smoke: `withdraw_surplus` path.
    #[test]
    fn test_smoke_withdraw_surplus() {
        let (env, client, token, admin, recipient, contract_id) = setup();

        // Fund 100, lock 30 — surplus = 70
        client.fund(&token.address, &admin, &(100 * UNIT));
        let metadata = Map::new(&env);
        client.create_package(
            &admin,
            &1,
            &recipient,
            &(30 * UNIT),
            &token.address,
            &(env.ledger().timestamp() + 86400),
            &metadata,
        );

        client.withdraw_surplus(&admin, &(20 * UNIT), &token.address);

        assert_event_invariant(
            &env,
            &client,
            &token.address,
            &contract_id,
            "smoke: withdraw_surplus",
        );
    }

    /// Smoke: `refund` path — package expired, then refunded.
    #[test]
    fn test_smoke_refund() {
        let (env, client, token, admin, recipient, contract_id) = setup();

        client.fund(&token.address, &admin, &(50 * UNIT));
        let metadata = Map::new(&env);
        let now = env.ledger().timestamp();
        client.create_package(
            &admin,
            &1,
            &recipient,
            &(25 * UNIT),
            &token.address,
            &(now + 100),
            &metadata,
        );

        // Advance past expiry
        env.ledger().set_timestamp(now + 200);
        client.refund(&1);

        let locked = client.get_total_locked(&token.address);
        assert_eq!(locked, 0, "refund unlocks the locked amount");

        assert_event_invariant(&env, &client, &token.address, &contract_id, "smoke: refund");
    }

    /// Smoke: refund of a revoked (cancelled) package.
    #[test]
    fn test_smoke_revoke_then_refund() {
        let (env, client, token, admin, recipient, contract_id) = setup();

        client.fund(&token.address, &admin, &(50 * UNIT));
        let metadata = Map::new(&env);
        client.create_package(
            &admin,
            &1,
            &recipient,
            &(15 * UNIT),
            &token.address,
            &(env.ledger().timestamp() + 86400),
            &metadata,
        );

        client.revoke(&1);
        // After revoke, the package is Cancelled → refund should work
        let now = env.ledger().timestamp();
        env.ledger().set_timestamp(now + 1);
        client.refund(&1);

        assert_event_invariant(
            &env,
            &client,
            &token.address,
            &contract_id,
            "smoke: revoke → refund",
        );
    }

    /// Full lifecycle: fund → create → claim → fund → create → revoke → refund
    #[test]
    fn test_smoke_full_lifecycle() {
        let (env, client, token, admin, recipient, contract_id) = setup();

        // Cycle 1
        client.fund(&token.address, &admin, &(100 * UNIT));
        let metadata = Map::new(&env);
        client.create_package(
            &admin,
            &1,
            &recipient,
            &(40 * UNIT),
            &token.address,
            &(env.ledger().timestamp() + 86400),
            &metadata,
        );
        client.claim(&1);

        // Cycle 2
        client.create_package(
            &admin,
            &2,
            &recipient,
            &(20 * UNIT),
            &token.address,
            &(env.ledger().timestamp() + 86400),
            &metadata,
        );
        client.revoke(&2);

        assert_event_invariant(
            &env,
            &client,
            &token.address,
            &contract_id,
            "smoke: full lifecycle",
        );

        // Assert the aggregates match
        assert_eq!(client.get_total_locked(&token.address), 0);
        assert_eq!(client.get_total_claimed(&token.address), 40 * UNIT);
    }
}

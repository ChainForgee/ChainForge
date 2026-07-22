//! Invariant test: conservation of value via event-stream replay.
//!
//! Reconstructs "total funded" by summing `EscrowFunded` events and asserts
//! the conservation invariant after random sequences of operations.
//!
//! Because `env.events().all()` only returns events from the most recent
//! transaction, we mirror state locally during the sequence and assert the
//! invariant after every step.  The final step additionally cross-checks
//! the event stream from the last transaction.
//!
//! ```bash
//! cargo test --test invariants -- --nocapture
//! ```

#![cfg(test)]

use aid_escrow::{AidEscrow, AidEscrowClient};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Map, Symbol, TryFromVal, Val,
};

const UNIT: i128 = 10_000_000;
const MAX_UNITS_PER_PKG: i128 = 100;
const MAX_PACKAGES: usize = 20;

// ---------------------------------------------------------------------------
// Operations the fuzzer can apply
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Op {
    Fund { whole_units: i128 },
    CreatePackage { whole_units: i128 },
    Claim { idx: usize },
    Disburse { idx: usize },
    Revoke { idx: usize },
    Refund { idx: usize },
    WithdrawSurplus { whole_units: i128 },
}

fn arb_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (1i128..=50i128).prop_map(|u| Op::Fund { whole_units: u }),
        (1i128..=MAX_UNITS_PER_PKG).prop_map(|u| Op::CreatePackage { whole_units: u }),
        any::<usize>().prop_map(|i| Op::Claim { idx: i }),
        any::<usize>().prop_map(|i| Op::Disburse { idx: i }),
        any::<usize>().prop_map(|i| Op::Revoke { idx: i }),
        any::<usize>().prop_map(|i| Op::Refund { idx: i }),
        (1i128..=20i128).prop_map(|u| Op::WithdrawSurplus { whole_units: u }),
    ]
}

fn arb_ops() -> impl Strategy<Value = std::vec::Vec<Op>> {
    prop::collection::vec(arb_op(), 1..=MAX_PACKAGES)
}

// ---------------------------------------------------------------------------
// Event helpers (mirrored from tests/events.rs)
// ---------------------------------------------------------------------------

fn sym(env: &Env, s: &str) -> Symbol {
    Symbol::new(env, s)
}

fn topic_matches(env: &Env, topics: &soroban_sdk::Vec<Val>, expected: &str) -> bool {
    let exp = sym(env, expected);
    for t in topics.iter() {
        if let Ok(s) = Symbol::try_from_val(env, &t) {
            if s == exp {
                return true;
            }
        }
    }
    false
}

fn data_i128(env: &Env, data: &Val, field: &str) -> i128 {
    let map = soroban_sdk::Map::<Symbol, Val>::try_from_val(env, data).unwrap();
    let val = map.get(sym(env, field)).expect("missing field");
    i128::try_from_val(env, &val).expect("not i128")
}

fn latest_event_amount(env: &Env, contract_id: &Address, topic: &str) -> Option<i128> {
    let events: std::vec::Vec<_> = env.events().all().into_iter().collect();
    for (id, topics, data) in events.iter().rev() {
        if id == contract_id && topic_matches(env, topics, topic) {
            return Some(data_i128(env, data, "amount"));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Invariant assertion
//
// Σ funded == balance + Σ claimed + Σ disbursed + Σ refunded + Σ surplus
//
// This is the conservation-of-value invariant.  Every token that entered
// the contract via `fund()` must either still be in the contract or have
// left via one of the four tracked exit paths.
// ---------------------------------------------------------------------------

fn assert_invariants(
    env: &Env,
    client: &AidEscrowClient,
    contract_id: &Address,
    token_addr: &Address,
    mirror_funded: i128,
    mirror_withdrawn: i128,
) {
    let balance = TokenClient::new(env, token_addr).balance(contract_id);
    let locked = client.get_total_locked(token_addr);
    let claimed = client.get_total_claimed(token_addr);

    // Solvency
    assert!(
        balance >= locked,
        "INVARIANT VIOLATED: contract not solvent \
         (balance={balance}, locked={locked})"
    );

    // Non-negativity
    assert!(locked >= 0, "total_locked is negative: {locked}");
    assert!(claimed >= 0, "total_claimed is negative: {claimed}");

    // Conservation of value: mirror_funded == balance + mirror_withdrawn
    assert_eq!(
        mirror_funded,
        balance + mirror_withdrawn,
        "INVARIANT VIOLATED: conservation of value\n  \
         mirror_funded={mf}, balance={bal}, mirror_withdrawn={mw}\n  \
         on_chain_locked={lk}, on_chain_claimed={ck}",
        mf = mirror_funded,
        bal = balance,
        mw = mirror_withdrawn,
        lk = locked,
        ck = claimed,
    );
}

// ---------------------------------------------------------------------------
// Sequence runner
// ---------------------------------------------------------------------------

fn run_sequence(ops: std::vec::Vec<Op>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = token_contract.address();
    let tkn = TokenClient::new(&env, &token_addr);
    let token_sa = StellarAssetClient::new(&env, &token_addr);

    let reserve: i128 = 10_000 * UNIT;
    token_sa.mint(&admin, &reserve);

    let contract_id = env.register(AidEscrow, ());
    let client = AidEscrowClient::new(&env, &contract_id);
    client.init(&admin);

    // Bookkeeping mirrors
    let mut mirror_funded: i128 = 0;
    let mut mirror_withdrawn: i128 = 0;
    let mut active: std::vec::Vec<(u64, i128)> = std::vec::Vec::new(); // (id, amount)
    let mut next_id: u64 = 1_000;

    for op in ops {
        match op {
            Op::Fund { whole_units } => {
                let amount = whole_units * UNIT;
                let bal = tkn.balance(&admin);
                if bal < amount {
                    token_sa.mint(&admin, &(amount - bal + UNIT));
                }
                if client.try_fund(&token_addr, &admin, &amount).is_ok() {
                    mirror_funded += amount;
                }
            }

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
                    active.push((id, amount));
                }
            }

            Op::Claim { idx } => {
                if !active.is_empty() {
                    let pos = idx % active.len();
                    let (id, amount) = active[pos];
                    if client.try_claim(&id).is_ok() {
                        mirror_withdrawn += amount;
                        active.remove(pos);
                    }
                }
            }

            Op::Disburse { idx } => {
                if !active.is_empty() {
                    let pos = idx % active.len();
                    let (id, amount) = active[pos];
                    if client.try_disburse(&id).is_ok() {
                        mirror_withdrawn += amount;
                        active.remove(pos);
                    }
                }
            }

            Op::Revoke { idx } => {
                if !active.is_empty() {
                    let pos = idx % active.len();
                    let (id, _amount) = active[pos];
                    if client.try_revoke(&id).is_ok() {
                        // Revoke unlocks funds but does NOT transfer — no mirror change
                        active.remove(pos);
                    }
                }
            }

            Op::Refund { idx } => {
                if !active.is_empty() {
                    let pos = idx % active.len();
                    let (id, amount) = active[pos];
                    if client.try_refund(&id).is_ok() {
                        mirror_withdrawn += amount;
                        active.remove(pos);
                    }
                }
            }

            Op::WithdrawSurplus { whole_units } => {
                let amount = whole_units * UNIT;
                if client
                    .try_withdraw_surplus(&admin, &amount, &token_addr)
                    .is_ok()
                {
                    mirror_withdrawn += amount;
                }
            }
        }

        // Assert invariant after every operation
        assert_invariants(
            &env,
            &client,
            &contract_id,
            &token_addr,
            mirror_funded,
            mirror_withdrawn,
        );
    }

    // ── Post-hoc event-stream cross-check ──────────────────
    //
    // env.events().all() only returns events from the LAST transaction.
    // We can still verify that the last transaction's events are consistent
    // with the mirror state.
    if let Some(last_amount) = latest_event_amount(&env, &contract_id, "escrow_funded") {
        // The last fund amount must be ≤ mirror_funded
        assert!(
            last_amount <= mirror_funded,
            "Last EscrowFunded amount ({last_amount}) > mirror_funded ({mirror_funded})"
        );
    }
}

// ---------------------------------------------------------------------------
// Property: conservation via event replay (100 random sequences)
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 100,
        max_shrink_iters: 10_000,
        ..ProptestConfig::default()
    })]

    #[test]
    fn prop_event_replay_conservation(ops in arb_ops()) {
        run_sequence(ops);
    }
}

// ---------------------------------------------------------------------------
// Smoke tests: invariant asserted at each bookkeeping call
// ---------------------------------------------------------------------------

fn setup() -> (
    Env,
    AidEscrowClient<'static>,
    TokenClient<'static>,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let tc = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = tc.address();
    let tkn = TokenClient::new(&env, &token_addr);
    let sa = StellarAssetClient::new(&env, &token_addr);
    sa.mint(&admin, &(100 * UNIT));

    let cid = env.register(AidEscrow, ());
    let client = AidEscrowClient::new(&env, &cid);
    client.init(&admin);

    (env, client, tkn, admin, recipient, token_addr)
}

#[test]
fn smoke_fund() {
    let (env, client, _tkn, admin, _recip, token_addr) = setup();

    client.fund(&token_addr, &admin, &(5 * UNIT));
    assert_invariants(&env, &client, &client.address, &token_addr, 5 * UNIT, 0);
}

#[test]
fn smoke_create_increases_locked() {
    let (env, client, _tkn, admin, recipient, token_addr) = setup();

    client.fund(&token_addr, &admin, &(10 * UNIT));
    let before = client.get_total_locked(&token_addr);

    client.create_package(
        &admin,
        &1,
        &recipient,
        &(3 * UNIT),
        &token_addr,
        &0,
        &Map::new(&env),
    );

    assert_eq!(client.get_total_locked(&token_addr), before + 3 * UNIT);
    assert_invariants(&env, &client, &client.address, &token_addr, 10 * UNIT, 0);
}

#[test]
fn smoke_claim_moves_locked_to_claimed() {
    let (env, client, tkn, admin, recipient, token_addr) = setup();

    client.fund(&token_addr, &admin, &(10 * UNIT));
    client.create_package(
        &admin,
        &1,
        &recipient,
        &(4 * UNIT),
        &token_addr,
        &0,
        &Map::new(&env),
    );

    let before_locked = client.get_total_locked(&token_addr);
    let before_claimed = client.get_total_claimed(&token_addr);

    client.claim(&1);

    assert_eq!(
        client.get_total_locked(&token_addr),
        before_locked - 4 * UNIT
    );
    assert_eq!(
        client.get_total_claimed(&token_addr),
        before_claimed + 4 * UNIT
    );
    assert_eq!(tkn.balance(&recipient), 4 * UNIT);
    assert_invariants(
        &env,
        &client,
        &client.address,
        &token_addr,
        10 * UNIT,
        4 * UNIT,
    );
}

#[test]
fn smoke_disburse_transfers_to_recipient() {
    let (env, client, tkn, admin, recipient, token_addr) = setup();

    client.fund(&token_addr, &admin, &(10 * UNIT));
    client.create_package(
        &admin,
        &1,
        &recipient,
        &(5 * UNIT),
        &token_addr,
        &0,
        &Map::new(&env),
    );

    let before_locked = client.get_total_locked(&token_addr);
    client.disburse(&1);

    assert_eq!(
        client.get_total_locked(&token_addr),
        before_locked - 5 * UNIT
    );
    assert_eq!(tkn.balance(&recipient), 5 * UNIT);
    assert_invariants(
        &env,
        &client,
        &client.address,
        &token_addr,
        10 * UNIT,
        5 * UNIT,
    );
}

#[test]
fn smoke_revoke_unlocks_without_transfer() {
    let (env, client, tkn, admin, recipient, token_addr) = setup();

    client.fund(&token_addr, &admin, &(10 * UNIT));
    client.create_package(
        &admin,
        &1,
        &recipient,
        &(6 * UNIT),
        &token_addr,
        &0,
        &Map::new(&env),
    );

    let before_locked = client.get_total_locked(&token_addr);
    client.revoke(&1);

    assert_eq!(
        client.get_total_locked(&token_addr),
        before_locked - 6 * UNIT
    );
    assert_eq!(tkn.balance(&recipient), 0);
    assert_invariants(&env, &client, &client.address, &token_addr, 10 * UNIT, 0);
}

#[test]
fn smoke_refund_transfers_back_to_admin() {
    let (env, client, tkn, admin, recipient, token_addr) = setup();

    client.fund(&token_addr, &admin, &(10 * UNIT));

    let start = 1000u64;
    env.ledger().set_timestamp(start);
    let expiry = start + 100;
    client.create_package(
        &admin,
        &1,
        &recipient,
        &(7 * UNIT),
        &token_addr,
        &expiry,
        &Map::new(&env),
    );

    env.ledger().set_timestamp(expiry + 1);

    let admin_before = tkn.balance(&admin);
    client.refund(&1);

    assert_eq!(tkn.balance(&admin), admin_before + 7 * UNIT);
    assert_invariants(
        &env,
        &client,
        &client.address,
        &token_addr,
        10 * UNIT,
        7 * UNIT,
    );
}

#[test]
fn smoke_withdraw_surplus() {
    let (env, client, tkn, admin, _recip, token_addr) = setup();

    client.fund(&token_addr, &admin, &(10 * UNIT));

    let admin_before = tkn.balance(&admin);
    client.withdraw_surplus(&admin, &(7 * UNIT), &token_addr);

    assert_eq!(tkn.balance(&admin), admin_before + 7 * UNIT);
    assert_invariants(
        &env,
        &client,
        &client.address,
        &token_addr,
        10 * UNIT,
        7 * UNIT,
    );
}

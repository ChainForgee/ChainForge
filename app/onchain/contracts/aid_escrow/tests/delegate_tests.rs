#![cfg(test)]

//! Integration tests for the delegate / recovery claim path (issue #422).
//!
//! Coverage maps to the issue's acceptance criteria:
//! - a registered, unexpired delegate can authorise a claim and the package
//!   transitions to `Claimed` exactly once
//! - a delegate cannot claim an expired package, a `Claimed` package, or a
//!   package after the delegate's own `expires_at`
//! - `set_delegate` is rejected for `Claimed` packages and when the delegate
//!   equals the recipient
//! - history/audit records are readable via `get_delegate_history`

use aid_escrow::{AidEscrow, AidEscrowClient, DelegateHistory, Error, PackageStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Map, Vec,
};

// Standard Stellar Asset decimals is 7. The contract requires whole-token
// amounts (multiples of 10^7).
const UNIT: i128 = 10_000_000;

const START_TIME: u64 = 1000;

struct TestCtx {
    env: Env,
    client: AidEscrowClient<'static>,
    token: Address,
    admin: Address,
}

fn setup() -> TestCtx {
    let env = Env::default();
    env.ledger().set_timestamp(START_TIME);
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token_contract.address();
    let token_admin_client = StellarAssetClient::new(&env, &token);

    let contract_id = env.register(AidEscrow, ());
    let client = AidEscrowClient::new(&env, &contract_id);

    client.init(&admin);
    token_admin_client.mint(&admin, &(10 * UNIT));
    client.fund(&token, &admin, &(10 * UNIT));

    TestCtx {
        env,
        client,
        token,
        admin,
    }
}

impl TestCtx {
    fn create_package(&self, recipient: &Address) -> u64 {
        let id = 1u64;
        let res = self.client.create_package(
            &self.admin,
            &id,
            recipient,
            &UNIT,
            &self.token,
            &(START_TIME + 1000),
            &Map::new(&self.env),
        );
        assert_eq!(res, id);
        id
    }
}

#[test]
fn registered_unexpired_delegate_can_claim_on_behalf_of_recipient() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let delegate = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    // Delegate expires well after the package would, so any failure below is
    // attributable to the claim path, not delegate expiry.
    t.client.set_delegate(&id, &delegate, &(START_TIME + 500));
    assert_eq!(t.client.get_delegate(&id), Some(delegate.clone()));

    // The delegate authorises the claim; funds still pay out to the recipient.
    t.client.claim(&id, &delegate);

    let pkg = t.client.get_package(&id);
    assert_eq!(pkg.status, PackageStatus::Claimed);
    assert_eq!(TokenClient::new(&t.env, &t.token).balance(&recipient), UNIT);

    // The delegate is cleared on claim and the removal is audited.
    assert_eq!(t.client.get_delegate(&id), None);
    let history: Vec<DelegateHistory> = t.client.get_delegate_history(&id);
    assert_eq!(history.len(), 2);
    assert_eq!(history.get(0).unwrap().new_delegate, Some(delegate.clone()));
    assert_eq!(
        history.get(0).unwrap().reason,
        soroban_sdk::String::from_str(&t.env, "Admin delegate assignment")
    );
    assert_eq!(history.get(1).unwrap().new_delegate, None);
    assert_eq!(history.get(1).unwrap().changed_by, delegate);
    assert_eq!(
        history.get(1).unwrap().reason,
        soroban_sdk::String::from_str(&t.env, "Delegate cleared after claim")
    );
}

#[test]
fn recipient_can_still_claim_without_a_delegate() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    assert_eq!(t.client.get_delegate(&id), None);
    t.client.claim(&id, &recipient);

    assert_eq!(t.client.get_package(&id).status, PackageStatus::Claimed);
    // No delegate was ever set, so no audit records were written.
    assert_eq!(t.client.get_delegate_history(&id).len(), 0);
}

#[test]
fn package_transitions_to_claimed_exactly_once() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let delegate = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    t.client.set_delegate(&id, &delegate, &0);
    t.client.claim(&id, &delegate);

    // A second claim — by the recipient or the delegate — must fail.
    let by_recipient = t.client.try_claim(&id, &recipient);
    assert_eq!(by_recipient, Err(Ok(Error::PackageNotActive)));
    let by_delegate = t.client.try_claim(&id, &delegate);
    assert_eq!(by_delegate, Err(Ok(Error::PackageNotActive)));
}

#[test]
fn delegate_cannot_claim_an_expired_package() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let delegate = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    // Package expires at START_TIME + 1000; delegate lasts longer.
    t.client.set_delegate(&id, &delegate, &(START_TIME + 5000));
    t.env.ledger().set_timestamp(START_TIME + 1001);

    let res = t.client.try_claim(&id, &delegate);
    assert_eq!(res, Err(Ok(Error::PackageExpired)));
    assert_eq!(t.client.get_package(&id).status, PackageStatus::Created);
}

#[test]
fn delegate_cannot_claim_after_own_expiry() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let delegate = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    // Delegate expires at START_TIME + 500, before the package does.
    t.client.set_delegate(&id, &delegate, &(START_TIME + 500));

    // Still authorised before the delegate deadline.
    t.env.ledger().set_timestamp(START_TIME + 499);
    assert_eq!(t.client.get_delegate(&id), Some(delegate.clone()));

    // After the delegate deadline the stored delegate is treated as absent.
    t.env.ledger().set_timestamp(START_TIME + 501);
    assert_eq!(t.client.get_delegate(&id), None);
    let res = t.client.try_claim(&id, &delegate);
    assert_eq!(res, Err(Ok(Error::NotAuthorized)));
}

#[test]
fn delegate_cannot_claim_after_recipient_already_claimed() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let delegate = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    t.client.set_delegate(&id, &delegate, &0);
    t.client.claim(&id, &recipient);

    let res = t.client.try_claim(&id, &delegate);
    assert_eq!(res, Err(Ok(Error::PackageNotActive)));
}

#[test]
fn stranger_cannot_claim() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let stranger = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    let res = t.client.try_claim(&id, &stranger);
    assert_eq!(res, Err(Ok(Error::NotAuthorized)));
}

#[test]
fn set_delegate_is_rejected_for_claimed_packages() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let delegate = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    t.client.claim(&id, &recipient);

    let res = t.client.try_set_delegate(&id, &delegate, &0);
    assert_eq!(res, Err(Ok(Error::PackageNotActive)));
}

#[test]
fn set_delegate_is_rejected_when_delegate_equals_recipient() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    let res = t.client.try_set_delegate(&id, &recipient, &0);
    assert_eq!(res, Err(Ok(Error::InvalidState)));
    assert_eq!(t.client.get_delegate(&id), None);
}

#[test]
fn set_delegate_is_rejected_for_missing_package() {
    let t = setup();
    let delegate = Address::generate(&t.env);

    let res = t.client.try_set_delegate(&9999, &delegate, &0);
    assert_eq!(res, Err(Ok(Error::PackageNotFound)));
}

#[test]
fn set_delegate_rejects_expiry_in_the_past() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let delegate = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    let res = t.client.try_set_delegate(&id, &delegate, &(START_TIME - 1));
    assert_eq!(res, Err(Ok(Error::InvalidState)));
    assert_eq!(t.client.get_delegate(&id), None);
}

#[test]
fn set_delegate_replaces_previous_and_audits_both_assignments() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let delegate1 = Address::generate(&t.env);
    let delegate2 = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    t.client.set_delegate(&id, &delegate1, &0);
    t.client.set_delegate(&id, &delegate2, &0);

    assert_eq!(t.client.get_delegate(&id), Some(delegate2.clone()));
    assert_eq!(
        t.client.get_delegate_info(&id),
        Some((delegate2.clone(), None))
    );

    let history = t.client.get_delegate_history(&id);
    assert_eq!(history.len(), 2);
    assert_eq!(history.get(0).unwrap().previous_delegate, None);
    assert_eq!(
        history.get(0).unwrap().new_delegate,
        Some(delegate1.clone())
    );
    assert_eq!(
        history.get(1).unwrap().previous_delegate,
        Some(delegate1.clone())
    );
    assert_eq!(history.get(1).unwrap().new_delegate, Some(delegate2));
}

#[test]
fn re_setting_without_expiry_drops_the_old_deadline() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let delegate = Address::generate(&t.env);
    let id = t.create_package(&recipient);

    t.client.set_delegate(&id, &delegate, &(START_TIME + 500));
    // Re-set without an expiry: the old deadline must not linger.
    t.client.set_delegate(&id, &delegate, &0);

    t.env.ledger().set_timestamp(START_TIME + 600);
    assert_eq!(t.client.get_delegate(&id), Some(delegate.clone()));
    let res = t.client.try_claim(&id, &delegate);
    assert!(res.is_ok());
}

#[test]
fn cleanup_expired_delegates_removes_only_expired_entries() {
    let t = setup();
    let recipient = Address::generate(&t.env);
    let delegate1 = Address::generate(&t.env);
    let delegate2 = Address::generate(&t.env);
    let id1 = t.create_package(&recipient);
    let id2 = {
        let res = t.client.create_package(
            &t.admin,
            &2u64,
            &recipient,
            &UNIT,
            &t.token,
            &(START_TIME + 1000),
            &Map::new(&t.env),
        );
        assert_eq!(res, 2);
        2u64
    };

    t.client.set_delegate(&id1, &delegate1, &(START_TIME + 50));
    t.client
        .set_delegate(&id2, &delegate2, &(START_TIME + 5000));

    t.env.ledger().set_timestamp(START_TIME + 100);

    let cleaned = t.client.cleanup_expired_delegates();
    assert_eq!(cleaned, 1);
    assert_eq!(t.client.get_delegate(&id1), None);
    assert_eq!(t.client.get_delegate(&id2), Some(delegate2));
}

#![cfg(test)]

use aid_escrow::{AidEscrow, AidEscrowClient, Error};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

const SEVEN_DAYS: u64 = 7 * 24 * 60 * 60;

fn setup() -> (Env, AidEscrowClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AidEscrow, ());
    let client = AidEscrowClient::new(&env, &contract_id);
    (env, client)
}

#[test]
fn test_rotate_admin_sets_pending_admin() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.init(&admin);
    client.rotate_admin(&new_admin);

    assert_eq!(client.get_pending_admin(), Some(new_admin));
    assert_eq!(client.get_admin(), admin);
}

#[test]
fn test_accept_admin_completes_rotation() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.init(&admin);
    client.rotate_admin(&new_admin);
    client.accept_admin();

    assert_eq!(client.get_admin(), new_admin);
    assert_eq!(client.get_pending_admin(), None);
}

#[test]
fn test_old_admin_cannot_pause_after_rotation() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.init(&admin);
    client.rotate_admin(&new_admin);
    client.accept_admin();

    env.set_auths(&[]);
    let result = client.try_pause();
    assert!(result.is_err());
}

#[test]
fn test_pending_admin_no_power_until_accept() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.init(&admin);
    client.rotate_admin(&new_admin);

    env.set_auths(&[]);
    let result = client.try_pause();
    assert!(result.is_err());
}

#[test]
fn test_rotate_admin_requires_current_admin_auth() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.init(&admin);

    env.set_auths(&[]);
    let result = client.try_rotate_admin(&new_admin);
    assert!(result.is_err());
}

#[test]
fn test_accept_admin_requires_pending_admin_auth() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.init(&admin);
    client.rotate_admin(&new_admin);

    env.set_auths(&[]);
    let result = client.try_accept_admin();
    assert!(result.is_err());
}

#[test]
fn test_accept_admin_fails_without_pending() {
    let (env, client) = setup();
    let admin = Address::generate(&env);

    client.init(&admin);

    let result = client.try_accept_admin();
    assert_eq!(result, Err(Ok(Error::NoPendingAdmin)));
}

#[test]
fn test_accept_admin_fails_after_deadline() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.init(&admin);
    client.rotate_admin(&new_admin);

    env.ledger().with_mut(|ledger| {
        ledger.timestamp = ledger.timestamp + SEVEN_DAYS + 1;
    });

    let result = client.try_accept_admin();
    assert_eq!(result, Err(Ok(Error::AdminRotationExpired)));
}

#[test]
fn test_rotate_admin_allows_new_admin_to_pause() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.init(&admin);
    client.rotate_admin(&new_admin);
    client.accept_admin();

    client.pause();
    assert!(client.is_paused());
}

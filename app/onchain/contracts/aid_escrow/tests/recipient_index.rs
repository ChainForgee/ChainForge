#![cfg(test)]

//! Tests for the recipient secondary index (issue #424).
//!
//! Covers:
//! - `get_recipient_package_count` being O(1) and independent of the global
//!   package counter (large ID gaps never inflate the count).
//! - `list_recipient_packages` returning every matching package across cursor
//!   pages with a continuation cursor, with no empty pages while matches remain.
//! - `limit` being clamped to `MAX_RECIPIENT_PAGE_SIZE`.
//! - Index maintenance on both `create_package` and `batch_create_packages`.

use aid_escrow::{AidEscrow, AidEscrowClient, MAX_RECIPIENT_PAGE_SIZE};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, Map, Symbol, Vec,
};

const UNIT: i128 = 10_000_000; // 1.0 Token (7 decimals)

fn setup_token(env: &Env, admin: &Address) -> (TokenClient<'static>, StellarAssetClient<'static>) {
    let token_contract = env.register_stellar_asset_contract_v2(admin.clone());
    let token_client = TokenClient::new(env, &token_contract.address());
    let token_admin_client = StellarAssetClient::new(env, &token_contract.address());
    (token_client, token_admin_client)
}

struct Harness {
    env: Env,
    client: AidEscrowClient<'static>,
    admin: Address,
    token: Address,
}

impl Harness {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let admin = Address::generate(&env);
        let client = AidEscrowClient::new(&env, &env.register(AidEscrow, ()));
        client.init(&admin);

        let (token_client, token_admin_client) = setup_token(&env, &Address::generate(&env));
        token_admin_client.mint(&admin, &(1_000_000 * UNIT));
        client.fund(&token_client.address, &admin, &(1_000_000 * UNIT));

        Harness {
            env,
            client,
            admin,
            token: token_client.address,
        }
    }

    fn create(&self, id: u64, recipient: &Address) {
        self.client.create_package(
            &self.admin,
            &id,
            recipient,
            &UNIT,
            &self.token,
            &86_400,
            &Map::new(&self.env),
        );
    }
}

#[test]
fn count_is_independent_of_large_id_gaps() {
    let h = Harness::new();
    let recipient_a = Address::generate(&h.env);
    let recipient_b = Address::generate(&h.env);

    // Packages for A at low ids and for B at a very high id (sparse ID space).
    h.create(1, &recipient_a);
    h.create(2, &recipient_a);
    h.create(5000, &recipient_b);

    // Counts reflect only each recipient's own packages, never the counter.
    assert_eq!(h.client.get_recipient_package_count(&recipient_a), 2);
    assert_eq!(h.client.get_recipient_package_count(&recipient_b), 1);

    // Unknown recipients still read as zero.
    assert_eq!(
        h.client
            .get_recipient_package_count(&Address::generate(&h.env)),
        0
    );
}

#[test]
fn pagination_enumerates_every_match_across_sparse_ids() {
    let h = Harness::new();
    let recipient_a = Address::generate(&h.env);
    let recipient_b = Address::generate(&h.env);

    h.create(2, &recipient_a);
    h.create(200, &recipient_a);
    h.create(50, &recipient_b);

    // Page 1: seq 0 -> package 2.
    let page1 = h.client.list_recipient_packages(&recipient_a, &0, &1);
    assert_eq!(page1.ids.len(), 1);
    assert_eq!(page1.ids.get(0).unwrap(), 2);
    assert_eq!(page1.next_cursor, 1);

    // Page 2: seq 1 -> package 200. No empty pages in between, even though
    // the ID gap between 2 and 200 is huge.
    let page2 = h
        .client
        .list_recipient_packages(&recipient_a, &page1.next_cursor, &1);
    assert_eq!(page2.ids.get(0).unwrap(), 200);
    assert_eq!(page2.next_cursor, 2);

    // Exhausted: empty page, next_cursor pins at the count.
    let page3 = h
        .client
        .list_recipient_packages(&recipient_a, &page2.next_cursor, &1);
    assert_eq!(page3.ids.len(), 0);
    assert_eq!(page3.next_cursor, 2);

    // The other recipient's single package is still reachable.
    let b = h.client.list_recipient_packages(&recipient_b, &0, &10);
    assert_eq!(b.ids.get(0).unwrap(), 50);
}

#[test]
fn batch_creation_maintains_the_index() {
    let h = Harness::new();
    let recipient_a = Address::generate(&h.env);
    let recipient_b = Address::generate(&h.env);

    let recipients = vec![
        &h.env,
        recipient_a.clone(),
        recipient_b.clone(),
        recipient_a.clone(),
        recipient_a.clone(),
    ];
    let amounts = vec![&h.env, UNIT, UNIT, UNIT, UNIT];
    let empty = Map::<Symbol, soroban_sdk::String>::new(&h.env);
    let metadatas = vec![
        &h.env,
        empty.clone(),
        empty.clone(),
        empty.clone(),
        empty.clone(),
    ];

    let ids = h.client.batch_create_packages(
        &h.admin,
        &recipients,
        &amounts,
        &h.token,
        &86_400,
        &metadatas,
    );
    assert_eq!(ids.len(), 4);

    assert_eq!(h.client.get_recipient_package_count(&recipient_a), 3);
    assert_eq!(h.client.get_recipient_package_count(&recipient_b), 1);

    let a = h.client.list_recipient_packages(&recipient_a, &0, &10);
    assert_eq!(a.ids.len(), 3);
    assert_eq!(a.next_cursor, 3);
    // Batch ids are assigned consecutively from 0: A gets 0, 2, 3; B gets 1.
    assert_eq!(a.ids.get(0).unwrap(), 0);
    assert_eq!(a.ids.get(1).unwrap(), 2);
    assert_eq!(a.ids.get(2).unwrap(), 3);

    let b = h.client.list_recipient_packages(&recipient_b, &0, &10);
    assert_eq!(b.ids.len(), 1);
    assert_eq!(b.ids.get(0).unwrap(), 1);
}

#[test]
fn limit_is_clamped_to_max_page_size() {
    let h = Harness::new();
    let recipient = Address::generate(&h.env);

    // More packages than the documented page cap.
    let mut recipients = Vec::new(&h.env);
    let mut amounts = Vec::new(&h.env);
    let empty = Map::<Symbol, soroban_sdk::String>::new(&h.env);
    let mut metadatas = Vec::new(&h.env);
    for _ in 0..(MAX_RECIPIENT_PAGE_SIZE as usize + 5) {
        recipients.push_back(recipient.clone());
        amounts.push_back(UNIT);
        metadatas.push_back(empty.clone());
    }
    h.client.batch_create_packages(
        &h.admin,
        &recipients,
        &amounts,
        &h.token,
        &86_400,
        &metadatas,
    );

    // A huge requested limit is clamped to the documented maximum.
    let page = h.client.list_recipient_packages(&recipient, &0, &u32::MAX);
    assert_eq!(page.ids.len(), MAX_RECIPIENT_PAGE_SIZE);
    assert_eq!(page.next_cursor, MAX_RECIPIENT_PAGE_SIZE as u64);

    // The remainder is reachable on the next page.
    let rest = h
        .client
        .list_recipient_packages(&recipient, &page.next_cursor, &u32::MAX);
    assert_eq!(rest.ids.len(), 5);
    assert_eq!(rest.next_cursor, MAX_RECIPIENT_PAGE_SIZE as u64 + 5);
}

#[test]
fn individual_and_batch_ids_share_one_index() {
    let h = Harness::new();
    let recipient = Address::generate(&h.env);

    h.create(7, &recipient);

    let recipients = vec![&h.env, recipient.clone(), recipient.clone()];
    let amounts = vec![&h.env, UNIT, UNIT];
    let empty = Map::<Symbol, soroban_sdk::String>::new(&h.env);
    let metadatas = vec![&h.env, empty.clone(), empty.clone()];
    h.client.batch_create_packages(
        &h.admin,
        &recipients,
        &amounts,
        &h.token,
        &86_400,
        &metadatas,
    );

    assert_eq!(h.client.get_recipient_package_count(&recipient), 3);

    // Full enumeration: the individual create (id 7) followed by the two
    // batch ids (8, 9, since the counter was at 8 after the individual create).
    let page = h.client.list_recipient_packages(&recipient, &0, &10);
    assert_eq!(page.ids.get(0).unwrap(), 7);
    assert_eq!(page.ids.get(1).unwrap(), 8);
    assert_eq!(page.ids.get(2).unwrap(), 9);
}

//! Delegate / recovery address support for aid packages.
//!
//! A package creator may register an optional delegate address for the
//! recipient.  Either the primary recipient OR the delegate may authorise
//! a claim.  Once a package is claimed the delegate cannot be changed,
//! preventing reassignment after funds are disbursed.
//!
//! Enhanced features:
//! - Delegate expiration support
//! - Package status validation
//! - Audit trail for delegate changes
//! - Optimized storage operations
//! - Comprehensive error handling
//!
//! ## Storage layout
//!
//! Delegates live in a **parallel map** (keyed by package id), not inside the
//! `Package` record, so activating this module never changes the
//! persisted `Package` shape and existing packages remain readable without
//! a migration:
//!
//! - `(Persistent, "dlgts")`  → `Map<u64, Address>` — active delegate per package
//! - `(Persistent, "dlgexp")` → `Map<u64, u64>`    — delegate `expires_at` per package (0/absent = never)
//! - `(Persistent, "dlgh")`   → `Vec<DelegateHistory>` — append-only audit trail

use soroban_sdk::{contracttype, symbol_short, Address, Env, Map, String, Symbol, Vec};

use crate::{Error, Package, PackageStatus};

const KEY_DELEGATES: Symbol = symbol_short!("dlgts");
const KEY_DELEGATE_HISTORY: Symbol = symbol_short!("dlgh");
const KEY_DELEGATE_EXPIRY: Symbol = symbol_short!("dlgexp");

#[contracttype]
#[derive(Clone, Debug)]
pub struct DelegateHistory {
    pub package_id: u64,
    pub previous_delegate: Option<Address>,
    /// `Some(addr)` when a delegate was set; `None` when the delegate was
    /// removed (e.g. cleared after a successful claim).
    pub new_delegate: Option<Address>,
    pub changed_by: Address,
    pub changed_at: u64,
    pub reason: String,
}

/// Loads the full delegate map from persistent storage.
fn load_delegates(env: &Env) -> Map<u64, Address> {
    env.storage()
        .persistent()
        .get(&KEY_DELEGATES)
        .unwrap_or_else(|| Map::new(env))
}

/// Persists the delegate map.
fn save_delegates(env: &Env, map: &Map<u64, Address>) {
    env.storage().persistent().set(&KEY_DELEGATES, map);
}

/// Loads delegate expiry information.
fn load_delegate_expiry(env: &Env) -> Map<u64, u64> {
    env.storage()
        .persistent()
        .get(&KEY_DELEGATE_EXPIRY)
        .unwrap_or_else(|| Map::new(env))
}

/// Persists delegate expiry information.
fn save_delegate_expiry(env: &Env, map: &Map<u64, u64>) {
    env.storage().persistent().set(&KEY_DELEGATE_EXPIRY, map);
}

/// Loads delegate history for audit trail.
fn load_delegate_history(env: &Env) -> Vec<DelegateHistory> {
    env.storage()
        .persistent()
        .get(&KEY_DELEGATE_HISTORY)
        .unwrap_or_else(|| Vec::new(env))
}

/// Persists delegate history.
fn save_delegate_history(env: &Env, history: &Vec<DelegateHistory>) {
    env.storage()
        .persistent()
        .set(&KEY_DELEGATE_HISTORY, history);
}

/// Checks if a delegate has expired.
fn is_delegate_expired(env: &Env, package_id: u64) -> bool {
    let expiry_map = load_delegate_expiry(env);
    if let Some(expires_at) = expiry_map.get(package_id) {
        expires_at > 0 && env.ledger().timestamp() > expires_at
    } else {
        false
    }
}

/// Validates that a package exists and is in a valid state for delegate
/// operations.  A `Claimed` package is terminal: its funds have moved and a
/// delegate must never be (re)assigned after that point.
fn validate_package_state(env: &Env, package_id: u64) -> Result<(), Error> {
    let package_key = (symbol_short!("pkg"), package_id);
    if !env.storage().persistent().has(&package_key) {
        return Err(Error::PackageNotFound);
    }

    let package: Package = env.storage().persistent().get(&package_key).unwrap();

    if package.status == PackageStatus::Claimed {
        return Err(Error::PackageNotActive);
    }

    Ok(())
}

/// Records delegate change in history for audit trail.
fn record_delegate_change(
    env: &Env,
    package_id: u64,
    previous_delegate: Option<Address>,
    new_delegate: Option<Address>,
    changed_by: &Address,
    reason: &str,
) {
    let mut history = load_delegate_history(env);
    let record = DelegateHistory {
        package_id,
        previous_delegate,
        new_delegate,
        changed_by: changed_by.clone(),
        changed_at: env.ledger().timestamp(),
        reason: String::from_str(env, reason),
    };
    history.push_back(record);
    save_delegate_history(env, &history);
}

/// Register or update the delegate address for `package_id`.
///
/// Only callable by the contract admin (caller must already be auth-checked
/// by the outer contract function).  Fails if the package has already been
/// claimed (status must not be `Claimed`).
///
/// # Errors
/// - `Error::PackageNotFound` - Package doesn't exist
/// - `Error::PackageNotActive` - Package already claimed
/// - `Error::InvalidState` - Delegate cannot be set to recipient address
pub fn set_delegate(
    env: &Env,
    admin: &Address,
    package_id: u64,
    delegate: &Address,
) -> Result<(), Error> {
    // NOTE: `admin.require_auth()` is intentionally NOT repeated here —
    // callers (currently only `set_delegate_with_expiry`) must already have
    // performed it, and a second `require_auth` for the same address in the
    // same frame is rejected by the host (Error::Auth, ExistingValue).

    // Validate package state
    validate_package_state(env, package_id)?;

    // Get package to validate delegate is not the recipient
    let package_key = (symbol_short!("pkg"), package_id);
    let package: Package = env.storage().persistent().get(&package_key).unwrap();

    // Prevent setting delegate to the same address as recipient
    if delegate == &package.recipient {
        return Err(Error::InvalidState);
    }

    let mut map = load_delegates(env);
    let previous_delegate = map.get(package_id);

    map.set(package_id, delegate.clone());
    save_delegates(env, &map);

    // Record the change in history
    record_delegate_change(
        env,
        package_id,
        previous_delegate,
        Some(delegate.clone()),
        admin,
        "Admin delegate assignment",
    );

    Ok(())
}

/// Register or update the delegate address for `package_id` with expiration.
///
/// Enhanced version that supports delegate expiration.
///
/// # Arguments
/// - `env` - Contract environment
/// - `admin` - Admin address (must be authenticated)
/// - `package_id` - Package ID to set delegate for
/// - `delegate` - Delegate address
/// - `expires_at` - Optional expiration timestamp (0 = no expiration)
///
/// # Errors
/// - `Error::PackageNotFound` - Package doesn't exist
/// - `Error::PackageNotActive` - Package already claimed
/// - `Error::InvalidState` - Invalid delegate address or expiration
pub fn set_delegate_with_expiry(
    env: &Env,
    admin: &Address,
    package_id: u64,
    delegate: &Address,
    expires_at: u64,
) -> Result<(), Error> {
    admin.require_auth();

    // Validate expiration time
    if expires_at > 0 && expires_at <= env.ledger().timestamp() {
        return Err(Error::InvalidState);
    }

    // Set the delegate
    set_delegate(env, admin, package_id, delegate)?;

    // Set expiration if provided, otherwise drop any stale expiry from a
    // previous assignment (a delegate re-set without an expiry is valid
    // indefinitely and must not keep the old deadline).
    let mut expiry_map = load_delegate_expiry(env);
    if expires_at > 0 {
        expiry_map.set(package_id, expires_at);
    } else {
        expiry_map.remove(package_id);
    }
    save_delegate_expiry(env, &expiry_map);

    Ok(())
}

/// Returns the registered delegate for `package_id`, if any.
/// Returns None if no delegate is set or if the delegate has expired.
pub fn get_delegate(env: &Env, package_id: u64) -> Option<Address> {
    // Check if delegate exists
    let delegate = load_delegates(env).get(package_id)?;

    // Check if delegate has expired
    if is_delegate_expired(env, package_id) {
        return None;
    }

    Some(delegate)
}

/// Returns the delegate information including expiration.
pub fn get_delegate_info(env: &Env, package_id: u64) -> Option<(Address, Option<u64>)> {
    let delegate = load_delegates(env).get(package_id)?;
    let expiry_map = load_delegate_expiry(env);
    let expires_at = expiry_map.get(package_id);

    Some((delegate, expires_at))
}

/// Returns the delegate history for a package.
pub fn get_delegate_history(env: &Env, package_id: u64) -> Vec<DelegateHistory> {
    let all_history = load_delegate_history(env);
    let mut package_history = Vec::new(env);

    for record in all_history.iter() {
        if record.package_id == package_id {
            package_history.push_back(record.clone());
        }
    }

    package_history
}

/// Returns `true` when `claimer` is authorised to claim `package_id`.
///
/// Authorised means: claimer == primary_recipient OR claimer == delegate (and not expired).
pub fn is_authorised_claimer(
    env: &Env,
    package_id: u64,
    primary_recipient: &Address,
    claimer: &Address,
) -> bool {
    // Primary recipient is always authorized
    if claimer == primary_recipient {
        return true;
    }

    // Check delegate (includes expiration check)
    match get_delegate(env, package_id) {
        Some(delegate) => &delegate == claimer,
        None => false,
    }
}

/// Remove the delegate for `package_id` (call after a successful claim to
/// prevent any further reassignment).
pub fn clear_delegate(env: &Env, package_id: u64, changed_by: &Address) {
    let mut map = load_delegates(env);
    let previous_delegate = map.get(package_id);

    map.remove(package_id);
    save_delegates(env, &map);

    // Also clear expiration
    let mut expiry_map = load_delegate_expiry(env);
    expiry_map.remove(package_id);
    save_delegate_expiry(env, &expiry_map);

    // Record the removal in history if there was a delegate
    if let Some(delegate) = previous_delegate {
        record_delegate_change(
            env,
            package_id,
            Some(delegate),
            None,
            changed_by,
            "Delegate cleared after claim",
        );
    }
}

/// Cleanup expired delegates to reclaim storage.
/// This should be called periodically or as part of maintenance operations.
pub fn cleanup_expired_delegates(env: &Env, caller: &Address) -> Result<u32, Error> {
    caller.require_auth();

    let mut delegate_map = load_delegates(env);
    let mut expiry_map = load_delegate_expiry(env);
    let mut cleaned_count = 0u32;
    let now = env.ledger().timestamp();

    // Collect expired delegate IDs first to avoid modifying map during iteration
    let mut expired_ids = Vec::new(env);
    for (package_id, expires_at) in expiry_map.iter() {
        if expires_at > 0 && now > expires_at {
            expired_ids.push_back(package_id);
        }
    }

    // Remove expired delegates
    for package_id in expired_ids.iter() {
        delegate_map.remove(package_id);
        expiry_map.remove(package_id);
        cleaned_count += 1;
    }

    // Save changes
    save_delegates(env, &delegate_map);
    save_delegate_expiry(env, &expiry_map);

    Ok(cleaned_count)
}

#[cfg(test)]
mod tests {
    // `catch_unwind` lives in std; the crate itself is no_std.
    extern crate std;

    use super::*;
    use crate::AidEscrow;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::Env;

    /// Harness that deploys the real `AidEscrow` contract so these white-box
    /// tests can reach persistent storage through `env.as_contract` (the host
    /// rejects direct storage access outside a contract frame).
    struct Ctx {
        env: Env,
        contract_id: Address,
    }

    impl Ctx {
        fn new() -> Self {
            let env = Env::default();
            let contract_id = env.register(AidEscrow, ());
            Ctx { env, contract_id }
        }

        fn run<T>(&self, f: impl FnOnce() -> T) -> T {
            self.env.as_contract(&self.contract_id, f)
        }

        fn create_test_package(&self, package_id: u64, recipient: &Address, status: PackageStatus) {
            self.run(|| {
                let package = Package {
                    id: package_id,
                    recipient: recipient.clone(),
                    amount: 1000,
                    token: Address::generate(&self.env),
                    status,
                    created_at: self.env.ledger().timestamp(),
                    expires_at: 0,
                    claim_starts_at: self.env.ledger().timestamp(),
                    metadata: soroban_sdk::Map::new(&self.env),
                };
                self.env
                    .storage()
                    .persistent()
                    .set(&(symbol_short!("pkg"), package_id), &package);
            });
        }
    }

    #[test]
    fn no_delegate_means_only_recipient_is_authorised() {
        let ctx = Ctx::new();
        let recipient = Address::generate(&ctx.env);
        let stranger = Address::generate(&ctx.env);
        assert!(ctx.run(|| is_authorised_claimer(&ctx.env, 1, &recipient, &recipient)));
        assert!(!ctx.run(|| is_authorised_claimer(&ctx.env, 1, &recipient, &stranger)));
    }

    #[test]
    fn registered_delegate_can_claim() {
        let ctx = Ctx::new();
        let recipient = Address::generate(&ctx.env);
        let delegate = Address::generate(&ctx.env);
        let admin = Address::generate(&ctx.env);

        ctx.create_test_package(42, &recipient, PackageStatus::Created);
        ctx.env.mock_all_auths();
        ctx.run(|| set_delegate(&ctx.env, &admin, 42, &delegate).unwrap());

        assert!(ctx.run(|| is_authorised_claimer(&ctx.env, 42, &recipient, &delegate)));
    }

    #[test]
    fn cleared_delegate_cannot_claim() {
        let ctx = Ctx::new();
        let recipient = Address::generate(&ctx.env);
        let delegate = Address::generate(&ctx.env);
        let admin = Address::generate(&ctx.env);

        ctx.create_test_package(7, &recipient, PackageStatus::Created);
        ctx.env.mock_all_auths();
        ctx.run(|| set_delegate(&ctx.env, &admin, 7, &delegate).unwrap());
        ctx.run(|| clear_delegate(&ctx.env, 7, &admin));

        assert!(!ctx.run(|| is_authorised_claimer(&ctx.env, 7, &recipient, &delegate)));
    }

    #[test]
    fn delegate_expires_correctly() {
        let ctx = Ctx::new();
        let recipient = Address::generate(&ctx.env);
        let delegate = Address::generate(&ctx.env);
        let admin = Address::generate(&ctx.env);
        let now = 1000u64;

        ctx.env.ledger().set_timestamp(now);
        ctx.create_test_package(1, &recipient, PackageStatus::Created);

        ctx.env.mock_all_auths();
        ctx.run(|| set_delegate_with_expiry(&ctx.env, &admin, 1, &delegate, now + 100).unwrap());

        // Delegate should work before expiration
        assert!(ctx.run(|| is_authorised_claimer(&ctx.env, 1, &recipient, &delegate)));

        // Advance time past expiration
        ctx.env.ledger().set_timestamp(now + 200);

        // Delegate should not work after expiration
        assert!(!ctx.run(|| is_authorised_claimer(&ctx.env, 1, &recipient, &delegate)));

        // But get_delegate should return None
        assert_eq!(ctx.run(|| get_delegate(&ctx.env, 1)), None);
    }

    #[test]
    fn cannot_set_delegate_for_claimed_package() {
        let ctx = Ctx::new();
        let recipient = Address::generate(&ctx.env);
        let delegate = Address::generate(&ctx.env);
        let admin = Address::generate(&ctx.env);

        ctx.create_test_package(1, &recipient, PackageStatus::Claimed);
        ctx.env.mock_all_auths();

        let result = ctx.run(|| set_delegate(&ctx.env, &admin, 1, &delegate));
        assert_eq!(result, Err(Error::PackageNotActive));
    }

    #[test]
    fn cannot_set_delegate_to_recipient_address() {
        let ctx = Ctx::new();
        let recipient = Address::generate(&ctx.env);
        let admin = Address::generate(&ctx.env);

        ctx.create_test_package(1, &recipient, PackageStatus::Created);
        ctx.env.mock_all_auths();

        let result = ctx.run(|| set_delegate(&ctx.env, &admin, 1, &recipient));
        assert_eq!(result, Err(Error::InvalidState));
    }

    #[test]
    fn set_delegate_requires_admin_auth() {
        let ctx = Ctx::new();
        let recipient = Address::generate(&ctx.env);
        let delegate = Address::generate(&ctx.env);
        let stranger = Address::generate(&ctx.env);

        ctx.create_test_package(1, &recipient, PackageStatus::Created);

        // Deliberately NO mock_all_auths: `require_auth()` on an address that
        // is not the transaction source cannot be satisfied by the test
        // environment, so the call must panic rather than mutate state.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ctx.run(|| set_delegate_with_expiry(&ctx.env, &stranger, 1, &delegate, 0))
        }));
        assert!(result.is_err());
        assert_eq!(ctx.run(|| get_delegate(&ctx.env, 1)), None);
    }

    #[test]
    fn delegate_history_tracking() {
        let ctx = Ctx::new();
        let recipient = Address::generate(&ctx.env);
        let delegate1 = Address::generate(&ctx.env);
        let delegate2 = Address::generate(&ctx.env);
        let admin = Address::generate(&ctx.env);

        ctx.create_test_package(1, &recipient, PackageStatus::Created);
        ctx.env.mock_all_auths();

        // Set first delegate
        ctx.run(|| set_delegate(&ctx.env, &admin, 1, &delegate1).unwrap());

        // Change to second delegate
        ctx.run(|| set_delegate(&ctx.env, &admin, 1, &delegate2).unwrap());

        // Check history
        let history = ctx.run(|| get_delegate_history(&ctx.env, 1));
        assert_eq!(history.len(), 2);

        // First record should have None as previous delegate
        let first_record = history.get(0).unwrap();
        assert_eq!(first_record.previous_delegate, None);
        assert_eq!(first_record.new_delegate, Some(delegate1.clone()));

        // Second record should have delegate1 as previous
        let second_record = history.get(1).unwrap();
        assert_eq!(second_record.previous_delegate, Some(delegate1.clone()));
        assert_eq!(second_record.new_delegate, Some(delegate2.clone()));
    }

    #[test]
    fn cleanup_expired_delegates_works() {
        let ctx = Ctx::new();
        let recipient = Address::generate(&ctx.env);
        let delegate1 = Address::generate(&ctx.env);
        let delegate2 = Address::generate(&ctx.env);
        let admin = Address::generate(&ctx.env);
        let now = 1000u64;

        ctx.create_test_package(1, &recipient, PackageStatus::Created);
        ctx.create_test_package(2, &recipient, PackageStatus::Created);

        ctx.env.ledger().set_timestamp(now);
        ctx.env.mock_all_auths();

        // Set delegates with different expirations
        ctx.run(|| set_delegate_with_expiry(&ctx.env, &admin, 1, &delegate1, now + 50).unwrap()); // Will expire
        ctx.run(|| set_delegate_with_expiry(&ctx.env, &admin, 2, &delegate2, now + 200).unwrap()); // Won't expire

        // Advance time past first delegate's expiration
        ctx.env.ledger().set_timestamp(now + 100);

        // Cleanup expired delegates
        let cleaned = ctx.run(|| cleanup_expired_delegates(&ctx.env, &admin).unwrap());
        assert_eq!(cleaned, 1);

        // Check that expired delegate is gone
        assert_eq!(ctx.run(|| get_delegate(&ctx.env, 1)), None);

        // Check that non-expired delegate remains
        assert_eq!(ctx.run(|| get_delegate(&ctx.env, 2)), Some(delegate2));
    }

    #[test]
    fn resetting_delegate_without_expiry_drops_stale_expiry() {
        let ctx = Ctx::new();
        let recipient = Address::generate(&ctx.env);
        let delegate = Address::generate(&ctx.env);
        let admin = Address::generate(&ctx.env);
        let now = 1000u64;

        ctx.env.ledger().set_timestamp(now);
        ctx.create_test_package(1, &recipient, PackageStatus::Created);
        ctx.env.mock_all_auths();

        // Set with an expiry, then re-set without one.
        ctx.run(|| set_delegate_with_expiry(&ctx.env, &admin, 1, &delegate, now + 100).unwrap());
        ctx.run(|| set_delegate_with_expiry(&ctx.env, &admin, 1, &delegate, 0).unwrap());

        // The stale expiry must not linger: after the old deadline the
        // delegate is still authorised.
        ctx.env.ledger().set_timestamp(now + 200);
        assert!(ctx.run(|| is_authorised_claimer(&ctx.env, 1, &recipient, &delegate)));
        assert_eq!(ctx.run(|| get_delegate(&ctx.env, 1)), Some(delegate));
    }
}

#![cfg(test)]

//! Decimal-edge tests for `AidEscrow::validate_token` (issue #235).
//!
//! These tests pin down three pieces of behaviour that are easy to regress:
//!
//! 1. The boundary decimals 0, 7, 38 and the just-above-boundary 39 are
//!    classified correctly: 0/7/38 pass validation (with default policy),
//!    39 returns `Error::InvalidTokenDecimals`.
//! 2. The admin-configurable `min_decimals` policy field on `Config`
//!    correctly raises the floor and rejects tokens with decimals below
//!    it (also returning `Error::InvalidTokenDecimals`), while leaving the
//!    upper bound at 38 unchanged. The floor is **strict** (`<`), so
//!    `decimals == min_decimals` is accepted.
//! 3. `Error::InvalidToken` is **only** used when the `decimals()` call
//!    itself fails (RPC / contract error). Token-response failures and
//!    decimal-range failures are kept distinct — collapsing them would
//!    hide config errors as "bad token" errors.
//!
//! All assertions go through the public entry points (`fund`,
//! `create_package`, `set_config`, `withdraw_surplus`) so the private
//! `validate_token` is exercised through real production call paths.

// Shared helper module — contains the configurable `MockDecimalsToken`
// contract used to drive arbitrary decimals values.
mod common;

use aid_escrow::{AidEscrow, AidEscrowClient, Config, Error};
use common::{MockDecimalsToken, MockDecimalsTokenClient};
use soroban_sdk::{testutils::Address as _, Address, Env, Map, Vec};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/// Registers a fresh mock token whose `decimals()` returns `decimals`.
fn register_mock_token(env: &Env, decimals: u32) -> Address {
    // `env.register(...)` returns an `Address` directly in this SDK
    // version (older versions returned `BytesN<32>` requiring
    // `.address()` — that shim is no longer needed).
    let token_id = env.register(MockDecimalsToken, ());
    let client = MockDecimalsTokenClient::new(env, &token_id);
    client.init(&decimals);
    token_id
}

/// Initializes the `AidEscrow` contract with `admin` and the supplied
/// `Config`.  Returns the client and an admin `Address` for further setup.
fn setup_escrow(env: &Env, config: Config) -> (AidEscrowClient<'static>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(AidEscrow, ());
    let client = AidEscrowClient::new(env, &contract_id);
    client.init(&admin);
    client.set_config(&config);
    (client, admin)
}

fn default_config(env: &Env) -> Config {
    Config {
        min_amount: 1,
        max_expires_in: 0,
        allowed_tokens: Vec::new(env),
        min_decimals: 0,
    }
}

// ---------------------------------------------------------------------------
// Boundary decimals — accept / reject classification
// ---------------------------------------------------------------------------

mod boundary_decimals {
    use super::*;

    #[test]
    fn fund_with_zero_decimal_token_passes_validate_token() {
        // Issue acceptance: "fund with decimals=0 continues to work unless
        // the policy is configured otherwise."  With the default
        // `min_decimals=0` the validation step must pass.
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup_escrow(&env, default_config(&env));
        let token = register_mock_token(&env, 0);

        let result = client.try_fund(&token, &admin, &100);
        assert!(
            !matches!(result, Err(Ok(Error::InvalidTokenDecimals))),
            "0-decimal token must not be rejected with InvalidTokenDecimals under default policy"
        );
    }

    #[test]
    fn fund_with_seven_decimal_token_passes_validate_token() {
        // 7 is the canonical SAC decimals value and must be accepted.
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup_escrow(&env, default_config(&env));
        let token = register_mock_token(&env, 7);

        let result = client.try_fund(&token, &admin, &10_000_000);
        assert!(
            !matches!(result, Err(Ok(Error::InvalidTokenDecimals))),
            "7-decimal token must not be rejected with InvalidTokenDecimals"
        );
    }

    #[test]
    fn fund_with_thirty_eight_decimal_token_passes_validate_token() {
        // 38 is the largest legal decimals value; validate_token must
        // accept it.  Because `10^38` does not fit any reasonable amount
        // we pass through the precision check, we only assert the *not*
        // case here (decimals rejection) rather than pinning to a specific
        // downstream error — the precision check precedence may be
        // reorganised in the future and this test must not regress.
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup_escrow(&env, default_config(&env));
        let token = register_mock_token(&env, 38);

        let result = client.try_fund(&token, &admin, &1);
        assert!(
            !matches!(result, Err(Ok(Error::InvalidTokenDecimals))),
            "38-decimal token must not be rejected with InvalidTokenDecimals"
        );
    }

    #[test]
    fn fund_with_thirty_nine_decimal_token_returns_invalid_token_decimals() {
        // Issue acceptance: "fund with decimals=39 must return
        // Error::InvalidTokenDecimals."
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup_escrow(&env, default_config(&env));
        let token = register_mock_token(&env, 39);

        assert_eq!(
            client.try_fund(&token, &admin, &1),
            Err(Ok(Error::InvalidTokenDecimals))
        );
    }

    #[test]
    fn create_package_with_thirty_nine_decimal_token_returns_invalid_token_decimals() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup_escrow(&env, default_config(&env));
        let token = register_mock_token(&env, 39);

        assert_eq!(
            client.try_create_package(
                &admin,
                &1u64,
                &Address::generate(&env),
                &1,
                &token,
                &3600,
                &Map::new(&env),
            ),
            Err(Ok(Error::InvalidTokenDecimals))
        );
    }

    #[test]
    fn set_config_with_thirty_nine_decimal_token_in_allowlist_returns_invalid_token_decimals() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        let bad_token = register_mock_token(&env, 39);
        let mut allowed_tokens = Vec::new(&env);
        allowed_tokens.push_back(bad_token);

        assert_eq!(
            client.try_set_config(&Config {
                min_amount: 1,
                max_expires_in: 0,
                allowed_tokens,
                min_decimals: 0,
            }),
            Err(Ok(Error::InvalidTokenDecimals))
        );
    }
}

// ---------------------------------------------------------------------------
// `min_decimals` policy enforcement
// ---------------------------------------------------------------------------

mod min_decimals_policy {
    use super::*;

    #[test]
    fn set_config_rejects_min_decimals_greater_than_max() {
        // 40 > MAX_TOKEN_DECIMALS (38), so the policy itself is invalid.
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        assert_eq!(
            client.try_set_config(&Config {
                min_amount: 1,
                max_expires_in: 0,
                allowed_tokens: Vec::new(&env),
                min_decimals: 40,
            }),
            Err(Ok(Error::InvalidTokenDecimals))
        );
    }

    #[test]
    fn min_decimals_five_rejects_token_with_zero_decimals() {
        // 0 < 5: floor is strict, so a 0-decimal token is rejected.
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        let too_low = register_mock_token(&env, 0);
        let mut allowed_tokens = Vec::new(&env);
        allowed_tokens.push_back(too_low);

        assert_eq!(
            client.try_set_config(&Config {
                min_amount: 1,
                max_expires_in: 0,
                allowed_tokens,
                min_decimals: 5,
            }),
            Err(Ok(Error::InvalidTokenDecimals))
        );
    }

    #[test]
    fn min_decimals_five_accepts_token_with_five_decimals() {
        // Floor is `decimals < min_decimals`. Equality `==` must be
        // accepted — locking this in prevents a stray `<=` flip.
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        let exact_floor = register_mock_token(&env, 5);
        let mut allowed_tokens = Vec::new(&env);
        allowed_tokens.push_back(exact_floor);

        // set_config returns `()` on success and would trap on failure
        // (because the contract macro unwraps the inner Result). If this
        // call does not panic, the equality boundary is accepted.
        client.set_config(&Config {
            min_amount: 1,
            max_expires_in: 0,
            allowed_tokens,
            min_decimals: 5,
        });
    }

    #[test]
    fn min_decimals_five_accepts_token_with_seven_decimals() {
        // 7 > 5: comfortably above the floor.
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        let acceptable = register_mock_token(&env, 7);
        let funder = Address::generate(&env);
        let mut allowed_tokens = Vec::new(&env);
        allowed_tokens.push_back(acceptable.clone());

        client.set_config(&Config {
            min_amount: 1,
            max_expires_in: 0,
            allowed_tokens,
            min_decimals: 5,
        });

        // After the policy is in place the same token must still pass
        // validate_token via the fund entrypoint.
        let result = client.try_fund(&acceptable, &funder, &10_000_000);
        assert!(
            !matches!(result, Err(Ok(Error::InvalidTokenDecimals))),
            "7-decimal token must stay valid under min_decimals=5 policy"
        );
    }

    #[test]
    fn min_decimals_eight_rejects_token_with_seven_decimals() {
        // 7 < 8: 7-decimal token falls below the floor.
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        let too_low = register_mock_token(&env, 7);
        let mut allowed_tokens = Vec::new(&env);
        allowed_tokens.push_back(too_low);

        assert_eq!(
            client.try_set_config(&Config {
                min_amount: 1,
                max_expires_in: 0,
                allowed_tokens,
                min_decimals: 8,
            }),
            Err(Ok(Error::InvalidTokenDecimals))
        );
    }

    #[test]
    fn default_config_accepts_token_with_eight_decimals() {
        // Belt-and-braces: with the default min_decimals=0 the policy
        // adds nothing and an 8-decimal token (above the default floor
        // and below the cap) must pass validate_token just as 7 did.
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup_escrow(&env, default_config(&env));
        let token = register_mock_token(&env, 8);

        let result = client.try_fund(&token, &admin, &100_000_000);
        assert!(
            !matches!(result, Err(Ok(Error::InvalidTokenDecimals))),
            "8-decimal token must not be rejected under default policy"
        );
    }
}

// ---------------------------------------------------------------------------
// `Error::InvalidToken` (host-decoder failure) preservation
// ---------------------------------------------------------------------------
//
// These tests register an AidEscrow contract itself as the "token". The
// AidEscrow public surface has no `decimals()` method so `try_invoke_contract`
// fails with a contract-error, and `validate_token` must surface that as
// `Error::InvalidToken` — not the new `InvalidTokenDecimals` error. This
// guards against a future refactor accidentally conflating the two errors.

mod invalid_token_preservation {
    use super::*;

    #[test]
    fn fund_with_non_token_contract_returns_invalid_token() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup_escrow(&env, default_config(&env));

        // Register AidEscrow as a stand-in "token" — it does NOT expose
        // a `decimals()` function, so the cross-contract call fails at the
        // host layer and validate_token returns InvalidToken.
        let fake_token = env.register(AidEscrow, ());

        assert_eq!(
            client.try_fund(&fake_token, &admin, &1),
            Err(Ok(Error::InvalidToken))
        );
    }

    #[test]
    fn create_package_with_non_token_contract_returns_invalid_token() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup_escrow(&env, default_config(&env));

        let fake_token = env.register(AidEscrow, ());

        assert_eq!(
            client.try_create_package(
                &admin,
                &1u64,
                &Address::generate(&env),
                &1,
                &fake_token,
                &3600,
                &Map::new(&env),
            ),
            Err(Ok(Error::InvalidToken))
        );
    }
}

// ---------------------------------------------------------------------------
// `withdraw_surplus` honours the `min_decimals` policy
// ---------------------------------------------------------------------------
//
// `withdraw_surplus` also calls `validate_token`, so the configured
// `min_decimals` floor must apply symmetrically to funding + surplus
// withdrawal. Without this, a config update that bans 0-decimal tokens
// would still let admins drain surplus from them.

mod withdraw_surplus_policy {
    use super::*;

    #[test]
    fn withdraw_surplus_rejects_min_decimals_policy_violation() {
        // Use a 0-decimal mock token. After raising min_decimals=5, the
        // token is no longer valid and withdraw_surplus must reject.
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        let zero_decimal = register_mock_token(&env, 0);

        // Switch to a strict min_decimals=5 policy. No allowed_tokens are
        // set, so the only check that runs is `min_decimals` itself on
        // the token argument to withdraw_surplus.
        client.set_config(&Config {
            min_amount: 1,
            max_expires_in: 0,
            allowed_tokens: Vec::new(&env),
            min_decimals: 5,
        });

        assert_eq!(
            client.try_withdraw_surplus(&Address::generate(&env), &1, &zero_decimal,),
            Err(Ok(Error::InvalidTokenDecimals))
        );
    }
}

// ---------------------------------------------------------------------------
// v1 -> v2 migration
// ---------------------------------------------------------------------------
//
// Issue #235's `Config` schema change is silently breaking for any
// deployment that stored a v1 `Config`. The contract's `migrate(1, 2)`
// arm resets the stored config to a v2-compatible default; simply
// bumping the version without that reset would leave `get_config()`
// returning a fabricated `unwrap_or(...)` default while the admin
// believed their v1 settings were still active.

mod config_migration {
    use super::*;

    #[test]
    fn migrate_v1_to_v2_resets_stored_config_to_default_v2_layout() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        // Sanity: init writes a v1 config. The migration rewrites it
        // explicitly to the v2 shape so get_config stays consistent.
        assert_eq!(client.get_version(), 1);

        client.migrate(&2u32);

        assert_eq!(client.get_version(), 2);

        let config = client.get_config();
        assert_eq!(config.min_amount, 1);
        assert_eq!(config.max_expires_in, 0);
        assert_eq!(config.min_decimals, 0);
        assert!(config.allowed_tokens.is_empty());
    }

    #[test]
    fn migrate_v1_to_v2_allows_admin_to_re_set_config() {
        // After migrate, the admin must be able to re-establish their
        // policy via set_config. This is the documented recovery path.
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        client.init(&admin);

        client.migrate(&2u32);

        // Re-supply a real policy and verify it sticks.
        let acceptable = register_mock_token(&env, 7);
        let mut allowed_tokens = Vec::new(&env);
        allowed_tokens.push_back(acceptable);

        client.set_config(&Config {
            min_amount: 1,
            max_expires_in: 0,
            allowed_tokens,
            min_decimals: 5,
        });

        let cfg = client.get_config();
        assert_eq!(cfg.min_decimals, 5);
        assert_eq!(cfg.allowed_tokens.len(), 1);
    }
}

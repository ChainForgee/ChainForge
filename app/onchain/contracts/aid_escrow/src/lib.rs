#![no_std]

//! # Token Amount Normalization & Validation Policy
//!
//! ## Normalization Policy
//! All token amounts passed to this contract **must be normalized to the token's smallest unit** (e.g., stroops for Stellar, wei for Ethereum, or the lowest decimal unit for the token).
//! The contract does **not** perform automatic normalization or conversion based on token decimals. It is the caller's responsibility to ensure amounts are properly scaled.
//!
//! ## Validation Rules
//! - Amounts must be strictly positive integers (`amount > 0`).
//! - Amounts must be multiples of the token's smallest unit (i.e., no precision-breaking values).
//! - Zero, negative, or non-integer values (relative to the token's decimals) are rejected.
//! - The contract assumes all amounts are already validated and normalized before being passed in.
//!
//! ## Recommendations
//! - Integrators should fetch the token's decimals and normalize user input accordingly.
//! - When adding support for new tokens, ensure all amounts are compatible with the token's decimal convention.
//!
//! ## See Also
//! - Validation is enforced in `fund`, `create_package`, and related entrypoints.
//! - Tests for invalid/edge cases are in `tests/aid_escrow_tests.rs`.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, Address,
    Bytes, Env, IntoVal, Map, String, Symbol, Val, Vec,
};

mod delegate;

pub use delegate::DelegateHistory;

// --- Storage Keys ---
const KEY_ADMIN: Symbol = symbol_short!("admin");
const KEY_TOTAL_LOCKED: Symbol = symbol_short!("locked"); // Map<Address, i128>
const KEY_VERSION: Symbol = symbol_short!("version");
const KEY_PKG_COUNTER: Symbol = symbol_short!("pkg_cnt");
const KEY_CONFIG: Symbol = symbol_short!("config");
const KEY_PKG_IDX: Symbol = symbol_short!("pkg_idx"); // Aggregation index counter
const KEY_RECIPIENT_COUNT: Symbol = symbol_short!("rcnt"); // Map<Address, u64> — packages per recipient

// Secondary index: instance (KEY_RECIPIENT_IDX, recipient, seq) -> u64 package_id.
// seq is a per-recipient ordinal assigned at creation, so recipient queries never
// scan the global ID space (see issue #424). Instance storage is used because
// persistent writes meter far higher in this SDK (see GAS_PROFILING_REPORT.md).
const KEY_RECIPIENT_IDX: Symbol = symbol_short!("rpidx");
const KEY_DISTRIBUTORS: Symbol = symbol_short!("dstrbtrs"); // Map<Address, bool>
const KEY_PAUSED: Symbol = symbol_short!("paused");
const KEY_PAUSE_CREATE: Symbol = symbol_short!("p_create");
const KEY_PAUSE_CLAIM: Symbol = symbol_short!("p_claim");
const KEY_PAUSE_WITHDRAW: Symbol = symbol_short!("p_wdrw");
const KEY_TOTAL_CLAIMED: Symbol = symbol_short!("claimed"); // Map<Address, i128>
const KEY_TOTAL_COMMITTED: Symbol = symbol_short!("cmt"); // Map<Address, i128>
const KEY_TOTAL_EXPIRED_CANCELLED: Symbol = symbol_short!("expcan"); // Map<Address, i128>
const META_MERKLE_ROOT_KEY: &str = "merkle_root";
const META_MERKLE_ROOT_EXPIRES_AT_KEY: &str = "merkle_root_expires_at";
const META_MERKLE_LEAF_VERSION_KEY: &str = "merkle_leaf_version";
const KEY_PENDING_ADMIN: Symbol = symbol_short!("pendadm");
const KEY_ADMIN_DEADLINE: Symbol = symbol_short!("admdln");
const DEFAULT_ADMIN_DEADLINE: u64 = 7 * 24 * 60 * 60; // 7 days in seconds

/// Maximum number of decimals supported by Stellar assets / SAC tokens.
///
/// The Stellar / SAC token standard caps `decimals()` at 38.  39+ is
/// rejected because no on-chain token can declare more, and `10^39`
/// already overflows `i128` (so even if it existed we could never
/// represent a whole unit).  `validate_token` rejects anything above
/// this with `Error::InvalidTokenDecimals`.  See issue #235.
pub const MAX_TOKEN_DECIMALS: u32 = 38;

/// Upper bound for `list_recipient_packages` page sizes.  The `limit` argument
/// is clamped to this value so a single read call can never request a scan
/// window large enough to exhaust Soroban's per-call read budget (issue #424).
pub const MAX_RECIPIENT_PAGE_SIZE: u32 = 100;

/// Initial value of `Config.min_decimals` written by `init()` when no
/// admin has called `set_config()` yet.  0 disables the floor check, so
/// tokens with 0 decimals (e.g. NFTs, indivisible units) are accepted by
/// default.  This is the *init-default* only — admins are free to raise
/// it later via `set_config`.
pub const INIT_MIN_TOKEN_DECIMALS: u32 = 0;

// --- Data Types ---

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum PackageStatus {
    Created = 0,
    Claimed = 1,
    Expired = 2,
    Cancelled = 3,
    Refunded = 4,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Package {
    pub id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub token: Address,
    pub status: PackageStatus,
    pub created_at: u64,
    pub expires_at: u64,
    pub claim_starts_at: u64,
    pub metadata: Map<Symbol, String>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub min_amount: i128,
    pub max_expires_in: u64,
    pub allowed_tokens: Vec<Address>,
    /// Minimum decimals accepted by `validate_token` (admin-configurable).
    /// Tokens with `decimals < min_decimals` are rejected with
    /// `Error::InvalidTokenDecimals`. The upper bound is fixed by
    /// [`MAX_TOKEN_DECIMALS`] and produces the same error.
    pub min_decimals: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Aggregates {
    pub total_committed: i128,
    pub total_claimed: i128,
    pub total_expired_cancelled: i128,
}

/// One page of `list_recipient_packages` results.
///
/// `next_cursor` is the per-recipient index ordinal to pass as `cursor` on the
/// next call; when it equals the recipient's total package count there are no
/// further pages.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RecipientPackagesPage {
    pub ids: Vec<u64>,
    pub next_cursor: u64,
}

#[contracterror]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    NotAuthorized = 3,
    InvalidAmount = 4,
    PackageNotFound = 5,
    PackageNotActive = 6,
    PackageExpired = 7,
    PackageNotExpired = 8,
    InsufficientFunds = 9,
    PackageIdExists = 10,
    InvalidState = 11,
    // recipients and amounts have different lengths
    MismatchedArrays = 12,
    InsufficientSurplus = 13,
    ContractPaused = 14,
    ClaimTooEarly = 15,
    InvalidProof = 16,
    InvalidToken = 17,
    TokenTransferFailed = 18,
    // Merkle allowlist root has expired (merkle_root_expires_at <= now)
    AllowlistExpired = 19,
    ProofTooLarge = 20,
    NoPendingAdmin = 21,
    AdminRotationExpired = 22,
    /// Token decimals are out of the accepted `[min_decimals, 38]` range.
    /// Distinguished from `InvalidToken` (meaning the token contract is
    /// malformed / does not respond to `decimals()`).
    InvalidTokenDecimals = 23,
}

// --- Contract Events (indexer-friendly; stable topics & payloads) ---
// Topic = struct name in snake_case (e.g. package_created). Do not rename without versioning.

/// Emitted when the escrow pool is funded. Actor = funder.
#[contractevent]
pub struct EscrowFunded {
    pub from: Address,
    pub token: Address,
    pub amount: i128,
    pub timestamp: u64,
}

#[contractevent]
pub struct PackageCreated {
    pub package_id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub actor: Address,
    pub timestamp: u64,
}

#[contractevent]
pub struct PackageClaimed {
    pub package_id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub actor: Address,
    pub timestamp: u64,
}

#[contractevent]
pub struct PackageDisbursed {
    pub package_id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub actor: Address,
    pub timestamp: u64,
}

#[contractevent]
pub struct PackageRevoked {
    pub package_id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub actor: Address,
    pub timestamp: u64,
}

#[contractevent]
pub struct PackageRefunded {
    pub package_id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub actor: Address,
    pub timestamp: u64,
}

#[contractevent]
pub struct BatchCreatedEvent {
    pub ids: Vec<u64>,
    pub admin: Address,
    pub total_amount: i128,
}

#[contractevent]
pub struct ExtendedEvent {
    pub id: u64,
    pub admin: Address,
    pub old_expires_at: u64,
    pub new_expires_at: u64,
}

#[contractevent]
pub struct SurplusWithdrawnEvent {
    pub to: Address,
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
pub struct ContractPausedEvent {
    pub admin: Address,
}

#[contractevent]
pub struct ContractUnpausedEvent {
    pub admin: Address,
}

#[contractevent]
pub struct ActionPausedEvent {
    pub admin: Address,
    pub action: Symbol,
}

#[contractevent]
pub struct ActionUnpausedEvent {
    pub admin: Address,
    pub action: Symbol,
}

#[contractevent]
pub struct AdminRotatedEvent {
    pub old_admin: Address,
    pub new_admin: Address,
}

#[contract]
pub struct AidEscrow;

#[contractimpl]
impl AidEscrow {
    // --- Admin & Config ---

    /// Initializes the contract.
    ///
    /// # Arguments
    /// * `admin` — The address that will own the contract (can pause, config, disburse, etc.).
    ///
    /// # Errors
    /// Returns `Error::AlreadyInitialized` if called more than once.
    pub fn init(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&KEY_ADMIN) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&KEY_ADMIN, &admin);
        env.storage().instance().set(&KEY_VERSION, &1u32);
        let config = Config {
            min_amount: 1,
            max_expires_in: 0,
            allowed_tokens: Vec::new(&env),
            min_decimals: INIT_MIN_TOKEN_DECIMALS,
        };
        env.storage().instance().set(&KEY_CONFIG, &config);
        Ok(())
    }

    /// Returns the admin address stored at initialization.
    ///
    /// # Errors
    /// Returns `Error::NotInitialized` if the contract has not been initialized.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&KEY_ADMIN)
            .ok_or(Error::NotInitialized)
    }

    /// Returns the current contract version.
    /// Defaults to `0` if the contract has never been initialized.
    pub fn get_version(env: Env) -> u32 {
        env.storage().instance().get(&KEY_VERSION).unwrap_or(0)
    }

    /// Returns the pending admin address, if any.
    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&KEY_PENDING_ADMIN)
    }

    /// Admin-only. Initiates a two-step admin rotation by setting a pending admin.
    /// The pending admin must call `accept_admin()` within the deadline to complete the rotation.
    ///
    /// # Arguments
    /// * `new_admin` — The address of the proposed new admin.
    ///
    /// # Errors
    /// Returns `Error::NotAuthorized` if caller is not the current admin.
    pub fn rotate_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        let deadline = env.ledger().timestamp() + DEFAULT_ADMIN_DEADLINE;
        env.storage().instance().set(&KEY_PENDING_ADMIN, &new_admin);
        env.storage().instance().set(&KEY_ADMIN_DEADLINE, &deadline);
        Ok(())
    }

    /// Pending-admin-only. Completes the admin rotation.
    /// Must be called by the pending admin within the deadline (7 days by default).
    /// Emits an `AdminRotatedEvent`.
    ///
    /// # Errors
    /// Returns `Error::NoPendingAdmin` if no rotation is in progress.
    /// Returns `Error::AdminRotationExpired` if the deadline has passed.
    /// Returns `Error::NotAuthorized` if caller is not the pending admin.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending_admin: Address = env
            .storage()
            .instance()
            .get(&KEY_PENDING_ADMIN)
            .ok_or(Error::NoPendingAdmin)?;

        let deadline: u64 = env
            .storage()
            .instance()
            .get(&KEY_ADMIN_DEADLINE)
            .unwrap_or(0);

        if env.ledger().timestamp() > deadline {
            return Err(Error::AdminRotationExpired);
        }

        pending_admin.require_auth();

        let old_admin = Self::get_admin(env.clone())?;
        env.storage().instance().set(&KEY_ADMIN, &pending_admin);
        env.storage().instance().remove(&KEY_PENDING_ADMIN);
        env.storage().instance().remove(&KEY_ADMIN_DEADLINE);

        AdminRotatedEvent {
            old_admin,
            new_admin: pending_admin,
        }
        .publish(&env);

        Ok(())
    }

    /// Returns the semantic version of the contract package.
    pub fn contract_version(env: Env) -> String {
        String::from_str(&env, env!("CARGO_PKG_VERSION"))
    }

    /// Admin-only. Bumps the contract version and runs any required migration logic.
    ///
    /// # Arguments
    /// * `new_version` — Target version number.
    ///
    /// # Errors
    /// Returns `Error::NotAuthorized` if caller is not the admin.
    ///
    /// # Migration notes
    /// - `1 -> 2`: the `Config` struct gained a `min_decimals: u32` field.
    ///   Configurations persisted by v1 cannot be deserialised into the
    ///   v2 layout, so this arm resets the stored config to a safe
    ///   default (`min_amount=1`, `max_expires_in=0`, no allowed tokens,
    ///   `min_decimals=0`).  Admins must call `set_config(...)` again
    ///   after the upgrade to reinstate their policy.  Without `migrate`
    ///   they would silently observe `get_config()` returning defaults
    ///   while believing their v1 settings were still active.
    pub fn migrate(env: Env, new_version: u32) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        let current_version = Self::get_version(env.clone());

        // Perform version-specific migrations
        match (current_version, new_version) {
            (1, 2) => {
                // v1 -> v2: the stored `Config` shape is no longer
                // compatible (it lacks `min_decimals`). Reset to a
                // permissive default; the admin will re-supply their
                // policy via `set_config` after the upgrade.
                let config = Config {
                    min_amount: 1,
                    max_expires_in: 0,
                    allowed_tokens: Vec::new(&env),
                    min_decimals: INIT_MIN_TOKEN_DECIMALS,
                };
                env.storage().instance().set(&KEY_CONFIG, &config);
            }
            _ => {
                // No-op for now, but structured for future use
            }
        }

        env.storage().instance().set(&KEY_VERSION, &new_version);
        Ok(())
    }

    /// Admin-only. Grants distributor privileges to `addr`.
    /// Distributors can create packages but cannot pause, config, or disburse.
    ///
    /// # Errors
    /// Returns `Error::NotAuthorized` if caller is not the admin.
    pub fn add_distributor(env: Env, addr: Address) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        let mut distributors: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&KEY_DISTRIBUTORS)
            .unwrap_or(Map::new(&env));
        distributors.set(addr, true);
        env.storage()
            .instance()
            .set(&KEY_DISTRIBUTORS, &distributors);

        Ok(())
    }

    /// Admin-only. Revokes distributor privileges from `addr`.
    ///
    /// # Errors
    /// Returns `Error::NotAuthorized` if caller is not the admin.
    pub fn remove_distributor(env: Env, addr: Address) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        let mut distributors: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&KEY_DISTRIBUTORS)
            .unwrap_or(Map::new(&env));
        distributors.remove(addr);
        env.storage()
            .instance()
            .set(&KEY_DISTRIBUTORS, &distributors);

        Ok(())
    }

    /// Returns the list of currently registered distributor addresses.
    ///
    /// Returns an empty `Vec` if no distributors have been added.
    /// The result is sorted for deterministic ordering, making it suitable
    /// for off-chain indexers and audit dashboards.
    pub fn get_distributor_list(env: Env) -> Vec<Address> {
        let distributors: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&KEY_DISTRIBUTORS)
            .unwrap_or(Map::new(&env));
        let mut keys = distributors.keys();
        // Manual sort — soroban_sdk::Vec does not provide a sort() method.
        // Bubble sort is acceptable because distributor lists are expected to
        // be small (typically < 50 entries).
        let len = keys.len();
        if len > 1 {
            for i in 0..(len - 1) {
                for j in 0..(len - i - 1) {
                    let a = keys.get(j).unwrap();
                    let b = keys.get(j + 1).unwrap();
                    if a > b {
                        keys.set(j, b);
                        keys.set(j + 1, a);
                    }
                }
            }
        }
        keys
    }

    /// Admin-only. Updates the global contract configuration.
    ///
    /// # Arguments
    /// * `config` — New config values (`min_amount`, `max_expires_in`,
    ///   `allowed_tokens`, `min_decimals`).
    ///
    /// # Errors
    /// Returns `Error::InvalidAmount` if `config.min_amount` is zero or negative.
    /// Returns `Error::InvalidTokenDecimals` if `config.min_decimals` is
    /// greater than `MAX_TOKEN_DECIMALS`.
    /// Returns `Error::InvalidTokenDecimals` if any token in `allowed_tokens`
    /// has decimals outside `[min_decimals, MAX_TOKEN_DECIMALS]`.
    /// Returns `Error::InvalidToken` if a token contract does not respond
    /// to `decimals()`.
    /// Returns `Error::NotAuthorized` if caller is not the admin.
    pub fn set_config(env: Env, config: Config) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        if config.min_amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        if config.min_decimals > MAX_TOKEN_DECIMALS {
            return Err(Error::InvalidTokenDecimals);
        }

        for i in 0..config.allowed_tokens.len() {
            let token = config.allowed_tokens.get(i).ok_or(Error::InvalidToken)?;
            Self::validate_token(&env, &token, config.min_decimals)?;
        }

        env.storage().instance().set(&KEY_CONFIG, &config);
        Ok(())
    }

    /// Admin-only. Pauses the contract.
    /// While paused, package creation and claims are blocked.
    /// Emits a `ContractPausedEvent`.
    ///
    /// # Errors
    /// Returns `Error::NotAuthorized` if caller is not the admin.
    pub fn pause(env: Env) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();
        env.storage().instance().set(&KEY_PAUSED, &true);
        ContractPausedEvent { admin }.publish(&env);
        Ok(())
    }

    /// Admin-only. Unpauses the contract, resuming normal operation.
    /// Emits a `ContractUnpausedEvent`.
    ///
    /// # Errors
    /// Returns `Error::NotAuthorized` if caller is not the admin.
    pub fn unpause(env: Env) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();
        env.storage().instance().set(&KEY_PAUSED, &false);
        ContractUnpausedEvent { admin }.publish(&env);
        Ok(())
    }

    /// Admin-only. Pauses a specific action (create, claim, or withdraw).
    /// Emits an `ActionPausedEvent`.
    pub fn pause_action(env: Env, action: Symbol) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        let key = Self::get_pause_key(action.clone())?;
        env.storage().instance().set(&key, &true);

        ActionPausedEvent { admin, action }.publish(&env);
        Ok(())
    }

    /// Admin-only. Unpauses a specific action.
    /// Emits an `ActionUnpausedEvent`.
    pub fn unpause_action(env: Env, action: Symbol) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        let key = Self::get_pause_key(action.clone())?;
        env.storage().instance().set(&key, &false);

        ActionUnpausedEvent { admin, action }.publish(&env);
        Ok(())
    }

    /// Returns `true` if the specific action is currently paused.
    pub fn is_action_paused(env: Env, action: Symbol) -> bool {
        if Self::is_paused(env.clone()) {
            return true;
        }

        let key = match Self::get_pause_key(action) {
            Ok(k) => k,
            Err(_) => return false,
        };

        env.storage().instance().get(&key).unwrap_or(false)
    }

    /// Returns `true` if the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&KEY_PAUSED).unwrap_or(false)
    }

    /// Returns the current contract configuration.
    /// Falls back to defaults (`min_amount: 1`, `max_expires_in: 0`, empty
    /// token list, `min_decimals: 0`) if no config has been explicitly set.
    pub fn get_config(env: Env) -> Config {
        env.storage().instance().get(&KEY_CONFIG).unwrap_or(Config {
            min_amount: 1,
            max_expires_in: 0,
            allowed_tokens: Vec::new(&env),
            min_decimals: INIT_MIN_TOKEN_DECIMALS,
        })
    }

    // --- Funding & Packages ---

    /// Funds the contract (Pool Model).
    /// Transfers `amount` of `token` from `from` to this contract.
    /// This increases the contract's balance, allowing new packages to be created.
    pub fn fund(env: Env, token: Address, from: Address, amount: i128) -> Result<(), Error> {
        // 1. Basic Validation
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // 2. Validate token interface, decimal bounds, and fetch decimals dynamically.
        //    The min/max-decimals policy is read from the active config so that
        //    `Error::InvalidTokenDecimals` is returned for tokens outside
        //    `[config.min_decimals, MAX_TOKEN_DECIMALS]`.
        let config = Self::get_config(env.clone());
        let decimals = Self::validate_token(&env, &token, config.min_decimals)?;

        // 3. Dynamic Precision Check
        // Instead of checking 6 AND 8, we check ONLY the decimals this token uses.
        let unit = 10i128.pow(decimals);
        if amount % unit != 0 {
            // This ensures the user isn't trying to send a fractional "human" unit
            // if your business logic requires whole-unit funding.
            return Err(Error::InvalidAmount);
        }

        // 4. Authorization
        from.require_auth();

        // 5. Perform Transfer
        Self::transfer_token(
            &env,
            &token,
            &from,
            &env.current_contract_address(),
            &amount,
        )?;

        // 6. Events
        let timestamp = env.ledger().timestamp();
        EscrowFunded {
            from,
            token,
            amount,
            timestamp,
        }
        .publish(&env);

        Ok(())
    }

    /// Creates a package with a specific ID and stores provided metadata.
    /// Locks funds from the available pool (Contract Balance - Total Locked).
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `operator` - Address of the admin or distributor creating the package
    /// * `id` - Unique package ID
    /// * `recipient` - Address of the recipient
    /// * `amount` - Amount to escrow
    /// * `token` - Token contract address
    /// * `expires_at` - Expiration timestamp (0 for no expiration)
    /// * `metadata` - Arbitrary key-value metadata for the package
    #[allow(clippy::too_many_arguments)]
    pub fn create_package(
        env: Env,
        operator: Address,
        id: u64,
        recipient: Address,
        amount: i128,
        token: Address,
        expires_at: u64,
        metadata: Map<Symbol, String>,
    ) -> Result<u64, Error> {
        Self::check_action_paused(&env, symbol_short!("create"))?;
        Self::require_admin_or_distributor(&env, &operator)?;
        let config = Self::get_config(env.clone());

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // --- DYNAMIC PRECISION CHECK ---
        // Fetch the actual decimals from a validated token contract.
        let decimals = Self::validate_token(&env, &token, config.min_decimals)?;
        let unit = 10i128.pow(decimals);

        // Enforce that only whole units can be used (if that is your business requirement).
        // If you want to allow fractional units (e.g., 0.1 tokens), remove this check.
        if amount % unit != 0 {
            return Err(Error::InvalidAmount);
        }

        if amount < config.min_amount {
            return Err(Error::InvalidAmount);
        }

        // --- REST OF VALIDATIONS ---
        if !config.allowed_tokens.is_empty() && !config.allowed_tokens.contains(token.clone()) {
            return Err(Error::InvalidState);
        }

        if config.max_expires_in > 0 {
            let now = env.ledger().timestamp();
            if expires_at == 0 || expires_at <= now || expires_at - now > config.max_expires_in {
                return Err(Error::InvalidState);
            }
        }

        let key = (symbol_short!("pkg"), id);
        if env.storage().persistent().has(&key) {
            return Err(Error::PackageIdExists);
        }

        // --- SOLVENCY CHECK ---
        let contract_balance = Self::token_balance(&env, &token, &env.current_contract_address())?;

        let mut locked_map: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&KEY_TOTAL_LOCKED)
            .unwrap_or(Map::new(&env));

        let current_locked = locked_map.get(token.clone()).unwrap_or(0);

        if contract_balance < current_locked + amount {
            return Err(Error::InsufficientFunds);
        }

        // --- STATE UPDATES ---
        locked_map.set(token.clone(), current_locked + amount);
        env.storage().instance().set(&KEY_TOTAL_LOCKED, &locked_map);

        let created_at = env.ledger().timestamp();
        let claim_starts_at = Self::resolve_claim_starts_at(&env, &metadata, created_at)?;

        if claim_starts_at < created_at || (expires_at > 0 && claim_starts_at > expires_at) {
            return Err(Error::InvalidState);
        }

        let package = Package {
            id,
            recipient: recipient.clone(),
            amount,
            token: token.clone(),
            status: PackageStatus::Created,
            created_at,
            expires_at,
            claim_starts_at,
            metadata,
        };

        env.storage().persistent().set(&key, &package);

        // Maintain the recipient → package-id secondary index (issue #424).
        Self::index_recipient_package(&env, &recipient, id);

        // Increment running committed total for the token
        Self::add_to_status_totals(&env, &token, PackageStatus::Created, amount);

        let counter: u64 = env.storage().instance().get(&KEY_PKG_COUNTER).unwrap_or(0);
        if id >= counter {
            env.storage().instance().set(&KEY_PKG_COUNTER, &(id + 1));
        }

        let idx: u64 = env.storage().instance().get(&KEY_PKG_IDX).unwrap_or(0);
        let idx_key = (symbol_short!("pidx"), idx);
        env.storage().persistent().set(&idx_key, &id);
        env.storage().instance().set(&KEY_PKG_IDX, &(idx + 1));

        PackageCreated {
            package_id: id,
            recipient: recipient.clone(),
            amount,
            actor: operator,
            timestamp: created_at,
        }
        .publish(&env);

        Ok(id)
    }

    /// Creates multiple packages in a single transaction for multiple recipients.
    /// Uses an auto-incrementing counter for package IDs.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `operator` - Address of the admin or distributor creating the packages
    /// * `recipients` - List of recipient addresses
    /// * `amounts` - List of amounts to escrow (must match recipients)
    /// * `token` - Token contract address
    /// * `expires_in` - Expiry duration in seconds from now
    /// * `metadatas` - List of metadata maps, one per package
    pub fn batch_create_packages(
        env: Env,
        operator: Address,
        recipients: Vec<Address>,
        amounts: Vec<i128>,
        token: Address,
        expires_in: u64,
        metadatas: Vec<Map<Symbol, String>>,
    ) -> Result<Vec<u64>, Error> {
        Self::check_action_paused(&env, symbol_short!("create"))?;
        Self::require_admin_or_distributor(&env, &operator)?;
        let config = Self::get_config(env.clone());

        // Validate array lengths match
        if recipients.len() != amounts.len() || recipients.len() != metadatas.len() {
            return Err(Error::MismatchedArrays);
        }

        if !config.allowed_tokens.is_empty() && !config.allowed_tokens.contains(token.clone()) {
            return Err(Error::InvalidState);
        }

        if config.max_expires_in > 0 && (expires_in == 0 || expires_in > config.max_expires_in) {
            return Err(Error::InvalidState);
        }

        let decimals = Self::validate_token(&env, &token, config.min_decimals)?;
        let unit = 10i128.pow(decimals);
        let contract_balance = Self::token_balance(&env, &token, &env.current_contract_address())?;

        let mut locked_map: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&KEY_TOTAL_LOCKED)
            .unwrap_or(Map::new(&env));
        let mut current_locked = locked_map.get(token.clone()).unwrap_or(0);

        // Read the current package counter
        let mut counter: u64 = env.storage().instance().get(&KEY_PKG_COUNTER).unwrap_or(0);
        // Read the current aggregation index
        let mut idx: u64 = env.storage().instance().get(&KEY_PKG_IDX).unwrap_or(0);
        // Recipient index bookkeeping is hoisted into memory and persisted once
        // after the loop: re-serializing the per-recipient count map on every
        // iteration would be O(n^2) and blow the read budget on large batches.
        let mut recipient_count_map: Map<Address, u64> = env
            .storage()
            .instance()
            .get(&KEY_RECIPIENT_COUNT)
            .unwrap_or(Map::new(&env));

        let created_at = env.ledger().timestamp();
        let expires_at = created_at + expires_in;

        let mut created_ids: Vec<u64> = Vec::new(&env);
        let mut total_amount: i128 = 0;

        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            let amount = amounts.get(i).unwrap();
            let metadata = metadatas.get(i).unwrap();
            let claim_starts_at = Self::resolve_claim_starts_at(&env, &metadata, created_at)?;

            if claim_starts_at > expires_at {
                return Err(Error::InvalidState);
            }

            // Validate amount
            if amount <= 0 {
                return Err(Error::InvalidAmount);
            }

            if amount < config.min_amount || amount % unit != 0 {
                return Err(Error::InvalidAmount);
            }

            // Check solvency
            if contract_balance < current_locked + amount {
                return Err(Error::InsufficientFunds);
            }

            // Assign ID and increment counter
            let id = counter;
            counter += 1;

            let key = (symbol_short!("pkg"), id);

            // Create package
            let package = Package {
                id,
                recipient: recipient.clone(),
                amount,
                token: token.clone(),
                status: PackageStatus::Created,
                created_at,
                expires_at,
                claim_starts_at,
                metadata: metadata.clone(),
            };

            env.storage().persistent().set(&key, &package);

            // Maintain the recipient → package-id secondary index (issue #424).
            // Only the small per-recipient entry is written per package; the
            // count map is updated in memory and persisted after the loop.
            let seq = recipient_count_map.get(recipient.clone()).unwrap_or(0);
            let rpidx_key = (KEY_RECIPIENT_IDX, recipient.clone(), seq);
            env.storage().instance().set(&rpidx_key, &id);
            recipient_count_map.set(recipient.clone(), seq + 1);

            // Track running committed total
            Self::add_to_status_totals(&env, &token, PackageStatus::Created, amount);

            // Track package index for aggregation
            let idx_key = (symbol_short!("pidx"), idx);
            env.storage().persistent().set(&idx_key, &id);
            idx += 1;

            // Update locked
            current_locked += amount;
            total_amount += amount;

            PackageCreated {
                package_id: id,
                recipient: recipient.clone(),
                amount,
                actor: operator.clone(),
                timestamp: created_at,
            }
            .publish(&env);

            created_ids.push_back(id);
        }

        // Persist updated locked map, counter, and aggregation index
        locked_map.set(token.clone(), current_locked);
        env.storage().instance().set(&KEY_TOTAL_LOCKED, &locked_map);
        env.storage().instance().set(&KEY_PKG_COUNTER, &counter);
        env.storage().instance().set(&KEY_PKG_IDX, &idx);
        env.storage()
            .instance()
            .set(&KEY_RECIPIENT_COUNT, &recipient_count_map);

        // Emit batch event
        BatchCreatedEvent {
            ids: created_ids.clone(),
            admin: operator,
            total_amount,
        }
        .publish(&env);

        Ok(created_ids)
    }

    // --- Recipient Actions ---

    /// Claims the package on behalf of `claimer`.
    ///
    /// `claimer` must be either the package recipient or a registered,
    /// unexpired delegate (see `set_delegate`).  Funds always pay out to the
    /// package `recipient`, even when a delegate authorises the claim.
    pub fn claim(env: Env, id: u64, claimer: Address) -> Result<(), Error> {
        Self::check_action_paused(&env, symbol_short!("claim"))?;
        let key = (symbol_short!("pkg"), id);
        let mut package: Package = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PackageNotFound)?;

        if package.status != PackageStatus::Created {
            return Err(Error::PackageNotActive);
        }

        let now = env.ledger().timestamp();
        if now < package.claim_starts_at {
            return Err(Error::ClaimTooEarly);
        }

        if package.expires_at > 0 && now > package.expires_at {
            return Err(Error::PackageExpired);
        }

        // Packages configured with a Merkle allowlist must be claimed through
        // claim_with_proof so eligibility can be verified.
        if Self::merkle_root_from_metadata(&env, &package.metadata).is_some() {
            return Err(Error::InvalidProof);
        }

        // Only the recipient or a registered, unexpired delegate may claim.
        if !delegate::is_authorised_claimer(&env, id, &package.recipient, &claimer) {
            return Err(Error::NotAuthorized);
        }
        claimer.require_auth();

        let payout_recipient = package.recipient.clone();

        Self::finalize_claim(
            &env,
            &key,
            &mut package,
            id,
            &payout_recipient,
            &claimer,
            now,
        )
    }

    /// Claim a package guarded by an optional Merkle allowlist.
    ///
    /// If package metadata includes `merkle_root` (hex-encoded 32-byte value),
    /// `proof` must contain sibling hashes (hex-encoded 32-byte values) that
    /// validate the claimant leaf.  The leaf format depends on
    /// `merkle_leaf_version` in package metadata:
    ///
    /// - **v2** (default): `sha256(claimant_address_string || amount_be_bytes)`
    ///   binds both the recipient *and* the specific package amount.
    /// - **v1** (legacy): `sha256(claimant_address_string)` — address-only.
    ///   Packages without an explicit `merkle_leaf_version` use v1 for
    ///   backward compatibility.  New allowlists SHOULD set
    ///   `merkle_leaf_version = "v2"`.
    ///
    /// For non-Merkle packages this still works as a direct claim when
    /// `claimant` equals the stored recipient.
    pub fn claim_with_proof(
        env: Env,
        id: u64,
        claimant: Address,
        proof: Vec<String>,
    ) -> Result<(), Error> {
        Self::check_action_paused(&env, symbol_short!("claim"))?;

        // --- ENFORCE MERKLE PROOF CAP ---
        if proof.len() > 32 {
            return Err(Error::ProofTooLarge);
        }
        // ---------------------------------

        let key = (symbol_short!("pkg"), id);
        let mut package: Package = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PackageNotFound)?;

        if package.status != PackageStatus::Created {
            return Err(Error::PackageNotActive);
        }

        let now = env.ledger().timestamp();
        if now < package.claim_starts_at {
            return Err(Error::ClaimTooEarly);
        }

        if package.expires_at > 0 && now > package.expires_at {
            return Err(Error::PackageExpired);
        }

        claimant.require_auth();

        match Self::merkle_root_from_metadata(&env, &package.metadata) {
            Some(root) => {
                let expires_at =
                    Self::merkle_root_expires_at_from_metadata(&env, &package.metadata);
                let leaf_version = Self::merkle_leaf_version_from_metadata(&env, &package.metadata);
                Self::verify_merkle_proof_for_claimant(
                    &env,
                    &claimant,
                    &proof,
                    root,
                    expires_at,
                    now,
                    &leaf_version,
                    package.amount,
                )?;
                Self::finalize_claim(&env, &key, &mut package, id, &claimant, &claimant, now)
            }
            None => {
                if claimant != package.recipient {
                    return Err(Error::NotAuthorized);
                }
                Self::finalize_claim(&env, &key, &mut package, id, &claimant, &claimant, now)
            }
        }
    }

    // --- Delegate (recovery) Support ---

    /// Admin-only. Registers `delegate` as the recovery address for
    /// `package_id`, optionally with an `expires_at` deadline (0 = never).
    ///
    /// An unexpired delegate may authorise a claim on the package on behalf
    /// of the recipient via `claim(id, claimer)`.  `set_delegate` is rejected
    /// once the package is `Claimed`, and the delegate cannot equal the
    /// recipient.  Delegate assignments are recorded in an append-only audit
    /// trail readable via `get_delegate_history`.
    ///
    /// # Errors
    /// - `Error::NotAuthorized` - caller is not the admin
    /// - `Error::PackageNotFound` - package does not exist
    /// - `Error::PackageNotActive` - package already claimed
    /// - `Error::InvalidState` - delegate equals recipient, or `expires_at` is in the past
    pub fn set_delegate(
        env: Env,
        package_id: u64,
        delegate: Address,
        expires_at: u64,
    ) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        delegate::set_delegate_with_expiry(&env, &admin, package_id, &delegate, expires_at)
    }

    /// Returns the registered delegate for `package_id`, if any.
    /// Returns `None` if no delegate is set or the delegate has expired.
    pub fn get_delegate(env: Env, package_id: u64) -> Option<Address> {
        delegate::get_delegate(&env, package_id)
    }

    /// Returns the registered delegate and its expiry for `package_id`.
    /// Returns `None` if no delegate is set.
    pub fn get_delegate_info(env: Env, package_id: u64) -> Option<(Address, Option<u64>)> {
        delegate::get_delegate_info(&env, package_id)
    }

    /// Returns the full delegate audit trail for `package_id`.
    pub fn get_delegate_history(env: Env, package_id: u64) -> Vec<DelegateHistory> {
        delegate::get_delegate_history(&env, package_id)
    }

    /// Admin-only. Removes expired delegates from storage, reclaiming rent.
    /// Returns the number of delegates cleaned up.
    pub fn cleanup_expired_delegates(env: Env) -> Result<u32, Error> {
        let admin = Self::get_admin(env.clone())?;
        delegate::cleanup_expired_delegates(&env, &admin)
    }

    // --- Admin Actions ---

    /// Admin manually triggers disbursement (overrides recipient claim need, strictly checks status).
    pub fn disburse(env: Env, id: u64) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        let key = (symbol_short!("pkg"), id);
        let mut package: Package = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PackageNotFound)?;

        if package.status != PackageStatus::Created {
            return Err(Error::PackageNotActive);
        }

        // Transfer before accounting updates so reverted token transfers cannot
        // leave the escrow state inconsistent.
        Self::transfer_token(
            &env,
            &package.token,
            &env.current_contract_address(),
            &package.recipient,
            &package.amount,
        )?;

        // State Transition
        package.status = PackageStatus::Claimed;
        env.storage().persistent().set(&key, &package);

        // Update Locked
        Self::decrement_locked(&env, &package.token, package.amount);

        // Transition aggregate totals: Created → Claimed
        Self::add_to_status_totals(
            &env,
            &package.token,
            PackageStatus::Created,
            -package.amount,
        );
        Self::add_to_status_totals(&env, &package.token, PackageStatus::Claimed, package.amount);

        let timestamp = env.ledger().timestamp();
        PackageDisbursed {
            package_id: id,
            recipient: package.recipient.clone(),
            amount: package.amount,
            actor: admin.clone(),
            timestamp,
        }
        .publish(&env);

        Ok(())
    }

    /// Admin revokes a package (Cancels it). Funds are effectively unlocked but remain in contract pool.
    pub fn revoke(env: Env, id: u64) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        let key = (symbol_short!("pkg"), id);
        let mut package: Package = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PackageNotFound)?;

        if package.status != PackageStatus::Created {
            return Err(Error::InvalidState);
        }

        // State Transition
        package.status = PackageStatus::Cancelled;
        env.storage().persistent().set(&key, &package);

        // Unlock funds (return to pool)
        Self::decrement_locked(&env, &package.token, package.amount);

        // Transition aggregate totals: Created → Cancelled (counts as expired/cancelled)
        Self::add_to_status_totals(
            &env,
            &package.token,
            PackageStatus::Created,
            -package.amount,
        );
        Self::add_to_status_totals(
            &env,
            &package.token,
            PackageStatus::Cancelled,
            package.amount,
        );

        let timestamp = env.ledger().timestamp();
        PackageRevoked {
            package_id: id,
            recipient: package.recipient.clone(),
            amount: package.amount,
            actor: admin.clone(),
            timestamp,
        }
        .publish(&env);

        Ok(())
    }

    pub fn refund(env: Env, id: u64) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        let key = (symbol_short!("pkg"), id);
        let mut package: Package = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PackageNotFound)?;

        // Only a `Created` package still holds its amount in KEY_TOTAL_LOCKED.
        // A package auto-expired on the claim path has already had its locked
        // funds released and its aggregates moved, so it must NOT be unlocked
        // again here (that would double-decrement). Cancelled packages were
        // already unlocked in `revoke`.
        let should_unlock_locked = package.status == PackageStatus::Created;

        // Capture whether the package was in Created status before any mutations.
        // Packages already in Expired or Cancelled are already counted in
        // expired_cancelled and do not need aggregate adjustments.
        let was_committed = package.status == PackageStatus::Created;

        if package.status == PackageStatus::Created {
            // Check if actually expired
            if package.expires_at > 0 && env.ledger().timestamp() > package.expires_at {
                package.status = PackageStatus::Expired;
            } else {
                return Err(Error::InvalidState);
            }
        } else if package.status == PackageStatus::Claimed
            || package.status == PackageStatus::Refunded
        {
            return Err(Error::InvalidState);
        }

        // Cancelled packages were already unlocked in `revoke`; auto-expired
        // packages were already unlocked in `expire_if_past_due`. Only a
        // `Created` package is unlocked here (see `should_unlock_locked`).

        // Transfer Contract -> Admin
        Self::transfer_token(
            &env,
            &package.token,
            &env.current_contract_address(),
            &admin,
            &package.amount,
        )?;

        if should_unlock_locked {
            Self::decrement_locked(&env, &package.token, package.amount);
        }

        // State Transition
        package.status = PackageStatus::Refunded;
        env.storage().persistent().set(&key, &package);

        // Transition aggregate totals: if the package was Committed, move it to expired/cancelled.
        if was_committed {
            Self::add_to_status_totals(
                &env,
                &package.token,
                PackageStatus::Created,
                -package.amount,
            );
            Self::add_to_status_totals(
                &env,
                &package.token,
                PackageStatus::Refunded,
                package.amount,
            );
        }

        let timestamp = env.ledger().timestamp();
        PackageRefunded {
            package_id: id,
            recipient: package.recipient.clone(),
            amount: package.amount,
            actor: admin.clone(),
            timestamp,
        }
        .publish(&env);

        Ok(())
    }

    /// Admin-only package cancellation.
    /// Requirements: Admin auth, existing package, status must be 'Created'.
    pub fn cancel_package(env: Env, package_id: u64) -> Result<(), Error> {
        // 1. Only the admin can cancel (check stored admin and require_auth)
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        // 2. Package must exist
        let key = (symbol_short!("pkg"), package_id);
        let mut package: Package = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PackageNotFound)?;

        // 3. Package status must be Created (not Claimed, Expired, or already Cancelled)
        if package.status != PackageStatus::Created {
            return Err(Error::PackageNotActive);
        }

        // Additional check: Ensure it hasn't expired yet (consistent with 'claim' logic)
        if package.expires_at > 0 && env.ledger().timestamp() > package.expires_at {
            return Err(Error::PackageExpired);
        }

        // 4. Update status to Cancelled and persist
        package.status = PackageStatus::Cancelled;
        env.storage().persistent().set(&key, &package);

        // 5. Unlock funds (Decrement the global locked amount so funds return to the pool)
        Self::decrement_locked(&env, &package.token, package.amount);

        // Transition aggregate totals: Created → Cancelled (counts as expired/cancelled)
        Self::add_to_status_totals(
            &env,
            &package.token,
            PackageStatus::Created,
            -package.amount,
        );
        Self::add_to_status_totals(
            &env,
            &package.token,
            PackageStatus::Cancelled,
            package.amount,
        );

        let timestamp = env.ledger().timestamp();
        PackageRevoked {
            package_id,
            recipient: package.recipient.clone(),
            amount: package.amount,
            actor: admin.clone(),
            timestamp,
        }
        .publish(&env);

        Ok(())
    }

    /// Admin-only package expiration extension.
    /// Requirements: Admin auth, existing package, status must be 'Created', additional_time > 0.
    /// Behavior: Adds additional_time to the package's expires_at timestamp.
    /// Cannot extend unbounded packages (expires_at == 0).
    pub fn extend_expiration(env: Env, package_id: u64, additional_time: u64) -> Result<(), Error> {
        if additional_time == 0 {
            return Err(Error::InvalidAmount);
        }

        let package = Self::get_package(env.clone(), package_id)?;
        if package.expires_at == 0 {
            return Err(Error::InvalidState);
        }

        Self::extend_expiry(env, package_id, package.expires_at + additional_time)
    }

    /// Admin-only package expiration extension using an absolute target timestamp.
    /// Requirements: admin auth, existing package, package still active, and `new_expires_at`
    /// must strictly increase the current expiry while respecting config safety limits.
    pub fn extend_expiry(env: Env, id: u64, new_expires_at: u64) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();
        let config = Self::get_config(env.clone());

        let key = (symbol_short!("pkg"), id);
        let mut package: Package = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PackageNotFound)?;

        if package.status != PackageStatus::Created {
            return Err(Error::PackageNotActive);
        }

        if package.expires_at == 0 {
            return Err(Error::InvalidState);
        }

        let now = env.ledger().timestamp();
        if now > package.expires_at {
            return Err(Error::PackageExpired);
        }

        let old_expires_at = package.expires_at;
        if new_expires_at <= old_expires_at {
            return Err(Error::InvalidState);
        }

        if config.max_expires_in > 0
            && (new_expires_at <= now || new_expires_at - now > config.max_expires_in)
        {
            return Err(Error::InvalidState);
        }

        package.expires_at = new_expires_at;
        env.storage().persistent().set(&key, &package);

        ExtendedEvent {
            id,
            admin,
            old_expires_at,
            new_expires_at,
        }
        .publish(&env);

        Ok(())
    }

    /// Admin-only function to withdraw surplus (unallocated) funds from the contract.
    /// Requirements: Admin auth, valid amount, sufficient surplus available.
    /// Behavior: Transfers amount of token from contract to the specified address.
    pub fn withdraw_surplus(
        env: Env,
        to: Address,
        amount: i128,
        token: Address,
    ) -> Result<(), Error> {
        Self::check_action_paused(&env, symbol_short!("withdraw"))?;
        // 1. Only the admin can withdraw surplus
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        // 2. Validate amount
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // 3. Get contract's current balance for the token. The min decimals
        //    policy is sourced from the active config so staking withdrawals on
        //    low-decimal tokens can be restricted just like funding and
        //    package creation.
        let config = Self::get_config(env.clone());
        Self::validate_token(&env, &token, config.min_decimals)?;
        let contract_balance = Self::token_balance(&env, &token, &env.current_contract_address())?;

        // 4. Get total locked amount for the token
        let locked_map: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&KEY_TOTAL_LOCKED)
            .unwrap_or(Map::new(&env));
        let total_locked = locked_map.get(token.clone()).unwrap_or(0);

        // 5. Calculate available surplus and validate
        let available_surplus = contract_balance - total_locked;
        if amount > available_surplus {
            return Err(Error::InsufficientSurplus);
        }

        // 6. Transfer funds from contract to recipient
        Self::transfer_token(&env, &token, &env.current_contract_address(), &to, &amount)?;

        // 7. Emit event
        SurplusWithdrawnEvent {
            to: to.clone(),
            token: token.clone(),
            amount,
        }
        .publish(&env);

        Ok(())
    }

    // --- Helpers ---

    fn check_action_paused(env: &Env, action: Symbol) -> Result<(), Error> {
        if env.storage().instance().get(&KEY_PAUSED).unwrap_or(false) {
            return Err(Error::ContractPaused);
        }

        let key = match Self::get_pause_key(action) {
            Ok(k) => k,
            Err(_) => return Ok(()),
        };

        if env.storage().instance().get(&key).unwrap_or(false) {
            return Err(Error::ContractPaused);
        }
        Ok(())
    }

    fn get_pause_key(action: Symbol) -> Result<Symbol, Error> {
        if action == symbol_short!("create") {
            Ok(KEY_PAUSE_CREATE)
        } else if action == symbol_short!("claim") {
            Ok(KEY_PAUSE_CLAIM)
        } else if action == symbol_short!("withdraw") {
            Ok(KEY_PAUSE_WITHDRAW)
        } else {
            Err(Error::InvalidState)
        }
    }

    fn decrement_locked(env: &Env, token: &Address, amount: i128) {
        let mut locked_map: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&KEY_TOTAL_LOCKED)
            .unwrap_or(Map::new(env));

        let current = locked_map.get(token.clone()).unwrap_or(0);
        let new_locked = if current > amount {
            current - amount
        } else {
            0
        };

        locked_map.set(token.clone(), new_locked);
        env.storage().instance().set(&KEY_TOTAL_LOCKED, &locked_map);
    }

    /// Permissionless. Idempotently transitions a past-due `Created` package
    /// to `Expired`, releasing its locked funds and moving its aggregate totals
    /// from `Created` to the expired/cancelled bucket.
    ///
    /// Returns `Ok` whether the package was expired, is still claimable, or was
    /// already in a terminal state (idempotent). The transition must be a
    /// successful call because Soroban reverts storage writes when a function
    /// returns an error, so a late `claim` cannot both transition the package
    /// and return `Error::PackageExpired` in the same invocation.
    pub fn expire_if_past_due(env: Env, id: u64) -> Result<(), Error> {
        let key = (symbol_short!("pkg"), id);
        let mut package: Package = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PackageNotFound)?;

        let now = env.ledger().timestamp();

        // `expires_at == 0` means the package never expires.
        if package.expires_at == 0 || now <= package.expires_at {
            return Ok(());
        }
        // Only a `Created` package can transition; an already-terminal package
        // has either been paid out or already released its funds.
        if package.status != PackageStatus::Created {
            return Ok(());
        }

        package.status = PackageStatus::Expired;
        env.storage().persistent().set(&key, &package);

        Self::decrement_locked(&env, &package.token, package.amount);
        Self::add_to_status_totals(
            &env,
            &package.token,
            PackageStatus::Created,
            -package.amount,
        );
        Self::add_to_status_totals(&env, &package.token, PackageStatus::Expired, package.amount);

        Ok(())
    }

    /// Validates a token contract against the configured decimals policy.
    ///
    /// # Behaviour
    /// - Calls the token's `decimals()` via `try_invoke_contract`.
    /// - If the call fails or returns a malformed value (RPC / decoder
    ///   failure) → `Error::InvalidToken`.
    /// - If `decimals < min_decimals` or `decimals > MAX_TOKEN_DECIMALS` →
    ///   `Error::InvalidTokenDecimals`.
    /// - Otherwise returns the decoded decimals value.
    ///
    /// `min_decimals` is passed in (rather than read from storage inside this
    /// function) so callers like `set_config` validate against the *new*
    /// config being submitted instead of stale on-chain state.
    fn validate_token(env: &Env, token: &Address, min_decimals: u32) -> Result<u32, Error> {
        let args: Vec<Val> = Vec::new(env);

        match env.try_invoke_contract::<u32, Error>(token, &symbol_short!("decimals"), args) {
            Ok(Ok(decimals)) => {
                if decimals < min_decimals || decimals > MAX_TOKEN_DECIMALS {
                    Err(Error::InvalidTokenDecimals)
                } else {
                    Ok(decimals)
                }
            }
            _ => Err(Error::InvalidToken),
        }
    }

    fn token_balance(env: &Env, token: &Address, account: &Address) -> Result<i128, Error> {
        let mut args: Vec<Val> = Vec::new(env);
        args.push_back(account.clone().into_val(env));

        match env.try_invoke_contract::<i128, Error>(token, &symbol_short!("balance"), args) {
            Ok(Ok(balance)) => Ok(balance),
            _ => Err(Error::InvalidToken),
        }
    }

    fn transfer_token(
        env: &Env,
        token: &Address,
        from: &Address,
        to: &Address,
        amount: &i128,
    ) -> Result<(), Error> {
        let mut args: Vec<Val> = Vec::new(env);
        args.push_back(from.clone().into_val(env));
        args.push_back(to.clone().into_val(env));
        args.push_back((*amount).into_val(env));

        match env.try_invoke_contract::<(), Error>(token, &symbol_short!("transfer"), args) {
            Ok(Ok(())) => Ok(()),
            _ => Err(Error::TokenTransferFailed),
        }
    }

    fn resolve_claim_starts_at(
        env: &Env,
        metadata: &Map<Symbol, String>,
        created_at: u64,
    ) -> Result<u64, Error> {
        let key = Symbol::new(env, "claim_starts_at");
        match metadata.get(key) {
            Some(raw) => Self::parse_u64(raw).ok_or(Error::InvalidState),
            None => Ok(created_at),
        }
    }

    fn parse_u64(value: String) -> Option<u64> {
        let len = value.len() as usize;
        if len == 0 || len > 20 {
            return None;
        }

        let mut bytes = [0u8; 20];
        value.copy_into_slice(&mut bytes[..len]);

        let mut out: u64 = 0;
        for b in bytes[..len].iter() {
            if !b.is_ascii_digit() {
                return None;
            }
            out = out.checked_mul(10)?.checked_add((b - b'0') as u64)?;
        }

        Some(out)
    }

    fn finalize_claim(
        env: &Env,
        key: &(Symbol, u64),
        package: &mut Package,
        package_id: u64,
        payout_recipient: &Address,
        actor: &Address,
        now: u64,
    ) -> Result<(), Error> {
        Self::transfer_token(
            env,
            &package.token,
            &env.current_contract_address(),
            payout_recipient,
            &package.amount,
        )?;

        // State Transition
        package.status = PackageStatus::Claimed;
        env.storage().persistent().set(key, package);

        // Update Global Locked (Bookkeeping)
        Self::decrement_locked(env, &package.token, package.amount);

        // Transition aggregate totals: Created → Claimed
        Self::add_to_status_totals(env, &package.token, PackageStatus::Created, -package.amount);
        Self::add_to_status_totals(env, &package.token, PackageStatus::Claimed, package.amount);

        // A claimed package is terminal: drop any registered delegate so it
        // can never be (re)assigned after funds move, and record the removal
        // in the delegate audit trail (no-op when no delegate was set).
        delegate::clear_delegate(env, package_id, actor);

        PackageClaimed {
            package_id,
            recipient: payout_recipient.clone(),
            amount: package.amount,
            actor: actor.clone(),
            timestamp: now,
        }
        .publish(env);

        Ok(())
    }

    fn merkle_root_from_metadata(env: &Env, metadata: &Map<Symbol, String>) -> Option<[u8; 32]> {
        let root_key = Symbol::new(env, META_MERKLE_ROOT_KEY);
        metadata
            .get(root_key)
            .and_then(|hex| Self::parse_hex_32(&hex))
    }

    /// Reads the optional `merkle_root_expires_at` metadata field.
    /// Returns `0` (never expires) when absent or unparseable.
    fn merkle_root_expires_at_from_metadata(env: &Env, metadata: &Map<Symbol, String>) -> u64 {
        let key = Symbol::new(env, META_MERKLE_ROOT_EXPIRES_AT_KEY);
        match metadata.get(key) {
            Some(raw) => Self::parse_u64(raw).unwrap_or(0),
            None => 0,
        }
    }

    /// Reads the optional `merkle_leaf_version` metadata field.
    /// Returns `"v1"` (address-only, legacy) when absent.
    fn merkle_leaf_version_from_metadata(env: &Env, metadata: &Map<Symbol, String>) -> String {
        let key = Symbol::new(env, META_MERKLE_LEAF_VERSION_KEY);
        metadata
            .get(key)
            .unwrap_or_else(|| String::from_str(env, "v1"))
    }

    #[allow(clippy::too_many_arguments)]
    fn verify_merkle_proof_for_claimant(
        env: &Env,
        claimant: &Address,
        proof: &Vec<String>,
        expected_root: [u8; 32],
        expires_at: u64,
        now: u64,
        leaf_version: &String,
        amount: i128,
    ) -> Result<(), Error> {
        // Reject stale-but-active roots before doing any proof work. An
        // expiry of 0 means the allowlist never expires (legacy packages).
        if expires_at > 0 && expires_at <= now {
            return Err(Error::AllowlistExpired);
        }

        let v2 = String::from_str(env, "v2");
        let is_v2 = leaf_version == &v2;
        let mut current = if is_v2 {
            Self::hash_leaf_v2(env, claimant, amount)
        } else {
            Self::hash_address(env, claimant)
        };

        for i in 0..proof.len() {
            let sibling_hex = match proof.get(i) {
                Some(v) => v,
                None => return Err(Error::InvalidProof),
            };

            let sibling = match Self::parse_hex_32(&sibling_hex) {
                Some(v) => v,
                None => return Err(Error::InvalidProof),
            };

            current = if current <= sibling {
                Self::hash_pair(env, &current, &sibling)
            } else {
                Self::hash_pair(env, &sibling, &current)
            };
        }

        if current == expected_root {
            Ok(())
        } else {
            Err(Error::InvalidProof)
        }
    }

    fn hash_address(env: &Env, address: &Address) -> [u8; 32] {
        let addr = address.to_string();
        let len = addr.len() as usize;
        let mut raw = [0u8; 96];
        addr.copy_into_slice(&mut raw[..len]);

        let mut data = Bytes::new(env);
        for b in raw[..len].iter() {
            data.push_back(*b);
        }

        let digest = env.crypto().sha256(&data);
        Self::hash_to_array(&digest)
    }

    /// v2 leaf: sha256(address_string || amount_big_endian_bytes).
    ///
    /// The amount is encoded as a big-endian i128 (16 bytes).  This binds the
    /// leaf to both the recipient *and* the specific package amount, so a single
    /// merkle root can authorise different amounts for different recipients.
    fn hash_leaf_v2(env: &Env, address: &Address, amount: i128) -> [u8; 32] {
        let addr = address.to_string();
        let addr_len = addr.len() as usize;

        // Encode amount as big-endian i128 (16 bytes).
        let amount_bytes = amount.to_be_bytes();

        let mut raw = [0u8; 112]; // 96 for address + 16 for amount
        addr.copy_into_slice(&mut raw[..addr_len]);
        raw[addr_len..addr_len + 16].copy_from_slice(&amount_bytes);

        let mut data = Bytes::new(env);
        for b in raw[..addr_len + 16].iter() {
            data.push_back(*b);
        }

        let digest = env.crypto().sha256(&data);
        Self::hash_to_array(&digest)
    }

    fn hash_pair(env: &Env, left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
        let mut data = Bytes::new(env);
        for b in left.iter() {
            data.push_back(*b);
        }
        for b in right.iter() {
            data.push_back(*b);
        }

        let digest = env.crypto().sha256(&data);
        Self::hash_to_array(&digest)
    }

    fn hash_to_array(value: &soroban_sdk::crypto::Hash<32>) -> [u8; 32] {
        value.to_array()
    }

    fn parse_hex_32(value: &String) -> Option<[u8; 32]> {
        let len = value.len() as usize;
        if len != 64 {
            return None;
        }

        let mut raw = [0u8; 64];
        value.copy_into_slice(&mut raw);

        let mut out = [0u8; 32];
        let mut i = 0usize;
        while i < 32 {
            let hi = Self::hex_nibble(raw[i * 2])?;
            let lo = Self::hex_nibble(raw[i * 2 + 1])?;
            out[i] = (hi << 4) | lo;
            i += 1;
        }

        Some(out)
    }

    fn hex_nibble(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(10 + (b - b'a')),
            b'A'..=b'F' => Some(10 + (b - b'A')),
            _ => None,
        }
    }

    /// Updates the running per-token status totals in constant time.
    ///
    /// Maps `PackageStatus::Created` → `KEY_TOTAL_COMMITTED`,
    /// `PackageStatus::Claimed` → `KEY_TOTAL_CLAIMED`, and
    /// `Expired | Cancelled | Refunded` → `KEY_TOTAL_EXPIRED_CANCELLED`.
    /// A negative `amount` subtracts from the total (clamped at zero).
    fn add_to_status_totals(env: &Env, token: &Address, status: PackageStatus, amount: i128) {
        let key = match status {
            PackageStatus::Created => KEY_TOTAL_COMMITTED,
            PackageStatus::Claimed => KEY_TOTAL_CLAIMED,
            PackageStatus::Expired | PackageStatus::Cancelled | PackageStatus::Refunded => {
                KEY_TOTAL_EXPIRED_CANCELLED
            }
        };

        if amount == 0 {
            return;
        }

        let mut map: Map<Address, i128> =
            env.storage().instance().get(&key).unwrap_or(Map::new(env));

        let current = map.get(token.clone()).unwrap_or(0);

        if amount > 0 {
            map.set(token.clone(), current + amount);
        } else {
            let abs_amount = -amount;
            let new_total = if current > abs_amount {
                current - abs_amount
            } else {
                0
            };
            map.set(token.clone(), new_total);
        }

        env.storage().instance().set(&key, &map);
    }

    /// Returns the total amount currently locked for a specific token.
    pub fn get_total_locked(env: Env, token: Address) -> i128 {
        let locked_map: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&KEY_TOTAL_LOCKED)
            .unwrap_or(Map::new(&env));
        locked_map.get(token).unwrap_or(0)
    }

    /// Returns the cumulative amount ever claimed for a specific token.
    pub fn get_total_claimed(env: Env, token: Address) -> i128 {
        let claimed_map: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&KEY_TOTAL_CLAIMED)
            .unwrap_or(Map::new(&env));
        claimed_map.get(token).unwrap_or(0)
    }

    fn require_admin_or_distributor(env: &Env, operator: &Address) -> Result<(), Error> {
        operator.require_auth();

        let admin = Self::get_admin(env.clone())?;
        if *operator == admin {
            return Ok(());
        }

        let distributors: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&KEY_DISTRIBUTORS)
            .unwrap_or(Map::new(env));
        if distributors.get(operator.clone()).unwrap_or(false) {
            Ok(())
        } else {
            Err(Error::NotAuthorized)
        }
    }

    /// Retrieves the full details of a package by its ID.
    ///
    /// # Errors
    /// Returns `Error::PackageNotFound` if no package exists with the given `id`.
    pub fn get_package(env: Env, id: u64) -> Result<Package, Error> {
        let key = (symbol_short!("pkg"), id);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(Error::PackageNotFound)
    }

    /// Returns only the status of a package.
    /// Cheaper alternative to get_package for polling frontends.
    pub fn view_package_status(env: Env, id: u64) -> Result<PackageStatus, Error> {
        let pkg = Self::get_package(env, id)?;
        Ok(pkg.status)
    }

    // --- Analytics ---

    /// Returns aggregate statistics for a given token in constant time.
    ///
    /// Running totals are maintained incrementally at every status transition
    /// via `add_to_status_totals`, so this read never iterates over packages.
    pub fn get_aggregates(env: Env, token: Address) -> Aggregates {
        let committed_map: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&KEY_TOTAL_COMMITTED)
            .unwrap_or(Map::new(&env));

        let claimed_map: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&KEY_TOTAL_CLAIMED)
            .unwrap_or(Map::new(&env));

        let expired_cancelled_map: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&KEY_TOTAL_EXPIRED_CANCELLED)
            .unwrap_or(Map::new(&env));

        Aggregates {
            total_committed: committed_map.get(token.clone()).unwrap_or(0),
            total_claimed: claimed_map.get(token.clone()).unwrap_or(0),
            total_expired_cancelled: expired_cancelled_map.get(token).unwrap_or(0),
        }
    }

    /// Returns the number of stored packages assigned to `recipient`.
    ///
    /// O(1): reads the per-recipient counter maintained by
    /// [`index_recipient_package`], so the cost is independent of the global
    /// package counter and of how many packages other recipients own.
    pub fn get_recipient_package_count(env: Env, recipient: Address) -> u64 {
        let count_map: Map<Address, u64> = env
            .storage()
            .instance()
            .get(&KEY_RECIPIENT_COUNT)
            .unwrap_or(Map::new(&env));
        count_map.get(recipient).unwrap_or(0)
    }

    /// Lists package IDs for a specific recipient with pagination.
    ///
    /// Enumerates the recipient's secondary index, so pages contain only that
    /// recipient's packages (no skipped matches and no empty pages while
    /// matches remain), regardless of how large the global ID space is.
    ///
    /// # Arguments
    /// * `recipient` - The address to filter packages by
    /// * `cursor` - Per-recipient index ordinal of the first package to return
    ///   (the `next_cursor` from the previous page, or `0` for the first page)
    /// * `limit` - Maximum number of results to return; clamped to
    ///   [`MAX_RECIPIENT_PAGE_SIZE`]
    ///
    /// # Returns
    /// A [`RecipientPackagesPage`] containing up to `limit` package IDs and a
    /// `next_cursor` for the following page. When `next_cursor` equals the
    /// recipient's total package count, no further pages exist.
    pub fn list_recipient_packages(
        env: Env,
        recipient: Address,
        cursor: u64,
        limit: u32,
    ) -> RecipientPackagesPage {
        let count = Self::get_recipient_package_count(env.clone(), recipient.clone());
        let limit = u64::from(limit.min(MAX_RECIPIENT_PAGE_SIZE));
        let mut ids: Vec<u64> = Vec::new(&env);

        let next_cursor = if cursor >= count {
            // Exhausted: nothing to return, and report the end so the caller
            // can stop paginating.
            count
        } else {
            let end = cursor.saturating_add(limit).min(count);
            for seq in cursor..end {
                let idx_key = (KEY_RECIPIENT_IDX, recipient.clone(), seq);
                if let Some(id) = env.storage().instance().get::<_, u64>(&idx_key) {
                    ids.push_back(id);
                }
            }
            end
        };

        RecipientPackagesPage { ids, next_cursor }
    }

    /// Appends `package_id` to `recipient`'s secondary index.
    ///
    /// Writes one instance-storage entry `(KEY_RECIPIENT_IDX, recipient, seq)`
    /// and bumps the per-recipient counter. Called from every package-creation
    /// path so the index is always consistent with `(pkg, id)` records; a
    /// failed creation reverts the whole transaction, so no orphan entries can
    /// be observed.
    fn index_recipient_package(env: &Env, recipient: &Address, package_id: u64) {
        let mut count_map: Map<Address, u64> = env
            .storage()
            .instance()
            .get(&KEY_RECIPIENT_COUNT)
            .unwrap_or(Map::new(env));
        let seq = count_map.get(recipient.clone()).unwrap_or(0);

        let idx_key = (KEY_RECIPIENT_IDX, recipient.clone(), seq);
        env.storage().instance().set(&idx_key, &package_id);

        count_map.set(recipient.clone(), seq + 1);
        env.storage()
            .instance()
            .set(&KEY_RECIPIENT_COUNT, &count_map);
    }
}

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::token::{StellarAssetClient, TokenClient};
    use soroban_sdk::{symbol_short, Address, Env, Map};

    fn setup() -> (Env, AidEscrowClient<'static>) {
        let env = Env::default();
        // Set a fixed timestamp to avoid 0-timestamp edge cases
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let contract_id = env.register(AidEscrow, ());
        let client = AidEscrowClient::new(&env, &contract_id);
        (env, client)
    }

    fn setup_token(
        env: &Env,
        admin: &Address,
    ) -> (Address, StellarAssetClient<'static>, TokenClient<'static>) {
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let token = token_id.address();
        let sac = StellarAssetClient::new(env, &token);
        let token_client = TokenClient::new(env, &token);

        // Standard Stellar Assets in Soroban tests default to 7 decimals.
        // Our test amounts (like 5,000,000) are multiples of 10^6 and 10^7,
        // so they will pass the dynamic check in the refactored fund method.

        (token, sac, token_client)
    }

    #[test]
    fn test_cancel_package() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token, sac, _) = setup_token(&env, &admin);

        env.mock_all_auths();
        client.init(&admin);

        // Corrected fund amount (1.0 units)
        let amount = 10_000_000;

        sac.mint(&admin, &20_000_000);
        client.fund(&token, &admin, &amount);

        let package_metadata = Map::new(&env);
        let package_id = client.create_package(
            &admin,
            &1,
            &recipient,
            &10_000_000, // <--- CHANGED THIS from 1_000_000 to 10_000_000
            &token,
            &86400,
            &package_metadata,
        );

        client.cancel_package(&package_id);
        let package = client.get_package(&package_id);
        assert_eq!(package.status, PackageStatus::Cancelled);
    }

    #[test]
    fn test_list_recipient_packages_few_packages() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let recipient1 = Address::generate(&env);
        let (token, sac, _) = setup_token(&env, &admin);

        env.mock_all_auths();
        client.init(&admin);

        // Using multiples of 10^7 (1.0 units) for 7-decimal test tokens
        sac.mint(&admin, &50_000_000);
        client.fund(&token, &admin, &40_000_000);

        let empty_metadata = Map::new(&env);
        client.create_package(
            &admin,
            &1,
            &recipient1,
            &10_000_000,
            &token,
            &86400,
            &empty_metadata,
        );
        client.create_package(
            &admin,
            &2,
            &recipient1,
            &20_000_000,
            &token,
            &86400,
            &empty_metadata,
        );

        let packages = client.list_recipient_packages(&recipient1, &0, &10);
        assert_eq!(packages.ids.len(), 2);
        assert_eq!(packages.next_cursor, 2);
    }

    #[test]
    fn test_list_recipient_packages_pagination() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token, sac, _) = setup_token(&env, &admin);

        env.mock_all_auths();
        client.init(&admin);

        sac.mint(&admin, &100_000_000);
        client.fund(&token, &admin, &100_000_000);

        let mut package_ids = soroban_sdk::Vec::new(&env);
        for i in 0..5 {
            package_ids.push_back(client.create_package(
                &admin,
                &(i as u64),
                &recipient,
                &10_000_000,
                &token,
                &86400,
                &Map::new(&env),
            ));
        }

        let page = client.list_recipient_packages(&recipient, &0, &3);
        assert_eq!(page.ids.len(), 3);
        assert_eq!(page.next_cursor, 3);
    }

    #[test]
    fn test_action_specific_pause() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);
        let (token, sac, _) = setup_token(&env, &admin);

        env.mock_all_auths();
        client.init(&admin);
        sac.mint(&admin, &20_000_000);
        client.fund(&token, &admin, &10_000_000);

        client.pause_action(&symbol_short!("create"));

        let result = client.try_create_package(
            &admin,
            &99,
            &recipient,
            &10_000_000,
            &token,
            &86400,
            &Map::new(&env),
        );
        assert!(result.is_err());
    }
}

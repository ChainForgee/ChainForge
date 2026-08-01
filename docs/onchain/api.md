# Onchain API Reference

ChainForge onchain contracts, deployed on Stellar Soroban.

## Contracts

### AidEscrow

**Contract ID (Testnet):** `CDSBJ27PKTNFTRW6OKPCVXDRUSSRUIQUG6DW5PUTKLDXTDT23NQIS6JG`

Full contract documentation: [`app/onchain/contracts/aid_escrow/README.md`](../../app/onchain/contracts/aid_escrow/README.md)

#### Admin & Config

| Function | Auth | Description |
|---|---|---|
| `init(env, admin)` | None (once) | Initializes the contract with an admin address and default config. |
| `get_admin(env)` | — | Returns the current admin address. |
| `get_version(env)` | — | Returns the current contract version. |
| `migrate(env, new_version)` | Admin | Performs version-specific migrations. |
| `add_distributor(env, addr)` | Admin | Grants distributor privileges to an address. |
| `remove_distributor(env, addr)` | Admin | Revokes distributor privileges. |
| `get_distributor_list(env)` | — | Returns a sorted list of registered distributor addresses. |
| `set_config(env, config)` | Admin | Updates contract configuration. |
| `get_config(env)` | — | Returns the current config. |
| `pause(env)` | Admin | Pauses the contract. |
| `unpause(env)` | Admin | Unpauses the contract. |
| `is_paused(env)` | — | Returns true if the contract is paused. |

#### Funding & Packages

| Function | Auth | Description |
|---|---|---|
| `fund(env, token, from, amount)` | Funder | Transfers tokens into the contract balance. |
| `create_package(env, operator, id, recipient, amount, token, expires_at, metadata)` | Admin / Distributor | Creates a single aid package. |
| `batch_create_packages(env, operator, recipients, amounts, token, expires_in, metadatas)` | Admin / Distributor | Creates multiple packages in one transaction. |
| `claim(env, id)` | Recipient | Recipient claims the package. |
| `claim_with_proof(env, id, claimant, proof)` | Claimant | Claim with Merkle allowlist proof. |
| `disburse(env, id)` | Admin | Admin manually disburses a package. |
| `revoke(env, id)` | Admin | Admin revokes a package. |
| `refund(env, id)` | Admin | Refunds an expired/cancelled package. |
| `cancel_package(env, package_id)` | Admin | Cancels a package. |
| `extend_expiration(env, package_id, additional_time)` | Admin | Extends expiration time. |

#### Queries

| Function | Auth | Description |
|---|---|---|
| `get_package(env, id)` | — | Returns full package details. |
| `view_package_status(env, id)` | — | Returns only package status. |
| `get_aggregates(env, token)` | — | Returns aggregate stats for a token. |
| `get_total_locked(env, token)` | — | Returns total locked amount for a token. |
| `get_total_claimed(env, token)` | — | Returns total claimed amount for a token. |
| `get_recipient_package_count(env, recipient)` | — | Returns package count for a recipient. |
| `list_recipient_packages(env, recipient, cursor, limit)` | — | Paginated list of recipient package IDs. |
| `withdraw_surplus(env, to, amount, token)` | Admin | Withdraws surplus (unlocked) tokens. |

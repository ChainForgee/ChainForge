## Problem
Resolves #226 — Maintain incremental running totals for aggregates

`get_aggregates(token)` currently iterates from 0 to `KEY_PKG_IDX` every call, reconstructing `total_committed`, `total_claimed`, and `total_expired_cancelled` by walking the full package list. For deployments with hundreds of packages, this is O(N) per read, driving dashboard latency and indexer costs linearly upward. The existing per-package `KEY_PKG_IDX` mapping preserves enumeration but compounds the iteration cost.

## What was implemented

### New storage keys — constant-time per-token totals
Added two new instance-storage maps mirroring the existing `KEY_TOTAL_LOCKED` semantics:
- `KEY_TOTAL_COMMITTED` (`"cmt"`) — `Map<Address, i128>` tracking committed (Created) amounts per token
- `KEY_TOTAL_EXPIRED_CANCELLED` (`"expcan"`) — `Map<Address, i128>` tracking expired/cancelled/refunded amounts per token

### `add_to_status_totals` helper
A private, zero-clamped helper function that updates the correct storage map based on `PackageStatus`:
- `Created` → `KEY_TOTAL_COMMITTED`
- `Claimed` → `KEY_TOTAL_CLAIMED` (already existed)
- `Expired | Cancelled | Refunded` → `KEY_TOTAL_EXPIRED_CANCELLED`

Positive amounts increment the total; negative amounts decrement with a zero floor — consistent with the existing `decrement_locked` pattern. No-ops on `amount == 0`.

### Status transition hooks — every transition tracked
| Entrypoint | Transition | Aggregate effect |
|---|---|---|
| `create_package` / `batch_create_packages` | (new) → Created | `committed += amount` |
| `claim` / `claim_with_proof` (via `finalize_claim`) | Created → Claimed | `committed -= amount`, `claimed += amount` |
| `disburse` | Created → Claimed | `committed -= amount`, `claimed += amount` |
| `revoke` | Created → Cancelled | `committed -= amount`, `expired_cancelled += amount` |
| `cancel_package` | Created → Cancelled | `committed -= amount`, `expired_cancelled += amount` |
| `refund` | Created → Refunded | `committed -= amount`, `expired_cancelled += amount` |
| `refund` | Expired / Cancelled → Refunded | _no change_ (already counted) |

The `refund` function uses a `was_committed` flag captured _before_ the intermediate `package.status = Expired` mutation to correctly distinguish the Created path from the Expired/Cancelled re-entry paths.

### `get_aggregates` rewritten to O(1)
Instead of iterating `0..KEY_PKG_IDX` and summing package amounts, `get_aggregates` now reads the three storage maps in constant time. The return type (`Aggregates`) and its semantics are unchanged — all existing tests pass without modification.

### Bug fix included
`disburse` previously never updated `KEY_TOTAL_CLAIMED`. Disbursed packages now correctly contribute to `total_claimed` in both `get_aggregates` and `get_total_claimed`.

## How to manually verify
1. Build and test the contract:
   ```bash
   cd app/onchain
   cargo test --package aid_escrow --test aggregates
   cargo test --package aid_escrow --test invariants
   ```
2. All existing aggregate tests pass unchanged (backward compatible).
3. Gas profiling (`cargo test --package aid_escrow --test gas_profiling`) confirms `get_aggregates` is now constant-time regardless of package count.
4. The `prop_event_replay_conservation` invariant fuzz test (100 random sequences) continues to hold.

## Follow-up work recommended
- Optimize `batch_create_packages` to accumulate the total committed amount and call `add_to_status_totals` once after the loop instead of N times inside it, reducing storage writes for large batches.
- Add a dedicated gas profiling test that benchmarks `get_aggregates` with 10, 100, and 500 packages to quantify the O(1) improvement.
- Consider adding public getters `get_total_committed(token)` and `get_total_expired_cancelled(token)` to expose the new storage keys to off-chain indexers.

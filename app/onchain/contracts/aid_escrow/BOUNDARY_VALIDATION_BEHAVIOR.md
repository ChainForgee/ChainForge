# Claim Window and Expiry Boundary Validation Behavior

## Overview

This document describes the expected behavior of claim timing validation on the ChainForge platform, specifically for Testnet ledgers. It covers claim start time boundaries, expiry boundaries, and late-claim expiry-sweep behavior.

## Onchain Contract Behavior (Soroban)

### Claim Timing Validation

The onchain contract enforces the following timing rules:

#### 1. Claim Start Time (`claim_starts_at`)

- **Default Value**: If not specified in metadata, `claim_starts_at` defaults to the package `created_at` timestamp
- **Configuration**: Can be set via package metadata with key `claim_starts_at` (string representation of u64 timestamp)
- **Validation**: 
  - `claim_starts_at` must be >= `created_at`
  - `claim_starts_at` must be <= `expires_at` (if `expires_at > 0`)
- **Claim Validation**: Claim attempts where `now < claim_starts_at` return `Error::ClaimTooEarly`

#### 2. Expiry Time (`expires_at`)

- **Default Value**: Can be set to `0` for packages that never expire
- **Configuration**: Set during package creation
- **Validation**:
  - If `expires_at > 0`, must be > `created_at`
  - Must respect `config.max_expires_in` if configured
- **Claim Validation**: Claim attempts where `expires_at > 0 && now > expires_at` return `Error::PackageExpired` without mutating state

#### 3. Late Claim Behavior

**Important**: When a claim is attempted after expiry, the contract returns `Error::PackageExpired` and leaves the package in `Created`. Soroban reverts all storage writes when a function returns an error, so a claim attempt **cannot** atomically mark the package `Expired` and return an error in the same call.

- **Trigger**: Any claim attempt (`claim()` or `claim_with_proof()`) where `expires_at > 0 && now > expires_at`
- **State Change**: None — package status remains `Created`
- **Error Returned**: `Error::PackageExpired`
- **Expiry sweep**: `expire_if_past_due(id)` is a permissionless entrypoint that transitions a past-due `Created` package to `Expired`, releases its locked funds, and moves its aggregate totals from `Created` to the expired/cancelled bucket. It is idempotent and returns `Ok`.
- **Refund**: `refund(id)` converts an `Expired` (or `Cancelled`) package to `Refunded` and transfers the funds to the admin, without double-releasing locked funds.
- **Persistence**: Because the late claim leaves status `Created`, a time revert to within the window still allows a successful claim; once `expire_if_past_due` has run, the package is permanently `Expired`.

### Boundary Conditions

#### Claim Start Time Boundaries

| Scenario | Timestamp | Expected Result |
|----------|-----------|-----------------|
| Claim 1 second before `claim_starts_at` | `claim_starts_at - 1` | `Error::ClaimTooEarly`, status remains `Created` |
| Claim at exact `claim_starts_at` | `claim_starts_at` | Success, status becomes `Claimed` |
| Claim 1 second after `claim_starts_at` | `claim_starts_at + 1` | Success, status becomes `Claimed` |

#### Expiry Time Boundaries

| Scenario | Timestamp | Expected Result |
|----------|-----------|-----------------|
| Claim 1 second before `expires_at` | `expires_at - 1` | Success, status becomes `Claimed` |
| Claim at exact `expires_at` | `expires_at` | Success, status becomes `Claimed` |
| Claim 1 second after `expires_at` | `expires_at + 1` | `Error::PackageExpired`, status remains `Created` |
| Claim long after `expires_at` | `expires_at + 1000` | `Error::PackageExpired`, status remains `Created` |

#### Combined Boundaries (claim_starts_at == expires_at)

| Scenario | Timestamp | Expected Result |
|----------|-----------|-----------------|
| Claim before boundary | `boundary - 1` | `Error::ClaimTooEarly`, status remains `Created` |
| Claim at exact boundary | `boundary` | Success, status becomes `Claimed` |
| Claim after boundary | `boundary + 1` | `Error::PackageExpired`, status remains `Created` |

### Edge Cases

1. **Zero Expiry (`expires_at = 0`)**: Package never expires, can be claimed at any time after `claim_starts_at`
2. **Zero Claim Window (`claim_starts_at == expires_at`)**: Valid configuration, claim only succeeds at exact boundary timestamp
3. **Late Claim Retry**: Since package status remains `Created` after a late claim attempt, if the ledger time is reverted to within the claim window, the claim can succeed
4. **Invalid Configurations Rejected at Creation**:
   - `claim_starts_at < created_at` → `Error::InvalidState`
   - `claim_starts_at > expires_at` → `Error::InvalidState`

## Backend Behavior (NestJS)

### Claim Expiry Configuration

- **Default Expiry**: 30 days (`DEFAULT_CLAIM_EXPIRY_DAYS = 30`)
- **Configuration**: Set via `CreateClaimDto.expiresAt` or defaults to `Date.now() + 30 days`
- **Storage**: Stored in `Claim.expiresAt` field (Date type)

### Expiry Cleanup Process

The backend runs an automated cleanup process:

- **Schedule**: Hourly cron job (`@Cron(CronExpression.EVERY_HOUR)`)
- **Method**: `ClaimsService.cleanupExpiredClaims()`
- **Eligible Claims**: 
  - Status: `requested` or `verified`
  - `expiresAt < now`
- **Action**: Transitions claim status to `archived`
- **Onchain Cleanup**: If enabled, attempts to revoke and refund the associated onchain package

### Backend vs Onchain Expiry

| Aspect | Backend | Onchain |
|--------|---------|---------|
| Trigger | Cron job (hourly) | `expire_if_past_due(id)` (permissionless) or `refund(id)` |
| Status Change | `requested/verified` → `archived` | `Created` → `Expired` (then `Refunded` on admin refund) |
| Timing | After expiry (batch cleanup) | On demand (any account may sweep) |
| Reversibility | No (archived) | No (permanent) |
| Fund Recovery | Attempts revoke/refund | `refund(id)` transfers funds to admin |

## Frontend Display Behavior

### Package Status Display

The frontend should display package status based on the onchain contract state:

| Status | Display Text | Color/Indicator | User Action |
|--------|--------------|------------------|-------------|
| `Created` | "Available" | Green | Claim button enabled |
| `Claimed` | "Claimed" | Blue | No action available |
| `Expired` | "Expired" | Red/Gray | No action available |
| `Cancelled` | "Cancelled" | Gray | No action available |
| `Refunded` | "Refunded" | Gray | No action available |

### Claim Window Indicators

The frontend should provide visual feedback about claim timing:

1. **Before Claim Start**:
   - Display: "Claim opens in [time]"
   - Claim button: Disabled with tooltip showing start time
   - Countdown timer to `claim_starts_at`

2. **Within Claim Window**:
   - Display: "Claim available"
   - Claim button: Enabled
   - Countdown timer to `expires_at` (if expiry set)

3. **After Expiry**:
   - Display: "Expired"
   - Claim button: Disabled
   - Show expiry timestamp

### Boundary Handling

The frontend should handle boundary conditions gracefully:

1. **Exact Boundary Times**:
   - If `now == claim_starts_at`: Enable claim button immediately
   - If `now == expires_at`: Enable claim button (last chance to claim)

2. **Time Synchronization**:
   - Use onchain ledger timestamp for validation
   - Display local time with timezone indication
   - Show "last updated" timestamp for time-sensitive displays

3. **Auto-Expiry Detection**:
   - Poll package status periodically
   - If status changes from `Created` to `Expired`, update UI immediately
   - Show notification if user was viewing the package when it expired

## Test Coverage

### Onchain Tests

New comprehensive boundary validation tests have been added in `tests/boundary_validation_tests.rs`:

1. **Claim Start Boundaries**:
   - `fails_when_claimed_1_second_before_start`
   - `succeeds_when_claimed_at_exact_start_time`
   - `succeeds_when_claimed_1_second_after_start`

2. **Expiry Boundaries**:
   - `succeeds_when_claimed_1_second_before_expiry`
   - `succeeds_when_claimed_at_exact_expiry`
   - `fails_when_claimed_1_second_after_expiry`
   - `fails_when_claimed_long_after_expiry`

3. **Combined Boundaries**:
   - `fails_when_claim_starts_at_equals_expires_at_and_claimed_before`
   - `succeeds_when_claim_starts_at_equals_expires_at_and_claimed_at_boundary`
   - `fails_when_claim_starts_at_equals_expires_at_and_claimed_after`
   - `narrow_claim_window_1_second`
   - `zero_claim_window_fails_creation`

4. **Late Claim / Expiry Sweep Behavior**:
   - `late_claim_returns_error_without_transitioning`
   - `claim_with_proof_fails_after_expiry_without_transitioning`
   - `expire_if_past_due_transitions_and_moves_accounting`
   - `expire_if_past_due_ignores_never_expiring_and_missing_packages`
   - `refund_after_expiry_does_not_unlock_other_packages`

5. **Edge Cases**:
   - `package_with_zero_expiry_never_expires`
   - `claim_starts_at_in_past_fails_creation`
   - `claim_starts_after_expiry_fails_creation`

### Backend Tests

Existing test coverage includes:
- `cleanupExpiredClaims()` method
- Expiry calculation logic
- Onchain cleanup integration

## Recommendations for Testnet Deployment

### Pre-Deployment Checklist

1. **Verify Boundary Conditions**:
   - Run all boundary validation tests on Testnet
   - Confirm exact boundary behavior matches expectations
   - Test with real ledger timestamps (not just mocked)

2. **Monitor Expiry Sweep**:
   - Deploy a test package with short expiry (e.g., 1 hour)
   - Attempt a claim after expiry and confirm it returns `Error::PackageExpired`
   - Call `expire_if_past_due(id)` and check the package transitions to `Expired` and locked/aggregate totals move

3. **Frontend Integration**:
   - Test claim button enable/disable at exact boundaries
   - Verify countdown timers update correctly
   - Confirm status changes reflect immediately in UI

4. **Backend Cleanup**:
   - Verify cron job runs hourly on Testnet
   - Check that expired claims are archived correctly
   - Confirm onchain revoke/refund works (if enabled)

### Monitoring

After Testnet deployment, monitor:

1. **Claim Success Rate**: Track claims at/near boundaries
2. **Auto-Expiry Events**: Monitor packages transitioning to `Expired`
3. **Backend Cleanup**: Verify expired claims are being archived
4. **Frontend Errors**: Watch for timing-related UI errors

### Known Limitations

1. **Time Synchronization**: Frontend local time may differ from onchain ledger time
2. **Network Latency**: Claim transactions may take time to confirm, potentially crossing boundaries
3. **Cron Job Delay**: Backend cleanup runs hourly, not immediately on expiry

## Conclusion

The claim window and expiry boundary validation is implemented with the following key behaviors:

- **Onchain**: Immediate validation at claim attempt; late claims return `Error::PackageExpired`, and the permissionless `expire_if_past_due(id)` entrypoint performs the `Created → Expired` transition and its accounting
- **Backend**: Batch cleanup of expired claims via hourly cron job
- **Frontend**: Visual indicators and countdown timers for claim windows

The boundary conditions are well-defined and tested. Late claim attempts return `Error::PackageExpired` without mutating state (Soroban reverts writes on error); the idempotent, permissionless `expire_if_past_due(id)` entrypoint performs the `Created → Expired` transition and its accounting.

# Float to Decimal Migration

This runbook covers the money-column migration from PostgreSQL floating-point
types to `NUMERIC`.

The script targets only money-like Prisma fields:

- `Campaign.budget`
- `Claim.amount`
- `BalanceLedger.amount`
- `AidPackage.totalAmount`
- `AidPackage.claimedAmount`
- `AidPackage.remainingAmount`

`EntityLink.confidenceScore` remains a floating-point score and is intentionally
out of scope.

## Prerequisites

- Run from `app/backend`.
- `DATABASE_URL` must point at the PostgreSQL database to migrate.
- `psql` and `pg_dump` must be installed and available on `PATH`.
- Take an infrastructure-level database snapshot before running this script.

## Dry Run

```bash
DATABASE_URL=postgres://... npm run decimal:migrate -- --dry-run
```

Dry run prints row counts for each affected table and the number of `NaN`,
`Infinity`, or `-Infinity` values per affected column. It does not create the
sentinel table and does not write backups.

The migration refuses to continue if any affected column contains `NaN` or
infinite values.

## Migrate

```bash
DATABASE_URL=postgres://... npm run decimal:migrate
```

By default, backups are written under `backups/decimal-migration/<timestamp>`.
Use `--backup-dir` to choose an explicit path:

```bash
DATABASE_URL=postgres://... npm run decimal:migrate -- --backup-dir ./backups/decimal-migration/prod-2026-07-21
```

For each table, the script writes:

- `<Table>.jsonl.gz`: gzipped JSONL generated with `COPY`.
- `<Table>.sql.gz`: `pg_dump --data-only --inserts` safety backup.

After backups are complete, the script runs all `ALTER TABLE ... TYPE NUMERIC`
statements and the sentinel insert in one transaction. If the transaction fails,
PostgreSQL rolls back the in-place type changes.

## Idempotency

Completion is tracked in `_decimal_migration_sentinel` with the migration key
`float-to-decimal-money-v1`.

Rerunning after success prints the table counts and exits without changing data.

## Rollback

Rollback restores the affected tables from the JSONL backup directory and clears
the sentinel:

```bash
DATABASE_URL=postgres://... npm run decimal:migrate -- --rollback ./backups/decimal-migration/prod-2026-07-21
```

Rollback truncates the affected tables in a single transaction, imports the
JSONL archives through `COPY`, and reinserts rows in dependency order.

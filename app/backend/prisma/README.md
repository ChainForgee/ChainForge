# Database Migration Strategy & Operational Procedures

This document outlines the standard operating procedures for creating, testing, deploying, and rolling back database migrations using Prisma. It is critical that all engineers follow these steps to prevent data loss and production downtime.

## Migration Creation Workflow
All schema changes must be developed and tested locally before being pushed to CI/CD.

1. **Update Schema:** Make your changes in `schema.prisma`.
2. **Generate Migration:** Run the dev command to create the SQL file and apply it locally:
   ```bash
   npx prisma migrate dev --name <descriptive_name>


- Model: `VerificationSession` (defined in `schema.prisma`)
  - id: String (cuid)
  - channel: VerificationChannel (email | phone)
  - identifier: String (email or phone)
  - code: String (OTP)
  - attempts: Int
  - resendCount: Int
  - status: VerificationSessionStatus (pending | completed | expired)
  - expiresAt: DateTime
  - createdAt, updatedAt

- Migration: `20260219221806_add_verification_session`

Running locally

1. Generate Prisma client (this is run automatically on install via `postinstall`):

```bash
pnpm --filter backend prisma:generate
```

2. Apply migrations (development):

```bash
pnpm --filter backend prisma:migrate
```

Use `prisma:migrate` only against a local or disposable development database.
It creates migration files from schema changes and may reset or rewrite local
state when Prisma detects drift.

3. Seed demo data for local testing:

```bash
pnpm --filter backend prisma:seed
```

This creates:
- 3 roles (admin, ngo, user)
- 4 development API keys for testing different app roles
- 2 demo campaigns (Emergency Relief Fund and Community Health Program)
- 4 demo claims (2 per campaign with different statuses)

Perfect for local testing and e2e runs without manual setup.

Notes for tests

- The backend includes e2e tests that exercise the verification flow and verify
  that sessions are created, updated and queried via the Prisma client
  (`test/verification-flow.e2e-spec.ts`). If the `VerificationSession` table is
  missing the tests will error with a suggestion to run the migrations.

Migration workflow

-> Start from a clean branch and make the schema change in `schema.prisma`.
-> Create the migration against a local database:

```bash
pnpm --filter backend prisma:migrate -- --name <short_descriptive_name>
```

3. Review the generated SQL under `prisma/migrations/<timestamp>_<name>/` before
   committing it. Check for destructive operations such as `DROP`, `TRUNCATE`,
   column type rewrites, or nullable-to-required changes.
4. Regenerate the Prisma client and run the backend checks that exercise the
   changed models:

```bash
pnpm --filter backend prisma:generate
pnpm --filter backend test
pnpm --filter backend run test:e2e:ci
```

5. Commit `schema.prisma`, the generated migration directory, and any seed or
   test updates together so the application and database shape stay in sync.

Production deployment

Production and shared environments must apply committed migrations with
`prisma:deploy`, not `prisma:migrate`:

```bash
pnpm --filter backend prisma:deploy
```

Before running deploy in production:

- Confirm the target `DATABASE_URL` points at the intended environment.
- Take a fresh database backup or snapshot and record where it can be restored
  from.
- Review the generated SQL for destructive or long-running statements.
- Run the migration against staging or a production snapshot first.
- Schedule the deploy during a maintenance window when the migration may lock
  large tables or require application coordination.

After deploy:

- Run `pnpm --filter backend prisma:generate` in the release build if the client
  was not already generated during install.
- Start the backend and check the health endpoint.
- Run a smoke test for the flows that use the changed tables.
- Monitor application logs and database errors for migration-related failures.

Rollback and restore

Prisma does not automatically roll back a migration that has already been
applied to production. Treat rollback as an explicit recovery plan:

- If deployment fails before the migration is applied, stop the release and keep
  the previous application version running.
- If a migration was applied and the application release fails, first roll the
  application back to the last compatible version when the schema is backward
  compatible.
- If the migration introduced bad data or an incompatible destructive change,
  restore the database from the backup or snapshot taken immediately before the
  deploy.
- For safe forward recovery, create a new corrective migration instead of
  editing an already-applied migration file.
- Never delete or rewrite a migration that has been applied to a shared or
  production database.

Production migration checklist

- [ ] Migration file reviewed for destructive SQL and long-running operations.
- [ ] Backup or snapshot completed and restore owner identified.
- [ ] Migration tested against staging or a recent production snapshot.
- [ ] Backend tests and relevant e2e tests passed.
- [ ] Application release and database migration order documented.
- [ ] Rollback or restore decision point agreed before deploy.
- [ ] Post-deploy health check and smoke test completed.

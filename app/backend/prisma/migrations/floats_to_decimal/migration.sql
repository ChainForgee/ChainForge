-- Migration: floats_to_decimal
-- Converts monetary Float fields to Decimal(38, 18) for precise money handling.
--
-- Prisma will generate the actual migration file when `prisma migrate dev` is
-- run with the updated schema.  The SQL below is the expected Postgres DDL.

-- AidPackage monetary fields
ALTER TABLE "AidPackage"
  ALTER COLUMN "totalAmount" TYPE DECIMAL(38, 18),
  ALTER COLUMN "claimedAmount" TYPE DECIMAL(38, 18),
  ALTER COLUMN "remainingAmount" TYPE DECIMAL(38, 18);

-- BalanceLedger monetary field
ALTER TABLE "BalanceLedger"
  ALTER COLUMN "amount" TYPE DECIMAL(38, 18);

-- Claim monetary field
ALTER TABLE "Claim"
  ALTER COLUMN "amount" TYPE DECIMAL(38, 18);

-- Campaign monetary field
ALTER TABLE "Campaign"
  ALTER COLUMN "budget" TYPE DECIMAL(38, 18);

-- Update default values to match Decimal type
ALTER TABLE "AidPackage"
  ALTER COLUMN "totalAmount" SET DEFAULT 0,
  ALTER COLUMN "claimedAmount" SET DEFAULT 0,
  ALTER COLUMN "remainingAmount" SET DEFAULT 0;

ALTER TABLE "Campaign"
  ALTER COLUMN "budget" SET DEFAULT 0;

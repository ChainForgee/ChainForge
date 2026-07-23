-- Migration: Floats to Decimal
-- Converts monetary Float fields to Decimal(38, 18) for precision

-- AidPackage: totalAmount, claimedAmount, remainingAmount
ALTER TABLE "AidPackage" ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(38, 18);
ALTER TABLE "AidPackage" ALTER COLUMN "claimedAmount" SET DATA TYPE DECIMAL(38, 18);
ALTER TABLE "AidPackage" ALTER COLUMN "remainingAmount" SET DATA TYPE DECIMAL(38, 18);

-- BalanceLedger: amount
ALTER TABLE "BalanceLedger" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(38, 18);

-- Claim: amount
ALTER TABLE "Claim" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(38, 18);

-- Campaign: budget
ALTER TABLE "Campaign" ALTER COLUMN "budget" SET DATA TYPE DECIMAL(38, 18);

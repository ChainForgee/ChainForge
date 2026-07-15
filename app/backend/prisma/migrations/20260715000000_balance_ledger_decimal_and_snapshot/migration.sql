-- Migration: 20260715000000_balance_ledger_decimal_and_snapshot
--
-- 1. Migrate BalanceLedger.amount from REAL (Float) to DECIMAL(38,18).
-- 2. Add the BalanceLedgerSnapshot denormalisation table.

-- Step 1: convert BalanceLedger.amount to DECIMAL(38,18)
ALTER TABLE "BalanceLedger" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(38,18);

-- Step 2: create the BalanceLedgerSnapshot table
CREATE TABLE "BalanceLedgerSnapshot" (
    "id"          TEXT           NOT NULL,
    "campaignId"  TEXT           NOT NULL,
    "totalLocked" DECIMAL(38,18) NOT NULL,
    "snapshotAt"  TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"   TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BalanceLedgerSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BalanceLedgerSnapshot_campaignId_fkey"
        FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Indexes on BalanceLedgerSnapshot
CREATE INDEX "BalanceLedgerSnapshot_campaignId_idx"
    ON "BalanceLedgerSnapshot"("campaignId");

CREATE INDEX "BalanceLedgerSnapshot_snapshotAt_idx"
    ON "BalanceLedgerSnapshot"("snapshotAt");

CREATE INDEX "BalanceLedgerSnapshot_campaignId_snapshotAt_idx"
    ON "BalanceLedgerSnapshot"("campaignId", "snapshotAt");

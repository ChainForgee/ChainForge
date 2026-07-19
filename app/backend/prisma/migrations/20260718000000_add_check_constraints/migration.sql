-- Migration: 20260718000000_add_check_constraints
--
-- Adds CHECK constraints to enforce critical invariants at the DB level:
--   Claim.amount > 0
--   BalanceLedger.amount != 0
--   ApiKey.revokedAt >= createdAt  (passes when revokedAt IS NULL)
--
-- SQLite does not support ALTER TABLE ... ADD CONSTRAINT, so we recreate
-- each table with the inline CHECK constraint.
--
-- PostgreSQL equivalents (for production deployment):
--   ALTER TABLE "Claim"        ADD CONSTRAINT "amount_positive"       CHECK ("amount" > 0);
--   ALTER TABLE "BalanceLedger" ADD CONSTRAINT "amount_nonzero"        CHECK ("amount" <> 0);
--   ALTER TABLE "ApiKey"       ADD CONSTRAINT "revoked_after_created" CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt");

PRAGMA foreign_keys=OFF;

-- ==========================================================================
-- BalanceLedger: amount != 0
-- ==========================================================================

CREATE TABLE "BalanceLedger_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "claimId" TEXT,
    "eventType" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BalanceLedger_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BalanceLedger_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "amount_nonzero" CHECK ("amount" != 0)
);

INSERT INTO "BalanceLedger_new" SELECT * FROM "BalanceLedger";
DROP TABLE "BalanceLedger";
ALTER TABLE "BalanceLedger_new" RENAME TO "BalanceLedger";

CREATE INDEX "BalanceLedger_campaignId_idx" ON "BalanceLedger"("campaignId");
CREATE INDEX "BalanceLedger_claimId_idx" ON "BalanceLedger"("claimId");
CREATE INDEX "BalanceLedger_eventType_idx" ON "BalanceLedger"("eventType");
CREATE INDEX "BalanceLedger_createdAt_idx" ON "BalanceLedger"("createdAt");

-- ==========================================================================
-- Claim: amount > 0
-- ==========================================================================

CREATE TABLE "Claim_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "campaignId" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "recipientRef" TEXT NOT NULL,
    "evidenceRef" TEXT,
    "expiresAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "reissuedFromId" TEXT,
    CONSTRAINT "Claim_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Claim_reissuedFromId_fkey" FOREIGN KEY ("reissuedFromId") REFERENCES "Claim" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "amount_positive" CHECK ("amount" > 0)
);

INSERT INTO "Claim_new" SELECT * FROM "Claim";
DROP TABLE "Claim";
ALTER TABLE "Claim_new" RENAME TO "Claim";

CREATE INDEX "Claim_status_idx" ON "Claim"("status");
CREATE INDEX "Claim_campaignId_idx" ON "Claim"("campaignId");
CREATE INDEX "Claim_createdAt_idx" ON "Claim"("createdAt");
CREATE INDEX "Claim_deletedAt_idx" ON "Claim"("deletedAt");
CREATE INDEX "Claim_reissuedFromId_idx" ON "Claim"("reissuedFromId");
CREATE INDEX "Claim_expiresAt_idx" ON "Claim"("expiresAt");

-- ==========================================================================
-- ApiKey: revokedAt >= createdAt (check passes when revokedAt IS NULL)
-- ==========================================================================

CREATE TABLE "ApiKey_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT,
    "keyHash" TEXT,
    "keyPreview" TEXT,
    "role" TEXT NOT NULL,
    "ngoId" TEXT,
    "orgId" TEXT,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME,
    "createdBy" TEXT,
    "revokedAt" DATETIME,
    "revokedBy" TEXT,
    "revokedReason" TEXT,
    "replacedById" TEXT,
    CONSTRAINT "ApiKey_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ApiKey_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "ApiKey" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "revoked_after_created" CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
);

INSERT INTO "ApiKey_new" SELECT * FROM "ApiKey";
DROP TABLE "ApiKey";
ALTER TABLE "ApiKey_new" RENAME TO "ApiKey";

CREATE UNIQUE INDEX "ApiKey_key_key" ON "ApiKey"("key");
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_ngoId_idx" ON "ApiKey"("ngoId");
CREATE INDEX "ApiKey_orgId_idx" ON "ApiKey"("orgId");
CREATE INDEX "ApiKey_revokedAt_idx" ON "ApiKey"("revokedAt");
CREATE INDEX "ApiKey_lastUsedAt_idx" ON "ApiKey"("lastUsedAt");

PRAGMA foreign_keys=ON;

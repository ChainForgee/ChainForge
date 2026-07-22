-- Add ordered composite indexes for dashboard list and summary queries.

-- Campaign dashboard/export filters by org and status, then orders/paginates by createdAt.
CREATE INDEX "Campaign_orgId_status_createdAt_idx" ON "Campaign"("orgId", "status", "createdAt");

-- Aid package dashboard filters packages within a campaign by status, then orders by createdAt.
CREATE INDEX "AidPackage_campaignId_status_createdAt_idx" ON "AidPackage"("campaignId", "status", "createdAt");

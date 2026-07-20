-- CreateIndex
CREATE INDEX "Claim_campaignId_status_idx" ON "Claim"("campaignId", "status");

-- CreateIndex
CREATE INDEX "SessionSubmission_sessionId_deletedAt_idx" ON "SessionSubmission"("sessionId", "deletedAt");

-- CreateIndex
CREATE INDEX "VerificationRequest_reviewedBy_idx" ON "VerificationRequest"("reviewedBy");

-- AlterTable
ALTER TABLE "RegistryOrganization" ADD COLUMN "provider" TEXT;

-- AlterTable
ALTER TABLE "RegistryLocation" ADD COLUMN "provider" TEXT;

-- AlterTable
ALTER TABLE "RegistryAsset" ADD COLUMN "provider" TEXT;

-- AlterTable
ALTER TABLE "RegistryProject" ADD COLUMN "provider" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RegistryOrganization_provider_externalId_key" ON "RegistryOrganization"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistryLocation_provider_externalId_key" ON "RegistryLocation"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistryAsset_provider_externalId_key" ON "RegistryAsset"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistryProject_provider_externalId_key" ON "RegistryProject"("provider", "externalId");

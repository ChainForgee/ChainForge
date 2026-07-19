# Database Indexes

This document records non-obvious composite indexes and the query shapes they
are intended to support.

## Dashboard Composites

The dashboard and export paths filter by tenant/campaign and status before
ordering or constraining by creation time. Single-column indexes on `orgId`,
`campaignId`, `status`, or `createdAt` do not give PostgreSQL the same ordered
access path as a composite index with equality filters first and the ordered
column last.

| Model        | Index                                      | Query shape                                                                                     |
| ------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `Claim`      | `@@index([campaignId, status])`            | Claims within a campaign filtered by status.                                                    |
| `Campaign`   | `@@index([orgId, status, createdAt])`      | Organization dashboard/export queries filtered by `orgId` and `status`, ordered by `createdAt`. |
| `AidPackage` | `@@index([campaignId, status, createdAt])` | Package dashboard queries filtered by `campaignId` and `status`, ordered by `createdAt`.        |

## CI EXPLAIN Check

For PostgreSQL-backed CI environments, verify the dashboard plan with
`EXPLAIN ANALYZE` after migrations are applied. The expected plan should use an
index scan or bitmap index scan over the matching composite index, not a
sequential scan.

```sql
EXPLAIN ANALYZE
SELECT id, name, status, "createdAt"
FROM "Campaign"
WHERE "orgId" = 'org_test'
  AND status = 'active'
ORDER BY "createdAt" DESC
LIMIT 50;

EXPLAIN ANALYZE
SELECT id, status, "createdAt"
FROM "AidPackage"
WHERE "campaignId" = 'campaign_test'
  AND status = 'active'
ORDER BY "createdAt" DESC
LIMIT 50;

EXPLAIN ANALYZE
SELECT id, status
FROM "Claim"
WHERE "campaignId" = 'campaign_test'
  AND status = 'approved'
LIMIT 50;
```

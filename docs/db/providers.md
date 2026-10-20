# Database Providers

ChainForge supports switching database providers dynamically using environment variables. This enables lightweight development/testing using SQLite and robust production deployments using PostgreSQL.

## Supported Providers
- `sqlite` (Default for local development and unit/e2e testing)
- `postgresql` (Default for production)

## Configuration

The database provider is determined by the following environment variables:

| Variable | Description | Example (SQLite) | Example (PostgreSQL) |
|---|---|---|---|
| `DATABASE_PROVIDER` | The Prisma database provider (`sqlite` or `postgresql`) | `sqlite` | `postgresql` |
| `DATABASE_URL` | The database connection string | `file:./prisma/dev.db` | `postgresql://user:pass@host:5432/db?schema=public` |
| `SHADOW_DATABASE_URL` | Optional shadow database URL (needed for PostgreSQL migrations if user lacks admin privileges to create new databases) | (Not used) | `postgresql://user:pass@host:5432/shadow_db?schema=public` |

### Setting Environment Variables

Copy `app/backend/.env.example` to `app/backend/.env` and configure:

#### SQLite (Default)
```env
DATABASE_PROVIDER="sqlite"
DATABASE_URL="file:./prisma/dev.db"
```

#### PostgreSQL
```env
DATABASE_PROVIDER="postgresql"
DATABASE_URL="postgresql://postgres:password@localhost:5432/chainforge?schema=public"
SHADOW_DATABASE_URL="postgresql://postgres:password@localhost:5432/chainforge_shadow?schema=public"
```

---

## Prisma Migrations and Schema Validation

Because migrations are provider-specific in Prisma:
1. **SQLite migrations** are committed under `app/backend/prisma/migrations`.
2. **PostgreSQL migrations** can be created/applied when using a PostgreSQL target by running:
   ```bash
   DATABASE_PROVIDER=postgresql DATABASE_URL="<pg_url>" npx prisma migrate dev --name <migration_name>
   ```
3. To dynamically apply migrations or initialize schema without pre-existing migration folders (e.g. for temporary test runs), use:
   ```bash
   DATABASE_PROVIDER=postgresql DATABASE_URL="<pg_url>" npx prisma db push
   ```

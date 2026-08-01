import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { spawn } from 'node:child_process';

type ColumnConfig = {
  name: string;
  targetType: string;
};

type TableConfig = {
  name: string;
  columns: ColumnConfig[];
};

const MIGRATION_KEY = 'float-to-decimal-money-v1';
const DEFAULT_SCHEMA = 'public';
const BACKUP_ROOT = 'backups/decimal-migration';

const TABLES: TableConfig[] = [
  {
    name: 'Campaign',
    columns: [{ name: 'budget', targetType: 'NUMERIC' }],
  },
  {
    name: 'Claim',
    columns: [{ name: 'amount', targetType: 'NUMERIC' }],
  },
  {
    name: 'BalanceLedger',
    columns: [{ name: 'amount', targetType: 'NUMERIC' }],
  },
  {
    name: 'AidPackage',
    columns: [
      { name: 'totalAmount', targetType: 'NUMERIC' },
      { name: 'claimedAmount', targetType: 'NUMERIC' },
      { name: 'remainingAmount', targetType: 'NUMERIC' },
    ],
  },
];

const RESTORE_ORDER = ['Campaign', 'Claim', 'BalanceLedger', 'AidPackage'];

type CliOptions = {
  dryRun: boolean;
  rollback?: string;
  backupDir?: string;
  schema: string;
};

type PreflightRow = {
  table: string;
  column: string;
  badCount: number;
};

type TableCount = {
  table: string;
  count: number;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    schema: process.env.DECIMAL_MIGRATION_SCHEMA ?? DEFAULT_SCHEMA,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--backup-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--backup-dir requires a path');
      }
      options.backupDir = value;
      index += 1;
      continue;
    }

    if (arg === '--rollback') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--rollback requires a backup directory path');
      }
      options.rollback = value;
      index += 1;
      continue;
    }

    if (arg === '--schema') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--schema requires a PostgreSQL schema name');
      }
      options.schema = value;
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage:
  ts-node --transpile-only scripts/decimal-migrate.ts [--dry-run] [--backup-dir PATH] [--schema public]
  ts-node --transpile-only scripts/decimal-migrate.ts --rollback PATH [--schema public]

Options:
  --dry-run       Print affected table counts and NaN/Infinity findings only.
  --backup-dir    Directory for .jsonl.gz and pg_dump .sql.gz backups.
  --rollback      Restore affected tables from a backup directory and clear the sentinel.
  --schema        PostgreSQL schema that owns the Prisma tables. Defaults to public.`);
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return databaseUrl;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function qualifiedName(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function pgDumpTablePattern(schema: string, table: string): string {
  return `${schema}.${quoteIdentifier(table)}`;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function runCommand(
  command: string,
  args: string[],
  options: { input?: string; captureStdout?: boolean } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', options.captureStdout ? 'pipe' : 'inherit', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    if (options.captureStdout) {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }

      reject(
        new Error(
          `${command} exited with code ${code}${stderr ? `\n${stderr.trim()}` : ''}`,
        ),
      );
    });

    if (options.input) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

async function runPsql(databaseUrl: string, sql: string): Promise<string> {
  return runCommand(
    'psql',
    [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', sql],
    { captureStdout: true },
  );
}

async function runPsqlScript(databaseUrl: string, sql: string): Promise<void> {
  await runCommand(
    'psql',
    [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    {
      input: sql,
    },
  );
}

async function checkSentinel(
  databaseUrl: string,
  schema: string,
): Promise<boolean> {
  const sentinelRegclass = `${quoteIdentifier(schema)}.${quoteIdentifier(
    '_decimal_migration_sentinel',
  )}`;
  const existsOutput = await runPsql(
    databaseUrl,
    `SELECT to_regclass(${quoteLiteral(sentinelRegclass)}) IS NOT NULL;`,
  );

  if (existsOutput.trim() !== 't') {
    return false;
  }

  const sql = `
    SELECT EXISTS (
      SELECT 1
      FROM ${qualifiedName(schema, '_decimal_migration_sentinel')}
      WHERE migration_key = ${quoteLiteral(MIGRATION_KEY)}
    );
  `;

  const output = await runPsql(databaseUrl, sql);
  return output.trim() === 't';
}

async function tableCounts(
  databaseUrl: string,
  schema: string,
): Promise<TableCount[]> {
  const counts: TableCount[] = [];

  for (const table of TABLES) {
    const output = await runPsql(
      databaseUrl,
      `SELECT COUNT(*) FROM ${qualifiedName(schema, table.name)};`,
    );
    counts.push({ table: table.name, count: Number(output.trim()) });
  }

  return counts;
}

async function preflight(
  databaseUrl: string,
  schema: string,
): Promise<PreflightRow[]> {
  const rows: PreflightRow[] = [];

  for (const table of TABLES) {
    for (const column of table.columns) {
      const output = await runPsql(
        databaseUrl,
        `
          SELECT COUNT(*)
          FROM ${qualifiedName(schema, table.name)}
          WHERE ${quoteIdentifier(column.name)}::text IN ('NaN', 'Infinity', '-Infinity');
        `,
      );

      rows.push({
        table: table.name,
        column: column.name,
        badCount: Number(output.trim()),
      });
    }
  }

  return rows;
}

async function copyJsonlBackup(
  databaseUrl: string,
  schema: string,
  table: string,
  filePath: string,
): Promise<void> {
  const child = spawn('psql', [
    databaseUrl,
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `
      COPY (
        SELECT row_to_json(row_data)::text
        FROM (
          SELECT *
          FROM ${qualifiedName(schema, table)}
          ORDER BY ${quoteIdentifier('id')}
        ) AS row_data
      ) TO STDOUT WITH (FORMAT csv, DELIMITER E'\\x1f', QUOTE E'\\x1e', ESCAPE E'\\x1d');
    `,
  ]);

  const gzip = createGzip();
  const output = createWriteStream(filePath);
  let stderr = '';

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const closePromise = new Promise<void>((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(`psql COPY backup failed for ${table}: ${stderr.trim()}`),
      );
    });
  });

  await Promise.all([pipeline(child.stdout, gzip, output), closePromise]);
}

async function pgDumpBackup(
  databaseUrl: string,
  schema: string,
  table: string,
  filePath: string,
): Promise<void> {
  const child = spawn('pg_dump', [
    databaseUrl,
    '--data-only',
    '--inserts',
    `--table=${pgDumpTablePattern(schema, table)}`,
  ]);

  const gzip = createGzip();
  const output = createWriteStream(filePath);
  let stderr = '';

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const closePromise = new Promise<void>((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`pg_dump failed for ${table}: ${stderr.trim()}`));
    });
  });

  await Promise.all([pipeline(child.stdout, gzip, output), closePromise]);
}

async function createBackups(
  databaseUrl: string,
  schema: string,
  backupDir: string,
): Promise<void> {
  mkdirSync(backupDir, { recursive: true });

  for (const table of TABLES) {
    await copyJsonlBackup(
      databaseUrl,
      schema,
      table.name,
      join(backupDir, `${table.name}.jsonl.gz`),
    );
    await pgDumpBackup(
      databaseUrl,
      schema,
      table.name,
      join(backupDir, `${table.name}.sql.gz`),
    );
  }
}

function migrationSql(schema: string): string {
  const lockTargets = TABLES.map(table =>
    qualifiedName(schema, table.name),
  ).join(', ');
  const alterStatements = TABLES.flatMap(table =>
    table.columns.map(
      column =>
        `ALTER TABLE ${qualifiedName(schema, table.name)} ALTER COLUMN ${quoteIdentifier(
          column.name,
        )} TYPE ${column.targetType} USING ${quoteIdentifier(column.name)}::numeric;`,
    ),
  ).join('\n');

  return `
BEGIN;

CREATE TABLE IF NOT EXISTS ${qualifiedName(schema, '_decimal_migration_sentinel')} (
  migration_key text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now(),
  backup_dir text NOT NULL
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ${qualifiedName(schema, '_decimal_migration_sentinel')}
    WHERE migration_key = ${quoteLiteral(MIGRATION_KEY)}
  ) THEN
    RAISE EXCEPTION 'decimal migration sentinel already exists';
  END IF;
END $$;

LOCK TABLE ${lockTargets} IN ACCESS EXCLUSIVE MODE;

${alterStatements}

INSERT INTO ${qualifiedName(schema, '_decimal_migration_sentinel')} (migration_key, backup_dir)
VALUES (${quoteLiteral(MIGRATION_KEY)}, :'backup_dir');

COMMIT;
`;
}

async function migrate(
  databaseUrl: string,
  schema: string,
  backupDir: string,
): Promise<void> {
  const sql = migrationSql(schema);
  await runCommand(
    'psql',
    [
      databaseUrl,
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `backup_dir=${backupDir.replace(/'/g, "''")}`,
      '-f',
      '-',
    ],
    { input: sql },
  );
}

async function gunzipToTempFile(
  source: string,
  destination: string,
): Promise<void> {
  await pipeline(
    createReadStream(source),
    createGunzip(),
    createWriteStream(destination),
  );
}

function rollbackSql(schema: string, files: Map<string, string>): string {
  const truncateTargets = TABLES.map(table =>
    qualifiedName(schema, table.name),
  ).join(', ');
  const statements = [
    'BEGIN;',
    'SET CONSTRAINTS ALL DEFERRED;',
    `TRUNCATE ${truncateTargets} CASCADE;`,
  ];

  for (const tableName of RESTORE_ORDER) {
    const filePath = files.get(tableName);
    if (!filePath) {
      throw new Error(`Missing rollback file for ${tableName}`);
    }

    const tempTable = quoteIdentifier(`__decimal_restore_${tableName}`);
    statements.push(`CREATE TEMP TABLE ${tempTable} (line jsonb);`);
    statements.push(
      `\\copy ${tempTable}(line) FROM '${filePath.replace(/'/g, "''")}' WITH (FORMAT csv, DELIMITER E'\\x1f', QUOTE E'\\x1e', ESCAPE E'\\x1d');`,
    );
    statements.push(
      `INSERT INTO ${qualifiedName(schema, tableName)} SELECT (jsonb_populate_record(NULL::${qualifiedName(
        schema,
        tableName,
      )}, line)).* FROM ${tempTable};`,
    );
  }

  statements.push(`CREATE TABLE IF NOT EXISTS ${qualifiedName(schema, '_decimal_migration_sentinel')} (
  migration_key text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now(),
  backup_dir text NOT NULL
);`);
  statements.push(
    `DELETE FROM ${qualifiedName(
      schema,
      '_decimal_migration_sentinel',
    )} WHERE migration_key = ${quoteLiteral(MIGRATION_KEY)};`,
  );
  statements.push('COMMIT;');
  return statements.join('\n');
}

async function rollback(
  databaseUrl: string,
  schema: string,
  backupDir: string,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'decimal-migration-restore-'));
  const files = new Map<string, string>();

  try {
    for (const tableName of RESTORE_ORDER) {
      const source = resolve(backupDir, `${tableName}.jsonl.gz`);
      const destination = join(tempDir, `${tableName}.jsonl`);
      await gunzipToTempFile(source, destination);
      files.set(tableName, destination);
    }

    await runPsqlScript(databaseUrl, rollbackSql(schema, files));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function printCounts(
  counts: TableCount[],
  badRows: PreflightRow[],
  completed: boolean,
): void {
  console.log(`Sentinel completed: ${completed ? 'yes' : 'no'}`);
  console.log('Table counts:');
  for (const row of counts) {
    console.log(`  ${row.table}: ${row.count}`);
  }

  console.log('NaN/Infinity checks:');
  for (const row of badRows) {
    console.log(`  ${row.table}.${row.column}: ${row.badCount}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = getDatabaseUrl();

  if (options.rollback) {
    await rollback(databaseUrl, options.schema, options.rollback);
    console.log(
      `Rollback restored affected tables from ${resolve(options.rollback)}`,
    );
    return;
  }

  const completed = await checkSentinel(databaseUrl, options.schema);
  const counts = await tableCounts(databaseUrl, options.schema);
  const badRows = await preflight(databaseUrl, options.schema);
  printCounts(counts, badRows, completed);

  if (options.dryRun) {
    return;
  }

  if (completed) {
    console.log('Migration already completed; nothing to do.');
    return;
  }

  const invalidRows = badRows.filter(row => row.badCount > 0);
  if (invalidRows.length > 0) {
    throw new Error(
      'Pre-flight failed: NaN/Infinity values must be remediated before migration.',
    );
  }

  const backupDir = resolve(
    options.backupDir ?? join(BACKUP_ROOT, timestamp()),
  );
  await createBackups(databaseUrl, options.schema, backupDir);
  await migrate(databaseUrl, options.schema, backupDir);

  console.log(`Migration completed. Backups written to ${backupDir}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

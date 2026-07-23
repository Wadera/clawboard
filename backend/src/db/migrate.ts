// migrate.ts - Database migration runner with baseline stamping
//
// Migration story (see src/migrations/README.md for the full history):
//   - database/init.sql is the authoritative fresh-install baseline. It contains
//     the complete schema through migration 042 (regenerated from the live schema).
//   - src/migrations/BASELINE lists every migration file that is already part of
//     that baseline. Those files are STAMPED into schema_migrations without being
//     executed — on fresh databases (after init.sql) and on existing databases
//     whose ledger is missing entries that were applied out-of-band.
//   - Only files NOT listed in BASELINE (043+) are actually executed.
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { pool } from './connection';

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');
const BASELINE_MANIFEST = path.join(MIGRATIONS_DIR, 'BASELINE');

/** Tables that must exist on any correctly-initialized ClawBoard database. */
const CRITICAL_TABLES = ['schema_migrations', 'tasks', 'sessions', 'task_timeline_events'];

interface MigrationRecord {
  id: number;
  name: string;
  executed_at: Date;
}

/** Read the baseline manifest: one filename per line, '#' comments allowed. */
export function readBaselineManifest(): string[] {
  if (!existsSync(BASELINE_MANIFEST)) return [];
  return readFileSync(BASELINE_MANIFEST, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

/** List all .sql migration files on disk, sorted. */
export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Pre-baseline prod tables were created without UNIQUE(name); ON CONFLICT needs the arbiter index
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS schema_migrations_name_key ON schema_migrations (name)`
  );
}

async function getExecutedMigrations(): Promise<string[]> {
  const result = await pool.query<MigrationRecord>(
    'SELECT name FROM schema_migrations ORDER BY id'
  );
  return result.rows.map(r => r.name);
}

async function recordMigration(name: string): Promise<void> {
  await pool.query(
    'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
    [name]
  );
}

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [`public.${name}`]
  );
  return result.rows[0]?.exists === true;
}

/**
 * Core migration logic. Does NOT close the pool — safe to call from server startup.
 * @param closePoolWhenDone Pass true when running as a standalone CLI script.
 */
export async function runMigrations(closePoolWhenDone = false): Promise<void> {
  console.log('🔄 Starting database migrations...\n');

  try {
    await ensureMigrationsTable();
    const executed = await getExecutedMigrations();
    const baseline = readBaselineManifest();
    const files = listMigrationFiles();

    // Sanity: baseline entries must exist on disk (deleting a baseline-listed
    // file is harmless for stamping, but is almost certainly a mistake).
    const baselineMissingOnDisk = baseline.filter(b => !files.includes(b));
    if (baselineMissingOnDisk.length > 0) {
      console.warn(
        `⚠️  ${baselineMissingOnDisk.length} BASELINE entry(ies) have no file on disk: ` +
        baselineMissingOnDisk.join(', ')
      );
    }

    // ── Phase 1: stamp baseline migrations ────────────────────────────────
    // Everything listed in BASELINE is already contained in database/init.sql
    // (fresh installs) or was applied out-of-band long ago (prod/dev). It is
    // recorded as applied WITHOUT being executed. Never re-executed.
    const toStamp = baseline.filter(b => !executed.includes(b));
    if (toStamp.length > 0) {
      // Refuse to stamp into a database that never got the base schema —
      // stamping there would silently produce an empty-but-"migrated" DB.
      if (!(await tableExists('tasks'))) {
        throw new Error(
          'Baseline stamping refused: table "tasks" does not exist. ' +
          'This database has not been initialized — apply database/init.sql first, ' +
          'then re-run migrations.'
        );
      }
      console.log(`🏷️  Stamping ${toStamp.length} baseline migration(s) as applied (not executed):`);
      for (const name of toStamp) {
        await recordMigration(name);
        console.log(`   🏷️  ${name}`);
      }
      console.log('');
    }

    // ── Phase 2: execute post-baseline migrations ─────────────────────────
    let migratedCount = 0;
    for (const file of files) {
      if (baseline.includes(file)) continue; // stamped above (or already in ledger)
      if (executed.includes(file)) {
        console.log(`⏭️  Skipping (already executed): ${file}`);
        continue;
      }

      console.log(`▶️  Running: ${file}`);
      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = readFileSync(filePath, 'utf8');

      try {
        await pool.query(sql);
        await recordMigration(file);
        console.log(`✅ Completed: ${file}\n`);
        migratedCount++;
      } catch (err) {
        console.error(`❌ Failed: ${file}`);
        console.error(err);
        throw err;
      }
    }

    if (toStamp.length === 0 && migratedCount === 0) {
      console.log('\n✨ Database is up to date. No migrations to run.');
    } else {
      console.log(
        `\n✅ Migration run complete: ${toStamp.length} stamped, ${migratedCount} executed.`
      );
    }
  } catch (err) {
    if (closePoolWhenDone) {
      console.error('Migration failed:', err);
      process.exit(1);
    }
    throw err;
  }

  if (closePoolWhenDone) {
    await pool.end();
  }
}

/**
 * Schema/ledger consistency check. Returns a list of human-readable problems
 * (empty = healthy). Never throws for "drift" — only for connection failures.
 */
export async function checkSchemaConsistency(): Promise<string[]> {
  const problems: string[] = [];

  for (const table of CRITICAL_TABLES) {
    if (!(await tableExists(table))) {
      problems.push(`critical table missing: "${table}"`);
    }
  }

  // Without a ledger there is nothing more to compare.
  if (problems.some(p => p.includes('"schema_migrations"'))) {
    return problems;
  }

  const executed = await getExecutedMigrations();
  const files = listMigrationFiles();
  const baseline = readBaselineManifest();

  for (const file of files) {
    if (!executed.includes(file)) {
      problems.push(
        `migration file never applied/stamped: ${file}` +
        (baseline.includes(file) ? ' (baseline — run "npm run migrate" to stamp it)' : '')
      );
    }
  }

  for (const name of executed) {
    if (!files.includes(name)) {
      problems.push(`ledger entry has no matching file on disk: ${name} (renamed or deleted migration)`);
    }
  }

  return problems;
}

/**
 * Boot-time consistency check: verifies ledger-vs-directory agreement and the
 * presence of critical tables. Logs a LOUD warning on drift — never crashes
 * and never blocks server startup.
 */
export async function runStartupChecks(): Promise<void> {
  try {
    const problems = await checkSchemaConsistency();
    if (problems.length === 0) {
      const executed = await getExecutedMigrations();
      console.log(
        `✅ Schema consistency check passed (${executed.length} ledger entries, ` +
        'directory and critical tables OK)'
      );
      return;
    }
    console.warn('╔═══════════════════════════════════════════════════════════╗');
    console.warn('║ ⚠️  SCHEMA DRIFT DETECTED — database vs migrations         ║');
    console.warn('╚═══════════════════════════════════════════════════════════╝');
    for (const problem of problems) {
      console.warn(`   ⚠️  ${problem}`);
    }
    console.warn('   ➜ See backend/src/migrations/README.md (task 475a54c9) for the migration story.');
  } catch (err) {
    console.warn('⚠️  Schema consistency check could not run:', err);
  }
}

/**
 * Run pending migrations on server startup when AUTO_MIGRATE=true.
 * Safe to import from server.ts — does not close the pool.
 *
 * Usage in server.ts:
 *   import { runMigrationsOnStartup } from './db/migrate';
 *   await runMigrationsOnStartup();
 */
export async function runMigrationsOnStartup(): Promise<void> {
  if (process.env.AUTO_MIGRATE !== 'true') return;
  console.log('🔄 AUTO_MIGRATE=true — running pending migrations on startup...');
  await runMigrations(false); // keep pool alive
}

// Run if called directly (npm run migrate)
if (require.main === module) {
  runMigrations(true).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

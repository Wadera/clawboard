// migrate.ts - Simple database migration runner
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { pool } from './connection';

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

interface MigrationRecord {
  id: number;
  name: string;
  executed_at: Date;
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function getExecutedMigrations(): Promise<string[]> {
  const result = await pool.query<MigrationRecord>(
    'SELECT name FROM schema_migrations ORDER BY id'
  );
  return result.rows.map(r => r.name);
}

async function recordMigration(name: string): Promise<void> {
  await pool.query(
    'INSERT INTO schema_migrations (name) VALUES ($1)',
    [name]
  );
}

async function runMigrations(): Promise<void> {
  console.log('🔄 Starting database migrations...\n');

  await ensureMigrationsTable();
  const executed = await getExecutedMigrations();

  // Get all SQL migration files
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let migratedCount = 0;

  for (const file of files) {
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
      process.exit(1);
    }
  }

  if (migratedCount === 0) {
    console.log('\n✨ Database is up to date. No migrations to run.');
  } else {
    console.log(`\n✅ Successfully ran ${migratedCount} migration(s).`);
  }

  await pool.end();
}

// Run if called directly
runMigrations().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

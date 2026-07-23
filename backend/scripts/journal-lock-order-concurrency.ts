import assert from 'assert';
import { pool } from '../src/db/connection';

const key = process.env.TEST_PUBLICATION_KEY || 'b544a621e59447726925cfda78aebfb4';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const rollback = await pool.connect();
  const competingPublish = await pool.connect();
  try {
    await rollback.query('BEGIN');
    await rollback.query("SET LOCAL lock_timeout='5s'");
    await rollback.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`publication-key:${key}`]);
    const identity = (await rollback.query(
      'SELECT operation,source_date,entry_id FROM journal_run_publications WHERE idempotency_key=$1', [key],
    )).rows[0];
    assert(identity && identity.operation === 'new_entry' && identity.source_date, 'published new-entry identity required');
    const dateLock = `new-entry:${identity.source_date.toISOString().slice(0, 10)}`;

    await competingPublish.query('BEGIN');
    await competingPublish.query("SET LOCAL lock_timeout='5s'");
    await competingPublish.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [dateLock]);

    // Rollback now waits for the shared source-date lock but holds no publication row lock.
    const rollbackDateWait = rollback.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [dateLock]);
    await sleep(150);

    // A different-key publish can inspect/lock the active publication and fail/finish;
    // it is not waiting on a row lock held by rollback, so no deadlock cycle exists.
    const active = (await competingPublish.query(
      "SELECT idempotency_key FROM journal_run_publications WHERE entry_id=$1 AND state='published' FOR UPDATE", [identity.entry_id],
    )).rows[0];
    assert.equal(active.idempotency_key, key);
    await competingPublish.query('ROLLBACK');

    await rollbackDateWait;
    const locked = (await rollback.query(
      'SELECT idempotency_key FROM journal_run_publications WHERE idempotency_key=$1 FOR UPDATE', [key],
    )).rows[0];
    assert.equal(locked.idempotency_key, key);
    await rollback.query('ROLLBACK');
    console.log(JSON.stringify({ integration: 'PASS', race: 'rollback_vs_different_key_same_date', deadlock: false }));
  } finally {
    try { await rollback.query('ROLLBACK'); } catch {}
    try { await competingPublish.query('ROLLBACK'); } catch {}
    rollback.release(); competingPublish.release(); await pool.end();
  }
}

main().catch(async error => { console.error(error); try { await pool.end(); } catch {} process.exit(1); });

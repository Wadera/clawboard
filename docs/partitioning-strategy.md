# session_messages Partitioning Strategy

## Current State

`session_messages` is an unpartitioned heap table designed for high write throughput.
Optimizations in place:
- **BRIN index** on `created_at` (replaces B-tree, ~200x smaller, ideal for monotonic appends)
- **Connection pool** via node-postgres Pool (max 20 connections)
- **VACUUM ANALYZE** recommended weekly (see Maintenance section below)

## When to Partition

Partition when `estimated_row_count > 1,000,000` — monitor via:

```sql
SELECT * FROM session_messages_row_count;
```

Or via API: `GET /api/sessions/stats` → `partitioning.partition_recommendation`

## Partitioning Plan (execute when threshold crossed)

Partition by **month** using `RANGE` on `created_at`:

```sql
-- Step 1: Create partitioned table
CREATE TABLE session_messages_partitioned (
  LIKE session_messages INCLUDING ALL
) PARTITION BY RANGE (created_at);

-- Step 2: Create monthly partitions (automate with pg_partman)
CREATE TABLE session_messages_2026_01
  PARTITION OF session_messages_partitioned
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE session_messages_2026_02
  PARTITION OF session_messages_partitioned
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
-- ... etc, use pg_partman for automation

-- Step 3: Migrate data
INSERT INTO session_messages_partitioned SELECT * FROM session_messages;

-- Step 4: Atomic swap (during maintenance window)
ALTER TABLE session_messages RENAME TO session_messages_old;
ALTER TABLE session_messages_partitioned RENAME TO session_messages;

-- Step 5: Drop old table after verification
DROP TABLE session_messages_old;
```

## VACUUM ANALYZE Schedule

Run weekly on `session_messages`:

```sql
VACUUM ANALYZE session_messages;
```

Recommended as a cron job (pg_cron if available, or external cron):
```bash
# Weekly VACUUM (Sunday 02:00 UTC)
0 2 * * 0 psql -U clawboard -d clawboard -c "VACUUM ANALYZE session_messages;"
```

## pg_bouncer / Connection Pooling

Currently using node-postgres built-in pool (max=20, idle=30s).
For production scale (>100 concurrent sessions), consider pg_bouncer in transaction mode:

```bash
# pg_bouncer config snippet
[databases]
clawboard = host=127.0.0.1 port=5432 dbname=clawboard

[pgbouncer]
pool_mode = transaction
max_client_conn = 200
default_pool_size = 25
```

The backend pool config is in `backend/src/db/connection.ts`.

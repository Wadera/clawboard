# Database Schema & Management

This directory contains all database-related files for ClawBoard.

## Files

### Schema

- **`init.sql`** - Complete database schema (single source of truth)
  - All tables, indexes, constraints, triggers
  - Auto-loads on first container start
  - Consolidated from all historical migrations

- **`seed.sql`** - Optional sample data
  - Example projects, tasks, agents
  - Useful for testing and development
  - Not loaded automatically

### Migrations

The `migrations/` directory contains historical migration files for reference:

- `004_phase4_task_schema.sql` - Enhanced task orchestration
- `005_projects_schema.sql` - Projects and links
- `006_bot_status.sql` - Bot status table
- `007_image_generations.sql` - Image generation tracking
- `008_project_source_dir.sql` - Source directory mapping
- `009_project_nfs_dir.sql` - NFS directory mapping
- `010_project_hidden_flag.sql` - Hidden project flag

**Note:** For new installations, these are informational only. The complete schema is in `init.sql`.

### Scripts

- **`backup.sh`** - Database backup script
- **`restore.sh`** - Database restore script

## Database Schema

### Core Tables

| Table | Purpose |
|-------|---------|
| `bot_status` | Agent avatar and status updates |
| `projects` | Project metadata and configuration |
| `project_links` | External links (git, docs, etc.) |
| `tasks` | Kanban tasks with orchestration features |
| `task_history` | Audit log of task changes |
| `agents` | Sub-agents spawned for work |
| `thoughts` | Chain-of-thought execution logs |
| `approvals` | Command and plan approvals |
| `image_generations` | Image generation tracking |

### Key Features

- **UUIDs** - All primary keys use UUID v4
- **Timestamps** - Automatic `created_at` and `updated_at`
- **JSONB** - Flexible metadata storage
- **Indexes** - Optimized for common queries
- **Constraints** - Data validation at DB level
- **Triggers** - Auto-update timestamps

## Usage

### First Installation

The database initializes automatically on first start:

```bash
docker compose up -d clawboard-db
```

The `init.sql` file is executed via Docker's `initdb` mechanism.

### Loading Sample Data

After initialization, optionally load seed data:

```bash
# Copy seed file into container
docker cp database/seed.sql clawboard-db:/tmp/seed.sql

# Execute seed script
docker exec clawboard-db psql -U clawboard -d clawboard -f /tmp/seed.sql
```

Or from host (if psql installed):

```bash
cat database/seed.sql | docker exec -i clawboard-db psql -U clawboard -d clawboard
```

### Creating Backups

```bash
./database/backup.sh
```

Features:
- Timestamped backups
- Automatic compression (gzip)
- Keeps last N backups (configurable)
- Output: `./backups/clawboard_YYYYMMDD_HHMMSS.sql.gz`

Configuration (via `.env`):

```bash
BACKUP_DIR=./backups        # Where to store backups
KEEP_BACKUPS=7              # Number of backups to retain
```

### Restoring from Backup

```bash
./database/restore.sh
```

Interactive menu:
1. Lists available backups
2. Select backup to restore
3. Creates safety backup before restore
4. Stops backend to avoid connection conflicts
5. Restores database
6. Restarts backend

You can also specify backup directly:

```bash
./database/restore.sh ./backups/clawboard_20260209_120000.sql.gz
./database/restore.sh 1  # Restore most recent
```

### Manual Database Access

```bash
# psql shell
docker exec -it clawboard-db psql -U clawboard -d clawboard

# Run query
docker exec clawboard-db psql -U clawboard -d clawboard -c "SELECT COUNT(*) FROM tasks;"

# Dump schema only
docker exec clawboard-db pg_dump -U clawboard -d clawboard --schema-only > schema.sql
```

## Development

### Adding New Tables

For new tables, update `init.sql` directly. The file is the single source of truth.

Example:

```sql
-- New table
CREATE TABLE IF NOT EXISTS my_new_table (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index
CREATE INDEX IF NOT EXISTS idx_my_new_table_name ON my_new_table(name);

-- Trigger for updated_at
CREATE TRIGGER update_my_new_table_updated_at BEFORE UPDATE ON my_new_table
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

### Schema Migrations (Production)

For production databases with existing data, create migration scripts:

```bash
# 1. Create migration file
cat > database/migrations/011_my_feature.sql << 'EOF'
-- Add new column
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS my_field TEXT;

-- Backfill data
UPDATE tasks SET my_field = 'default' WHERE my_field IS NULL;
EOF

# 2. Apply migration
cat database/migrations/011_my_feature.sql | \
  docker exec -i clawboard-db psql -U clawboard -d clawboard

# 3. Update init.sql with the change (for new installs)
```

### Testing Schema Changes

Use a separate test database:

```bash
# Start test database
docker run --name clawboard-db-test \
  -e POSTGRES_DB=clawboard \
  -e POSTGRES_USER=clawboard \
  -e POSTGRES_PASSWORD=test \
  -p 5435:5432 \
  -d postgres:16-alpine

# Load schema
cat database/init.sql | docker exec -i clawboard-db-test psql -U clawboard -d clawboard

# Test queries
docker exec clawboard-db-test psql -U clawboard -d clawboard -c "SELECT COUNT(*) FROM tasks;"

# Clean up
docker stop clawboard-db-test
docker rm clawboard-db-test
```

## Maintenance

### Database Size

```sql
-- Total database size
SELECT pg_size_pretty(pg_database_size('clawboard'));

-- Table sizes
SELECT 
    schemaname || '.' || tablename AS table,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

### Vacuum and Analyze

PostgreSQL handles this automatically, but you can manually trigger:

```bash
# Vacuum all tables
docker exec clawboard-db psql -U clawboard -d clawboard -c "VACUUM ANALYZE;"

# Vacuum specific table
docker exec clawboard-db psql -U clawboard -d clawboard -c "VACUUM ANALYZE tasks;"
```

### Index Usage Statistics

```sql
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan AS index_scans,
    idx_tup_read AS tuples_read,
    idx_tup_fetch AS tuples_fetched
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC;
```

## Troubleshooting

### Init script not running

Symptoms: Database starts but tables don't exist

Solution:
```bash
# Remove volume and recreate
docker compose down -v
docker compose up -d clawboard-db
```

### Permission denied errors

Symptoms: Cannot read/write database

Solution:
```bash
# Check container logs
docker compose logs clawboard-db

# Verify user has permissions
docker exec clawboard-db psql -U clawboard -d clawboard -c "SELECT current_user;"
```

### Connection refused

Symptoms: Backend can't connect to database

Solution:
```bash
# Check database is healthy
docker compose ps clawboard-db

# Check health status
docker inspect clawboard-db | grep -A 10 Health

# Wait for healthy status
while ! docker exec clawboard-db pg_isready -U clawboard -d clawboard; do
    echo "Waiting for database..."
    sleep 2
done
```

### Backup/restore fails

Symptoms: Script exits with error

Solution:
```bash
# Ensure database container is running
docker compose ps clawboard-db

# Check .env file exists
cat .env | grep POSTGRES_PASSWORD

# Run script with bash -x for debugging
bash -x ./database/backup.sh
```

## Security

### Password Management

- Store passwords in `.env` file (not committed to git)
- Use strong, random passwords
- Rotate passwords periodically

### Network Isolation

- Database only accessible within Docker network
- Not exposed to host by default (no port mapping in docker-compose.yml)
- Backend connects via internal network

### Backup Encryption

For sensitive data, encrypt backups:

```bash
# Encrypt backup
gpg -c ./backups/clawboard_20260209_120000.sql.gz

# Decrypt for restore
gpg -d ./backups/clawboard_20260209_120000.sql.gz.gpg | \
  gunzip | \
  docker exec -i clawboard-db psql -U clawboard -d clawboard
```

## Resources

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [pg_dump Documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
- [Docker PostgreSQL Image](https://hub.docker.com/_/postgres)

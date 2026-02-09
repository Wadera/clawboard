# Database Backup Scripts

This directory contains automated backup and restore scripts for the ClawBoard PostgreSQL database.

## Scripts

### `backup-db.sh`
Automated backup script that:
- Dumps the production PostgreSQL database from the `clawboard-db` Docker container
- Compresses the dump with gzip
- Names backups: `clawboard-prod-YYYYMMDD-HHMMSS.sql.gz`
- Stores backups in `/srv/ai-stack/projects/data/backups/`
- Rotates backups (keeps 7 days)
- Logs all operations to `/srv/ai-stack/projects/data/backups/backup.log`

**Usage:**
```bash
./scripts/backup-db.sh
```

**Cron Schedule:**
The backup runs automatically every 6 hours via cron (see `/etc/crontab`).

### `restore-db.sh`
Restores a backup to the production database.

**⚠️ WARNING:** This script will DROP and recreate the database, destroying all current data!

**Usage:**
```bash
# List available backups
./scripts/restore-db.sh

# Restore a specific backup
./scripts/restore-db.sh clawboard-prod-20260131-134111.sql.gz
```

**Interactive Confirmation:**
The script will prompt for confirmation before proceeding with the restore.

## Backup Location

All backups are stored in: `/srv/ai-stack/projects/data/backups/`

## Retention Policy

- Backups are kept for **7 days**
- Older backups are automatically deleted
- This provides a rolling week of recovery points

## Logs

- Backup log: `/srv/ai-stack/projects/data/backups/backup.log`
- Restore log: `/srv/ai-stack/projects/data/backups/restore.log`

## Testing the Restore Process

To test a restore without affecting production:

1. Spin up a test database container
2. Modify `restore-db.sh` to point to the test container
3. Run the restore
4. Verify data integrity
5. Destroy the test container

## Manual Backup

To create an immediate backup outside the cron schedule:
```bash
cd /home/clawd/clawd/projects/clawboard
./scripts/backup-db.sh
```

## Monitoring

Check the backup log regularly to ensure backups are running:
```bash
tail -f /srv/ai-stack/projects/data/backups/backup.log
```

## Recovery Scenarios

### Restore Latest Backup
```bash
LATEST=$(ls -t /srv/ai-stack/projects/data/backups/clawboard-prod-*.sql.gz | head -1)
./scripts/restore-db.sh "$LATEST"
```

### Restore Specific Point in Time
```bash
# List backups with timestamps
ls -lh /srv/ai-stack/projects/data/backups/clawboard-prod-*.sql.gz

# Restore the desired backup
./scripts/restore-db.sh clawboard-prod-YYYYMMDD-HHMMSS.sql.gz
```

## Requirements

- Docker access (requires sudo)
- Write permissions to `/srv/ai-stack/projects/data/backups/`
- `clawboard-db` container must be running

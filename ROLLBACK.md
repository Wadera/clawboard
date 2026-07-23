# Rollback Procedure: ClawBoard-Nim → Old NimSpace

## If something breaks after migration:

### Quick Rollback (swap routes back)
1. Edit `/srv/ai-stack/projects/nimspace/traefik/dynamic/nim-dashboard.yml`
2. Swap service URLs:
   - `/dashboard/` → `nim-dashboard-old-nginx` (port 8083)
   - `/api/` → `nim-dashboard-old-backend` (port 3003)
3. Traefik auto-reloads within seconds

### Full Rollback (restore database)
1. Stop clawboard containers: `cd /home/clawd/clawd/projects/clawboard-nim/repo && sudo docker compose -f docker-compose.prod.yml down`
2. Restore from backup: `pg_restore -U nim_prod -d nim_dashboard /mnt/nfs/backups/nim-dashboard/nim-prod-backup-*.dump`
3. Start old containers: `cd /home/clawd/clawd/projects/nim-dashboard/repo && sudo docker compose -f docker-compose.prod.yml up -d`

### Backups Location
- **DB dump:** `/mnt/nfs/backups/nim-dashboard/nim-prod-backup-20260215-*.dump`
- **SQL dump:** `/mnt/nfs/backups/nim-dashboard/nim-prod-backup-20260215-*.sql`
- **Old containers:** Still running on `/dashboard-old/`
- **Traefik backup:** `nim-dashboard.yml.backup`

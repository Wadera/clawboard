#!/bin/bash
# ClawBoard Database Restore Script
# Restores database from a backup file

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}🔄 ClawBoard Database Restore${NC}"
echo "==============================="
echo ""

# Load environment variables
if [ -f .env ]; then
    source .env
else
    echo -e "${RED}❌ Error: .env file not found${NC}"
    echo "Please run this script from the ClawBoard root directory"
    exit 1
fi

# Configuration
CONTAINER_NAME="${DB_CONTAINER_NAME:-clawboard-db}"
DB_NAME="${POSTGRES_DB:-clawboard}"
DB_USER="${POSTGRES_USER:-clawboard}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"

# Check if backup directory exists
if [ ! -d "$BACKUP_DIR" ]; then
    echo -e "${RED}❌ Error: Backup directory '$BACKUP_DIR' not found${NC}"
    exit 1
fi

# List available backups
echo -e "${BLUE}📚 Available backups:${NC}"
echo ""
BACKUPS=($(ls -t "$BACKUP_DIR"/clawboard_*.sql.gz 2>/dev/null || true))

if [ ${#BACKUPS[@]} -eq 0 ]; then
    echo -e "${RED}❌ No backups found in $BACKUP_DIR${NC}"
    echo "Create a backup first with: ./database/backup.sh"
    exit 1
fi

# Display backups with numbers
i=1
for backup in "${BACKUPS[@]}"; do
    SIZE=$(du -h "$backup" | cut -f1)
    FILENAME=$(basename "$backup")
    DATE_TIME=$(echo "$FILENAME" | sed 's/clawboard_\(.*\)\.sql\.gz/\1/' | sed 's/_/ /')
    echo "  [$i] $FILENAME ($SIZE) - $DATE_TIME"
    ((i++))
done

echo ""

# Get backup file (argument or interactive)
if [ -n "$1" ]; then
    if [ -f "$1" ]; then
        BACKUP_FILE="$1"
    elif [ "$1" -ge 1 ] && [ "$1" -le ${#BACKUPS[@]} ]; then
        BACKUP_FILE="${BACKUPS[$((${1}-1))]}"
    else
        echo -e "${RED}❌ Invalid backup selection: $1${NC}"
        exit 1
    fi
else
    read -p "Select backup number to restore [1-${#BACKUPS[@]}]: " SELECTION
    if [ "$SELECTION" -ge 1 ] && [ "$SELECTION" -le ${#BACKUPS[@]} ]; then
        BACKUP_FILE="${BACKUPS[$((${SELECTION}-1))]}"
    else
        echo -e "${RED}❌ Invalid selection${NC}"
        exit 1
    fi
fi

echo ""
echo -e "${YELLOW}⚠️  WARNING: This will DROP and recreate the database!${NC}"
echo "📊 Database: $DB_NAME"
echo "👤 User: $DB_USER"
echo "📦 Container: $CONTAINER_NAME"
echo "💾 Backup file: $(basename "$BACKUP_FILE")"
echo ""

read -p "Are you sure you want to restore? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo -e "${YELLOW}❌ Restore cancelled${NC}"
    exit 0
fi

# Check if container is running
if ! docker ps | grep -q "$CONTAINER_NAME"; then
    echo -e "${RED}❌ Error: Database container '$CONTAINER_NAME' is not running${NC}"
    echo "Start it with: docker compose up -d clawboard-db"
    exit 1
fi

echo ""
echo -e "${YELLOW}Creating safety backup before restore...${NC}"
SAFETY_BACKUP="$BACKUP_DIR/pre-restore_$(date +%Y%m%d_%H%M%S).sql.gz"
docker exec "$CONTAINER_NAME" pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists | gzip > "$SAFETY_BACKUP"
echo -e "${GREEN}✅ Safety backup created: $(basename "$SAFETY_BACKUP")${NC}"

echo ""
echo -e "${YELLOW}Stopping backend container (to avoid connection conflicts)...${NC}"
docker compose stop clawboard-backend 2>/dev/null || true

echo ""
echo -e "${YELLOW}Decompressing and restoring database...${NC}"

# Decompress and restore
gunzip -c "$BACKUP_FILE" | docker exec -i "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Database restored successfully!${NC}"
    echo ""
    echo -e "${YELLOW}Restarting backend container...${NC}"
    docker compose start clawboard-backend
    echo ""
    echo -e "${GREEN}🎉 Restore complete!${NC}"
    echo ""
    echo "✨ Your database has been restored from: $(basename "$BACKUP_FILE")"
    echo "💾 Safety backup saved as: $(basename "$SAFETY_BACKUP")"
else
    echo -e "${RED}❌ Restore failed!${NC}"
    echo ""
    echo -e "${YELLOW}Attempting to restore from safety backup...${NC}"
    gunzip -c "$SAFETY_BACKUP" | docker exec -i "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ Rolled back to safety backup${NC}"
    else
        echo -e "${RED}❌ Rollback failed! Database may be in an inconsistent state${NC}"
        echo "You may need to manually restore or recreate the database"
    fi
    
    docker compose start clawboard-backend 2>/dev/null || true
    exit 1
fi

# Verify restore
echo ""
echo -e "${BLUE}🔍 Verifying restore...${NC}"
TABLES=$(docker exec "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';")
echo "✅ Found $TABLES tables in database"

# Optional: Show table row counts
echo ""
echo "📊 Table statistics:"
docker exec "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -c "
SELECT 
    schemaname || '.' || tablename AS table,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
    n_live_tup AS rows
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
"

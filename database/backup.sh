#!/bin/bash
# ClawBoard Database Backup Script
# Creates timestamped SQL dumps of the ClawBoard database

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🔄 ClawBoard Database Backup${NC}"
echo "=============================="
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
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/clawboard_${TIMESTAMP}.sql"
KEEP_BACKUPS="${KEEP_BACKUPS:-7}"  # Keep last N backups

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Check if container is running
if ! docker ps | grep -q "$CONTAINER_NAME"; then
    echo -e "${RED}❌ Error: Database container '$CONTAINER_NAME' is not running${NC}"
    echo "Start it with: docker compose up -d clawboard-db"
    exit 1
fi

echo "📊 Database: $DB_NAME"
echo "👤 User: $DB_USER"
echo "📦 Container: $CONTAINER_NAME"
echo "💾 Backup file: $BACKUP_FILE"
echo ""

# Create backup
echo -e "${YELLOW}Creating backup...${NC}"
docker exec "$CONTAINER_NAME" pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists > "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    # Compress backup
    echo -e "${YELLOW}Compressing backup...${NC}"
    gzip "$BACKUP_FILE"
    BACKUP_FILE="${BACKUP_FILE}.gz"
    
    # Get file size
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    
    echo -e "${GREEN}✅ Backup completed successfully!${NC}"
    echo "📁 File: $BACKUP_FILE"
    echo "📏 Size: $SIZE"
    echo ""
    
    # Clean up old backups
    if [ "$KEEP_BACKUPS" -gt 0 ]; then
        echo -e "${YELLOW}Cleaning up old backups (keeping last $KEEP_BACKUPS)...${NC}"
        OLD_BACKUPS=$(ls -t "$BACKUP_DIR"/clawboard_*.sql.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)))
        
        if [ -n "$OLD_BACKUPS" ]; then
            echo "$OLD_BACKUPS" | while read file; do
                echo "🗑️  Removing: $(basename "$file")"
                rm "$file"
            done
        else
            echo "✨ No old backups to clean up"
        fi
    fi
    
    echo ""
    echo -e "${GREEN}🎉 Backup complete!${NC}"
    
    # Show available backups
    echo ""
    echo "📚 Available backups:"
    ls -lh "$BACKUP_DIR"/clawboard_*.sql.gz 2>/dev/null | awk '{print "   " $9 " (" $5 ")"}'
    
else
    echo -e "${RED}❌ Backup failed!${NC}"
    rm -f "$BACKUP_FILE"  # Clean up partial backup
    exit 1
fi

# Optional: Upload to remote storage (uncomment and configure)
# echo ""
# echo -e "${YELLOW}Uploading to remote storage...${NC}"
# rclone copy "$BACKUP_FILE" remote:backups/clawboard/
# echo -e "${GREEN}✅ Uploaded to remote storage${NC}"

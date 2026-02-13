#!/bin/bash
# ClawBoard Quick Setup
# Interactive configuration for first-time deployment

set -e  # Exit on error

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

echo -e "${GREEN}"
echo "╔══════════════════════════════════════╗"
echo "║     🔌 ClawBoard Quick Setup        ║"
echo "╔══════════════════════════════════════╗"
echo -e "${NC}"
echo ""

# Check prerequisites
echo -e "${BLUE}Checking prerequisites...${NC}"
echo ""

command -v docker >/dev/null 2>&1 || {
    echo -e "${RED}❌ Docker is required but not installed${NC}"
    echo "Install from: https://docs.docker.com/get-docker/"
    exit 1
}
echo -e "${GREEN}✅ Docker found: $(docker --version)${NC}"

command -v docker compose >/dev/null 2>&1 || {
    echo -e "${RED}❌ Docker Compose is required but not installed${NC}"
    echo "Install from: https://docs.docker.com/compose/install/"
    exit 1
}
echo -e "${GREEN}✅ Docker Compose found${NC}"

command -v openssl >/dev/null 2>&1 || {
    echo -e "${YELLOW}⚠️  OpenSSL not found (optional, needed for JWT secret generation)${NC}"
}

echo ""
echo -e "${GREEN}All prerequisites satisfied!${NC}"
echo ""

# Check if .env exists
if [ -f .env ]; then
    echo -e "${YELLOW}⚠️  .env file already exists${NC}"
    read -p "Do you want to reconfigure? (yes/no) [no]: " RECONFIGURE
    RECONFIGURE=${RECONFIGURE:-no}
    
    if [ "$RECONFIGURE" != "yes" ]; then
        echo -e "${BLUE}Keeping existing .env configuration${NC}"
        echo ""
        echo -e "${GREEN}Setup complete! Run:${NC}"
        echo -e "  ${PURPLE}docker compose up -d${NC}"
        exit 0
    fi
    
    # Backup existing .env
    BACKUP=".env.backup.$(date +%Y%m%d_%H%M%S)"
    cp .env "$BACKUP"
    echo -e "${GREEN}✅ Backed up existing .env to: $BACKUP${NC}"
    echo ""
fi

# Copy template
if [ ! -f .env.example ]; then
    echo -e "${RED}❌ Error: .env.example not found${NC}"
    exit 1
fi

cp .env.example .env
echo -e "${GREEN}✅ Created .env from template${NC}"
echo ""

# Generate config if not exists
if [ ! -f clawboard.config.json ]; then
    if [ -f clawboard.config.example.json ]; then
        cp clawboard.config.example.json clawboard.config.json
        echo -e "${GREEN}✅ Created clawboard.config.json from example${NC}"
    else
        echo -e "${YELLOW}⚠️  clawboard.config.example.json not found, skipping${NC}"
    fi
    echo ""
fi

# Interactive configuration
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Configuration${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# OpenClaw directory
echo -e "${PURPLE}1. OpenClaw Directory${NC}"
echo "   Location of your OpenClaw installation"
read -p "   Path [~/.openclaw]: " OPENCLAW_DIR
OPENCLAW_DIR=${OPENCLAW_DIR:-~/.openclaw}

# Expand tilde
OPENCLAW_DIR="${OPENCLAW_DIR/#\~/$HOME}"

# Validate OpenClaw directory
if [ ! -d "$OPENCLAW_DIR" ]; then
    echo -e "${YELLOW}   ⚠️  Warning: Directory does not exist: $OPENCLAW_DIR${NC}"
    read -p "   Continue anyway? (yes/no) [no]: " CONTINUE
    if [ "$CONTINUE" != "yes" ]; then
        echo -e "${RED}❌ Setup cancelled${NC}"
        exit 1
    fi
elif [ ! -f "$OPENCLAW_DIR/openclaw.json" ]; then
    echo -e "${YELLOW}   ⚠️  Warning: openclaw.json not found in directory${NC}"
    read -p "   Continue anyway? (yes/no) [no]: " CONTINUE
    if [ "$CONTINUE" != "yes" ]; then
        echo -e "${RED}❌ Setup cancelled${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}   ✅ OpenClaw directory found${NC}"
fi

sed -i.bak "s|OPENCLAW_DIR=.*|OPENCLAW_DIR=$OPENCLAW_DIR|" .env
echo ""

# Domain
echo -e "${PURPLE}2. Domain${NC}"
echo "   Domain name for the dashboard (use 'localhost' for local development)"
read -p "   Domain [localhost]: " DOMAIN
DOMAIN=${DOMAIN:-localhost}
sed -i.bak "s|DOMAIN=.*|DOMAIN=$DOMAIN|" .env
echo -e "${GREEN}   ✅ Domain set to: $DOMAIN${NC}"
echo ""

# Database password
echo -e "${PURPLE}3. Database Password${NC}"
echo "   Secure password for PostgreSQL database"
read -p "   Generate random password? (yes/no) [yes]: " GENERATE_DB_PASS
GENERATE_DB_PASS=${GENERATE_DB_PASS:-yes}

if [ "$GENERATE_DB_PASS" = "yes" ]; then
    if command -v openssl >/dev/null 2>&1; then
        DB_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
    else
        DB_PASSWORD=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)
    fi
    echo -e "${GREEN}   ✅ Generated random password${NC}"
else
    read -sp "   Enter password: " DB_PASSWORD
    echo ""
fi

sed -i.bak "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$DB_PASSWORD|" .env
echo ""

# JWT secret
echo -e "${PURPLE}4. JWT Secret${NC}"
echo "   Secret key for authentication tokens"

if command -v openssl >/dev/null 2>&1; then
    JWT_SECRET=$(openssl rand -hex 64)
    sed -i.bak "s|JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" .env
    echo -e "${GREEN}   ✅ Generated random JWT secret${NC}"
else
    echo -e "${YELLOW}   ⚠️  OpenSSL not available, using placeholder${NC}"
    echo -e "${YELLOW}   Please manually update JWT_SECRET in .env${NC}"
fi
echo ""

# Login password
echo -e "${PURPLE}5. Dashboard Login Password${NC}"
echo "   Password to access the dashboard UI"
read -sp "   Enter password [changeme]: " LOGIN_PASS
echo ""
LOGIN_PASS=${LOGIN_PASS:-changeme}

# Generate bcrypt hash
echo -e "${BLUE}   Generating password hash...${NC}"
PASSWORD_HASH=$(docker run --rm node:18-alpine sh -c "npm install --no-save bcryptjs 2>/dev/null && node -e \"const b=require('bcryptjs');b.hash('${LOGIN_PASS}',10).then(h=>console.log(h))\"" 2>/dev/null)

if [ $? -eq 0 ] && [ ! -z "$PASSWORD_HASH" ]; then
    # Escape $ for Docker Compose ($ -> $$)
    ESCAPED_HASH=$(echo "$PASSWORD_HASH" | sed 's/\$/\$\$/g')
    sed -i.bak "s|DASHBOARD_PASSWORD_HASH=.*|DASHBOARD_PASSWORD_HASH=$ESCAPED_HASH|" .env
    echo -e "${GREEN}   ✅ Login password hash generated${NC}"
else
    echo -e "${RED}   ❌ Failed to generate password hash${NC}"
    echo -e "${YELLOW}   You can generate it manually: node scripts/hash-password.js${NC}"
    echo -e "${YELLOW}   Then update DASHBOARD_PASSWORD_HASH in .env (escape \$ as \$\$)${NC}"
    sed -i.bak "s|DASHBOARD_PASSWORD_HASH=.*|DASHBOARD_PASSWORD_HASH=$LOGIN_PASS|" .env
fi
echo ""

# Frontend port
echo -e "${PURPLE}6. Frontend Port${NC}"
echo "   Port for accessing the dashboard"
read -p "   Port [8080]: " FRONTEND_PORT
FRONTEND_PORT=${FRONTEND_PORT:-8080}
sed -i.bak "s|FRONTEND_PORT=.*|FRONTEND_PORT=$FRONTEND_PORT|" .env
echo -e "${GREEN}   ✅ Frontend port set to: $FRONTEND_PORT${NC}"
echo ""

# Clean up backup files
rm -f .env.bak

# Summary
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Configuration Summary${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""
echo "📝 Configuration:"
echo "   • OpenClaw: $OPENCLAW_DIR"
echo "   • Domain: $DOMAIN"
echo "   • Frontend Port: $FRONTEND_PORT"
echo "   • Database: PostgreSQL 16"
echo "   • Config: ./clawboard.config.json"
echo ""
echo -e "${YELLOW}📂 Created directories:${NC}"
mkdir -p data backups
echo "   • ./data/ (runtime data)"
echo "   • ./backups/ (database backups)"
echo ""

# Next steps
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Next Steps${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}1. Start ClawBoard:${NC}"
echo -e "   ${PURPLE}docker compose up -d${NC}"
echo ""
echo -e "${GREEN}2. Check status:${NC}"
echo -e "   ${PURPLE}docker compose ps${NC}"
echo ""
echo -e "${GREEN}3. View logs:${NC}"
echo -e "   ${PURPLE}docker compose logs -f${NC}"
echo ""
echo -e "${GREEN}4. Access dashboard:${NC}"
echo -e "   ${PURPLE}http://${DOMAIN}:${FRONTEND_PORT}${NC}"
echo ""
echo -e "${GREEN}5. Create a database backup:${NC}"
echo -e "   ${PURPLE}./database/backup.sh${NC}"
echo ""
echo -e "${YELLOW}⚠️  Important:${NC}"
echo "   • Keep your .env file secure (it contains passwords)"
echo "   • Back up your database regularly"
echo "   • Update DOMAIN and enable SSL for production deployments"
echo ""
echo -e "${BLUE}📚 Documentation:${NC}"
echo "   • Mount points: docs/mount-points.md"
echo "   • Traefik setup: proxy/traefik/README.md"
echo "   • Nginx setup: proxy/nginx/README.md"
echo ""
echo -e "${GREEN}Happy coding! 🚀${NC}"

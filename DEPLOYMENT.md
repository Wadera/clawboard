# ClawBoard Deployment Guide

Complete infrastructure is now in place for deploying ClawBoard from scratch.

## Quick Start (5 minutes)

```bash
# 1. Clone repository
git clone ssh://git@git.skyday.eu:222/Homelab/ClawBoard.git
cd ClawBoard

# 2. Run interactive setup
./setup.sh

# 3. Start services
docker compose up -d

# 4. Access dashboard
# Open: http://localhost:8082 (or your configured domain)
```

## What's Included

### Core Files
- ✅ `docker-compose.yml` - Production stack (clean, env-var based)
- ✅ `docker-compose.dev.yml` - Development stack (HMR, bind mounts)
- ✅ `setup.sh` - Interactive configuration wizard
- ✅ `.env.example` - All environment variables documented

### Database
- ✅ `database/init.sql` - Complete schema (single source of truth)
- ✅ `database/seed.sql` - Sample data (optional)
- ✅ `database/backup.sh` - Backup script
- ✅ `database/restore.sh` - Restore script
- ✅ `database/README.md` - Full documentation
- ✅ `database/migrations/` - Historical migrations (reference)

### Proxy Configurations
- ✅ `proxy/traefik/` - Traefik v3 with auto-SSL
  - `traefik.yml` - Static config
  - `dynamic.yml` - Dynamic config
  - `docker-compose.traefik.yml` - Standalone deployment
  - `README.md` - Setup instructions
- ✅ `proxy/nginx/` - Alternative nginx config
  - `nginx.conf` - Production-ready config
  - `README.md` - Setup instructions

### Documentation
- ✅ `docs/mount-points.md` - All volume requirements
- ✅ `database/README.md` - Database management
- ✅ `proxy/traefik/README.md` - Traefik setup
- ✅ `proxy/nginx/README.md` - Nginx setup
- ✅ `README.md` - Main project documentation

### Docker Configuration
- ✅ Clean Dockerfiles (multi-stage builds)
- ✅ Proper `.dockerignore` files
- ✅ Health checks on all services
- ✅ Non-root users for security
- ✅ Named volumes for persistence

## Deployment Options

### Option 1: Local Development
```bash
./setup.sh
docker compose up -d
```
Access: `http://localhost:8082`

### Option 2: Production with Traefik
```bash
# Setup ClawBoard
./setup.sh
# Edit .env and set DOMAIN=your-domain.com

# Start Traefik
cd proxy/traefik
# Edit traefik.yml (set email for Let's Encrypt)
docker compose -f docker-compose.traefik.yml up -d

# Enable Traefik labels in docker-compose.yml
# Uncomment all "traefik.*" labels

# Start ClawBoard
cd ../..
docker compose up -d
```
Access: `https://your-domain.com`

### Option 3: Production with nginx
```bash
# Setup ClawBoard
./setup.sh

# Configure nginx
sudo cp proxy/nginx/nginx.conf /etc/nginx/sites-available/clawboard
# Edit and update domain
sudo nano /etc/nginx/sites-available/clawboard
sudo ln -s /etc/nginx/sites-available/clawboard /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Get SSL certificate
sudo certbot certonly --webroot -w /var/www/certbot -d your-domain.com

# Start ClawBoard
docker compose up -d
```
Access: `https://your-domain.com`

## Environment Variables

All configurable via `.env`:

```bash
# Database
POSTGRES_PASSWORD=changeme

# Auth
JWT_SECRET=random-hex-string
LOGIN_PASSWORD=dashboard-password

# OpenClaw
OPENCLAW_DIR=~/.openclaw
OPENCLAW_GATEWAY_URL=ws://localhost:3120

# Deployment
DOMAIN=localhost
FRONTEND_PORT=8082
```

## Security Checklist

- ✅ No hardcoded secrets (all via .env)
- ✅ Database not exposed to host
- ✅ Non-root container users
- ✅ Read-only OpenClaw mounts
- ✅ Strong password requirements
- ✅ HTTPS via Traefik/nginx
- ✅ Security headers configured

## Testing Deployment

```bash
# Check all services are running
docker compose ps

# Check health status
docker compose ps clawboard-db
docker compose ps clawboard-backend
docker compose ps clawboard-frontend

# View logs
docker compose logs -f

# Create a backup
./database/backup.sh

# Test restore
./database/restore.sh
```

## Migration from ClawBoard

ClawBoard is a fork with no personal references. Key differences:

| ClawBoard | ClawBoard |
|--------------|-----------|
| `/clawdbot/sessions` | `/openclaw/sessions` |
| Hardcoded paths | Environment variables |
| `docker-compose.prod.yml` | `docker-compose.yml` |
| No setup script | Interactive `setup.sh` |
| Manual backup | Automated scripts |

## Commit

Deployment infrastructure: **40095d6**
- 18 files changed
- 2,390 insertions
- Complete from-scratch deployment ready

## Next Steps

1. **Test deployment** - Run `setup.sh` and `docker compose up -d`
2. **Verify Traefik** - Test SSL certificate generation
3. **Test backup/restore** - Ensure database scripts work
4. **Load test** - Verify performance under load
5. **Documentation review** - Ensure all docs are accurate

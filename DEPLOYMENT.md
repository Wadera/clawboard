# ClawBoard Deployment Guide

Complete infrastructure is now in place for deploying ClawBoard from scratch.

## Quick Start (5 minutes)

```bash
# 1. Clone repository
git clone https://github.com/yourusername/clawboard.git
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
Access: `http://localhost:8080/dashboard/`

**Note:** The dashboard is served at `/dashboard/` path. Root `/` redirects to `/dashboard/`.

### Option 2: Production with Traefik (Recommended)

ClawBoard works seamlessly behind Traefik with automatic SSL certificates.

**Step 1: Add Traefik labels to docker-compose.yml**

```yaml
services:
  clawboard-frontend:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.clawboard.rule=Host(`${DOMAIN}`)"
      - "traefik.http.routers.clawboard.entrypoints=websecure"
      - "traefik.http.routers.clawboard.tls.certresolver=letsencrypt"
      - "traefik.http.services.clawboard.loadbalancer.server.port=80"
      
      # Redirect root to /dashboard/
      - "traefik.http.middlewares.clawboard-redirect.redirectregex.regex=^https://([^/]+)/?$$"
      - "traefik.http.middlewares.clawboard-redirect.redirectregex.replacement=https://$$1/dashboard/"
      - "traefik.http.routers.clawboard.middlewares=clawboard-redirect"
```

**Step 2: Configure environment**

```bash
# In .env
DOMAIN=clawboard.yourdomain.com
FRONTEND_PORT=8080  # Internal port, Traefik handles external access
```

**Step 3: Add to Traefik network**

```yaml
networks:
  clawboard-network:
    name: clawboard_network
    driver: bridge
  traefik-public:
    external: true
    name: traefik-public
```

Update all services to use both networks:

```yaml
services:
  clawboard-frontend:
    networks:
      - clawboard-network
      - traefik-public
```

**Step 4: Deploy**

```bash
./setup.sh
docker compose up -d
```

Access: `https://clawboard.yourdomain.com/dashboard/`

### Option 3: Production with External Nginx

For nginx running on the host (not in Docker), use this reverse proxy config:

**File: `/etc/nginx/sites-available/clawboard`**

```nginx
upstream clawboard_frontend {
    server localhost:8080;
}

server {
    listen 80;
    server_name clawboard.yourdomain.com;
    
    # Redirect HTTP to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name clawboard.yourdomain.com;

    # SSL certificates (use certbot)
    ssl_certificate /etc/letsencrypt/live/clawboard.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/clawboard.yourdomain.com/privkey.pem;
    
    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Root redirect to /dashboard/
    location = / {
        return 302 /dashboard/;
    }

    # Proxy all requests to ClawBoard frontend container
    location / {
        proxy_pass http://clawboard_frontend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support (proxied through nginx in container, but add here for external nginx)
    location /ws {
        proxy_pass http://clawboard_frontend/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
}
```

**Deploy:**

```bash
# 1. Setup ClawBoard
./setup.sh

# 2. Configure nginx
sudo nano /etc/nginx/sites-available/clawboard
# Update domain name
sudo ln -s /etc/nginx/sites-available/clawboard /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 3. Get SSL certificate
sudo certbot certonly --nginx -d clawboard.yourdomain.com

# 4. Start ClawBoard
docker compose up -d
```

Access: `https://clawboard.yourdomain.com/dashboard/`

### Important: Base Path Configuration

ClawBoard is **always served at `/dashboard/` path**, not at root `/`:

- ✅ **Correct:** `https://yourdomain.com/dashboard/`
- ❌ **Wrong:** `https://yourdomain.com/`

**Why?**
- The frontend is built with `base: '/dashboard/'` in vite.config.ts
- Nginx serves assets at `/dashboard/` location
- Root `/` redirects to `/dashboard/` automatically

**Reverse proxy considerations:**
- Preserve the `/dashboard/` path in your proxy rules
- Don't strip the path prefix
- WebSocket connections are at `/ws` (not `/dashboard/ws`)

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

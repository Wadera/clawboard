# Getting Started with ClawBoard

Get your AI dashboard running in 5 minutes.

## Prerequisites

- **Docker** & **Docker Compose** (v2.x+)
- **OpenClaw** installed and running on the host
- **2 GB RAM**, 1 CPU core minimum

```bash
# Verify prerequisites
docker --version          # Docker 20+
docker compose version    # Compose v2+
openclaw status           # OpenClaw running
```

## 1. Clone the Repository

```bash
git clone https://github.com/yourusername/clawboard.git
cd clawboard
```

## 2. Configure

### Option A: Interactive Setup (Recommended)

```bash
./setup.sh
```

The script walks you through setting:
- Database password
- JWT secret (for authentication)
- Dashboard login password
- OpenClaw directory path

### Option B: Manual Setup

```bash
cp .env.example .env
nano .env
```

At minimum, set these three values:

```bash
POSTGRES_PASSWORD=your-secure-random-password
JWT_SECRET=your-random-hex-string        # generate: openssl rand -hex 64
LOGIN_PASSWORD=your-dashboard-password
```

Then copy and customize the config:

```bash
cp clawboard.config.example.json clawboard.config.json
```

## 3. Start ClawBoard

```bash
docker compose up -d
```

Wait for all three services to become healthy:

```bash
docker compose ps
# Expected: clawboard-db, clawboard-backend, clawboard-frontend all "healthy"
```

## 4. Open Your Dashboard

Navigate to **http://localhost:8082** and log in with the password you set in `.env`.

---

## Customizing Your Dashboard

Edit `clawboard.config.json` to personalize:

```json
{
  "bot": {
    "name": "MyBot",
    "displayName": "My AI Dashboard",
    "emoji": "🤖",
    "description": "Personal AI command center"
  },
  "branding": {
    "primaryColor": "#6366f1",
    "accentColor": "#8b5cf6",
    "sidebarTitle": "MyBoard"
  },
  "features": {
    "taskBoard": true,
    "projects": true,
    "journal": true,
    "imageGeneration": false,
    "stats": true
  }
}
```

After editing, restart the backend:

```bash
docker compose restart clawboard-backend
```

## Adding Your First Plugin

ClawBoard V2 supports Docker-based plugins. See the [Example Plugin](./example-plugin/) for a minimal hello-world, or the full [Plugin Development Guide](./plugin-development.md).

Quick steps:

1. Create a plugin directory with `plugin.json`, `Dockerfile`, and your server code
2. Add it to `clawboard.plugins.json`:
   ```json
   {
     "plugins": [
       {
         "name": "my-plugin",
         "source": "./plugins/my-plugin",
         "enabled": true
       }
     ]
   }
   ```
3. Restart ClawBoard: `docker compose up -d --build`

## OpenClaw Integration

ClawBoard connects to OpenClaw in two ways:

1. **Session files** — Mounted read-only from `~/.openclaw/agents/main/sessions/`
2. **Gateway WebSocket** — Live status updates from the OpenClaw gateway (default: `ws://localhost:3120`)

Set `OPENCLAW_DIR` in `.env` to point to your OpenClaw installation directory.

## Development Mode

For local development with hot reload:

```bash
docker compose -f docker-compose.dev.yml up
```

This mounts source code directly and enables HMR for both frontend and backend.

## Next Steps

- 📖 [Plugin Development Guide](./plugin-development.md) — Build custom plugins
- 🏗️ [Project Overview](./PROJECT-OVERVIEW.md) — Architecture deep dive
- 🗄️ [Database Guide](../database/README.md) — Backup, restore, schema
- 🔀 [Deployment Options](../DEPLOYMENT.md) — Traefik, Nginx, production setup

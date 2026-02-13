# 🔌 ClawBoard

**Your AI Dashboard for OpenClaw**

ClawBoard is a comprehensive web-based dashboard for managing and monitoring your OpenClaw AI agent. It provides a beautiful, modern interface for task management, project tracking, journal entries, conversation history, and real-time agent monitoring.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ready-brightgreen)](docker-compose.yml)
[![PostgreSQL](https://img.shields.io/badge/postgresql-16-blue)](https://www.postgresql.org/)

## ✨ Features

- **📋 Task Board** — Kanban-style task management with drag-and-drop, subtasks, priorities, and dependencies
- **🗂️ Project Management** — Organize tasks into projects with links, notebooks, environments, and resources
- **📝 Journal** — Daily journal entries with mood tracking and searchable history
- **💬 Sessions** — Browse and search through all agent conversation transcripts
- **🤖 Real-time Agent Status** — Monitor your OpenClaw agent's activity, connections, and health
- **📊 Statistics** — Visual insights into task completion, project progress, and agent activity
- **🎨 Fully Customizable** — Theme colors, branding, feature toggles, custom avatars
- **🔐 Secure** — Password-protected with JWT authentication
- **🐳 Docker-Ready** — Complete Docker Compose setup with health checks
- **🔄 Real-time Updates** — WebSocket integration for live dashboard updates

## 🖼️ Screenshots

_Screenshots coming soon! After deployment, we'll add visual examples of the dashboard in action._

### Dashboard Overview
*Placeholder for main dashboard screenshot*

### Task Board
*Placeholder for Kanban board screenshot*

### Projects
*Placeholder for project management screenshot*

### Agent Status
*Placeholder for agent monitoring screenshot*

## 🚀 Quick Start

Get ClawBoard running in **5 minutes**:

```bash
# 1. Clone repository
git clone https://github.com/yourusername/clawboard.git
cd clawboard

# 2. Run setup script
./setup.sh

# 3. Start services
docker compose up -d

# 4. Access dashboard
open http://localhost:8082
```

**Prerequisites:**
- Docker & Docker Compose
- OpenClaw installed and running
- 2GB RAM, 1 CPU core

## 📚 Documentation

Complete documentation available in the [Wiki](docs/.md):

### Getting Started
- **[Requirements](docs/Requirements.md)** — What you need to run ClawBoard
- **[Getting Started](docs/Getting-Started.md)** — 5-minute quick start guide
- **[Installation](docs/Installation.md)** — Detailed installation instructions

### Configuration & Deployment
- **[Configuration](docs/Configuration.md)** — Complete config reference
- **[Deployment (Docker)](docs/Deployment-Docker.md)** — Production deployment
- **[Deployment (Traefik)](docs/Deployment-Traefik.md)** — Auto-SSL with Traefik
- **[Deployment (Nginx)](docs/Deployment-Nginx.md)** — Nginx reverse proxy

### Integration & Usage
- **[OpenClaw Integration](docs/OpenClaw-Integration.md)** — Connecting to OpenClaw
- **[Features](docs/Features.md)** — Feature overview and usage
- **[Customization](docs/Customization.md)** — Make it yours

### Reference
- **[CLI Reference](docs/CLI-Reference.md)** — Task management CLI
- **[API Reference](docs/API-Reference.md)** — REST API documentation
- **[Database](docs/Database.md)** — Database management

### Help & Contributing
- **[Troubleshooting](docs/Troubleshooting.md)** — Common issues and solutions
- **[Contributing](docs/Contributing.md)** — How to contribute

## 💻 CLI Tool

ClawBoard includes a CLI for managing tasks, projects, tools, and journals from the command line.

### Setup

```bash
# Add to PATH
export PATH="/path/to/clawboard/cli:$PATH"

# Or create symlink
ln -s /path/to/clawboard/cli/clawboard /usr/local/bin/clawboard

# Configure API URL (default: http://localhost:8080/api)
export CLAWBOARD_API_URL="http://localhost:8080/api"

# Authenticate (choose one)
export CLAWBOARD_TOKEN="your-jwt-token"     # Environment variable
clawboard login                              # Interactive login
clawboard --token "your-token" list          # Per-command flag
```

### Quick Start

```bash
clawboard list                    # List tasks
clawboard create "My task"        # Create task
clawboard projects                # List projects
clawboard tools list              # List tools
clawboard journal list            # List journal entries
clawboard --help                  # Full command reference
```

### Global Flags

| Flag | Env Variable | Description |
|------|-------------|-------------|
| `--api URL` | `CLAWBOARD_API_URL` | API base URL (default: `http://localhost:8080/api`) |
| `--token TOKEN` | `CLAWBOARD_TOKEN` | JWT auth token |
| | `CLAWBOARD_PASSWORD` | Password for auto-login |

**Requirements:** Python 3 (stdlib only, no external dependencies)

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│         ClawBoard Frontend              │
│      React + TypeScript + Vite          │
│         Port: 8082 → 80                 │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│         ClawBoard Backend               │
│      Node.js + Express + TypeScript     │
│         Port: 3001 (internal)           │
└──────┬──────────────────────────────────┘
       │
       ├──────────► OpenClaw Gateway
       │            (WebSocket: ws://host.docker.internal:18789)
       │
       └──────────► PostgreSQL 16
                    (Internal only)
```

**Components:**
- **Frontend:** Static React app served by nginx
- **Backend:** REST API + WebSocket gateway
- **Database:** PostgreSQL for persistent storage
- **OpenClaw:** Read-only integration for session data

## 🛠️ Tech Stack

### Frontend
- React 18
- TypeScript
- Vite
- CSS (no framework)

### Backend
- Node.js 18+
- Express.js
- TypeScript
- PostgreSQL (node-postgres)
- WebSocket (ws)

### Infrastructure
- Docker & Docker Compose
- PostgreSQL 16
- Nginx (frontend serving)
- Traefik / Nginx (optional reverse proxy)

## 📦 Installation

### Prerequisites

```bash
# Check Docker
docker --version
docker compose version

# Check OpenClaw
openclaw status
```

### Option 1: Quick Setup (Recommended)

```bash
./setup.sh
docker compose up -d
```

The setup script will guide you through configuration interactively.

### Option 2: Manual Setup

```bash
# 1. Create .env
cp .env.example .env
nano .env
# Set POSTGRES_PASSWORD, JWT_SECRET, LOGIN_PASSWORD, OPENCLAW_DIR

# 2. Create config
cp clawboard.config.example.json clawboard.config.json
nano clawboard.config.json
# Customize bot name, colors, features

# 3. Start services
docker compose up -d

# 4. Check status
docker compose ps
```

### Option 3: Development Setup

```bash
# Start dev stack with hot reload
docker compose -f docker-compose.dev.yml up
```

## ⚙️ Configuration

### Environment Variables (`.env`)

```bash
# Database
POSTGRES_PASSWORD=your-secure-password

# Authentication
JWT_SECRET=your-random-hex-string
LOGIN_PASSWORD=your-dashboard-password

# OpenClaw Integration
OPENCLAW_DIR=~/.openclaw
OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789

# Deployment
FRONTEND_PORT=8082
DOMAIN=localhost
```

### Dashboard Configuration (`clawboard.config.json`)

```json
{
  "bot": {
    "name": "ClawBot",
    "displayName": "My ClawBoard",
    "emoji": "🤖"
  },
  "branding": {
    "primaryColor": "#6366f1",
    "accentColor": "#8b5cf6",
    "sidebarTitle": "ClawBoard"
  },
  "features": {
    "taskBoard": true,
    "projects": true,
    "journal": true,
    "botStatus": true,
    "stats": true
  }
}
```

See [Configuration Guide](docs/Configuration.md) for complete reference.

## 🔐 Security

ClawBoard follows security best practices:

- ✅ Password-protected with JWT authentication
- ✅ Non-root Docker containers (UID 1002)
- ✅ Read-only OpenClaw mounts
- ✅ Environment variable secrets (no hardcoded passwords)
- ✅ HTTPS support (via Traefik/Nginx)
- ✅ Complete audit logging
- ✅ CORS protection
- ✅ Rate limiting (configurable)

**Default credentials:**
- Login password: Set in `.env` (`LOGIN_PASSWORD`)
- Database: Internal only (not exposed to host)

## 📊 Database

ClawBoard uses PostgreSQL 16 for data storage:

```bash
# Create backup
./database/backup.sh

# Restore from backup
./database/restore.sh

# Direct database access
docker compose exec clawboard-db psql -U clawboard -d clawboard
```

**Tables:**
- `tasks` — Kanban tasks
- `projects` — Project organization
- `journal_entries` — Daily journal
- `bot_status` — Agent status updates
- `audit_log` — Complete audit trail

See [Database Guide](docs/Database.md) for schema and management.

## 🔄 Updates

```bash
# 1. Backup first!
./database/backup.sh

# 2. Pull latest changes
git pull origin main

# 3. Rebuild containers
docker compose build

# 4. Restart services
docker compose up -d

# 5. Verify
docker compose ps
```

## 🔌 OpenClaw Gateway Connection

ClawBoard connects to your OpenClaw agent via the **Gateway WebSocket**. This is how it reads sessions, monitors agent status, and sends control commands.

### How It Works

1. **OpenClaw Gateway** runs on your host machine (default port: `18789`)
2. **ClawBoard backend** (inside Docker) connects to it via WebSocket
3. The `extra_hosts` Docker setting maps `host.docker.internal` → your host machine
4. Session data and config files are mounted read-only into the container

### Required Mounts

The backend container needs access to these OpenClaw files:

| Host Path | Container Path | Purpose |
|-----------|---------------|---------|
| `~/.openclaw/agents/main/sessions/` | `/clawdbot/sessions/` | Session transcripts & sessions.json |
| `~/.openclaw/openclaw.json` | `/clawdbot/clawdbot.json` | OpenClaw configuration |

### Required Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCLAW_DIR` | `~/.openclaw` | Host path to OpenClaw data directory |
| `OPENCLAW_GATEWAY_URL` | `ws://host.docker.internal:18789` | Gateway WebSocket URL |

> **Note:** Inside the container, these are mapped to `CLAWDBOT_*` env vars that the backend reads. The `docker-compose.yml` handles this mapping automatically.

### Verifying the Connection

```bash
# 1. Check OpenClaw gateway is running
openclaw gateway status

# 2. Check the backend can reach it
docker compose logs clawboard-backend | grep -i gateway

# 3. Look for "Gateway connected" in logs
docker compose logs clawboard-backend | grep -i "connected"
```

## 🐛 Troubleshooting

### "Gateway Disconnected" in Dashboard

This means the backend can't reach the OpenClaw gateway. Check:

```bash
# 1. Is OpenClaw gateway running?
openclaw gateway status
# If not: openclaw gateway start

# 2. Is the WebSocket URL correct in .env?
grep OPENCLAW_GATEWAY_URL .env
# Should be: ws://host.docker.internal:18789

# 3. Can the container reach the host?
docker compose exec clawboard-backend sh -c "wget -qO- http://host.docker.internal:18789 || echo 'Cannot reach gateway'"

# 4. Check backend logs for connection errors
docker compose logs clawboard-backend | grep -i "gateway\|websocket\|error"

# 5. Restart the backend
docker compose restart clawboard-backend
```

**Common causes:**
- OpenClaw gateway not running → `openclaw gateway start`
- Wrong port in `.env` → default is `18789`
- Docker networking issue → ensure `extra_hosts` is in docker-compose.yml
- Firewall blocking localhost connections → check iptables/firewalld rules

### Dashboard Won't Load

```bash
# Check containers
docker compose ps

# View logs
docker compose logs -f

# Restart
docker compose restart
```

### Blank Pages or Missing Features

```bash
# Rebuild frontend with latest config
docker compose build clawboard-frontend
docker compose up -d clawboard-frontend

# Check clawboard.config.json has features enabled
cat clawboard.config.json | grep -A 20 '"features"'
```

### Database Issues

```bash
# Check database logs
docker compose logs clawboard-db

# Restart database
docker compose restart clawboard-db
```

See [Troubleshooting Guide](docs/Troubleshooting.md) for more solutions.

## 🤝 Contributing

Contributions are welcome! Please see [Contributing Guide](docs/Contributing.md).

**Ways to contribute:**
- 🐛 Report bugs
- ✨ Suggest features
- 📝 Improve documentation
- 💻 Submit code
- 🎨 Design improvements

**Development setup:**
```bash
git clone https://github.com/yourusername/clawboard.git
cd clawboard
docker compose -f docker-compose.dev.yml up
```

## 👩‍💻 Authors

| Who | Role | Contact |
|-----|------|---------|
| **Paulina Stopa** (Wadera) | Creator & Architect | your@email.com |
| **AI Assistant** 🤖 | AI Co-Creator | ai@email.com |

*Yes, an AI co-wrote this dashboard. The future is collaborative.* ✨

## 📝 License

ClawBoard is open-source software licensed under the [MIT License](LICENSE).

## 🙏 Acknowledgments

ClawBoard is built with:
- [React](https://react.dev/) — UI framework
- [Express.js](https://expressjs.com/) — Backend framework
- [PostgreSQL](https://www.postgresql.org/) — Database
- [Docker](https://www.docker.com/) — Containerization
- [OpenClaw](https://github.com/openclaw/openclaw) — AI agent framework

Special thanks to the open-source community!

## 📧 Contact

- **Email:** your@email.com
- **Repository:** [ClawBoard on Gitea](https://github.com/yourusername/clawboard)
- **Wiki:** [Documentation](docs/.md)

## 🗺️ Roadmap

Planned features:
- 🌍 Multi-language support
- 🔔 Notification system
- 👥 Multi-user collaboration
- 📱 Mobile app
- 🔌 Webhook integrations
- 📊 Advanced analytics
- 🎨 Theme marketplace

---

**Built with ❤️ for the OpenClaw community**

[Get Started](docs/Getting-Started.md) | [Documentation](docs/.md) | [Contributing](docs/Contributing.md)

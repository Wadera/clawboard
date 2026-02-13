# 🔌 ClawBoard

**Your AI Dashboard for OpenClaw**

ClawBoard is a comprehensive web-based dashboard for managing and monitoring your OpenClaw AI agent. It provides a beautiful, modern interface for task management, project tracking, journal entries, conversation history, and real-time agent monitoring.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ready-brightgreen)](docker-compose.yml)
[![PostgreSQL](https://img.shields.io/badge/postgresql-16-blue)](https://www.postgresql.org/)

> **Primary repository:** [git.skyday.eu/Homelab/ClawBoard](https://git.skyday.eu/Homelab/ClawBoard) — GitHub mirror coming soon.

## ✨ Features

- **📋 Task Board** — Kanban-style task management with drag-and-drop, subtasks, priorities, and dependencies
- **🗂️ Project Management** — Organize tasks into projects with links, notebooks, environments, and resources
- **📝 Journal** — Daily journal entries with mood tracking, multi-entry per day, and navigation
- **💬 Sessions** — Browse and search through all agent conversation transcripts
- **🤖 Real-time Agent Status** — Monitor your OpenClaw agent's activity, connections, and health
- **📊 Statistics** — Visual insights into task completion, project progress, and agent activity
- **🔌 Plugin System** — Extend your dashboard with Docker-based plugins (journals, monitors, blogs, etc.)
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
git clone ssh://git@git.skyday.eu:222/Homelab/ClawBoard.git
cd ClawBoard

# 2. Run setup script (generates .env with password hash)
./setup.sh

# 3. Start services
docker compose up -d

# 4. Access dashboard
open http://localhost:8080/dashboard/
```

**Prerequisites:**
- Docker & Docker Compose
- OpenClaw installed and running
- 2GB RAM, 1 CPU core

**What the setup script does:**
- Creates `.env` from `.env.example`
- Generates bcrypt password hash for dashboard login
- Sets up database credentials and JWT secret
- Configures OpenClaw integration paths
- Creates data and backup directories

## 📚 Documentation

Documentation lives in [`docs/`](docs/):

- **[Getting Started](docs/getting-started.md)** — 5-minute quick start guide
- **[Plugin Development](docs/plugin-development.md)** — Build your own plugins
- **[Example Plugin](docs/example-plugin/)** — Minimal hello-world plugin to learn from
- **[Project Overview](docs/PROJECT-OVERVIEW.md)** — Architecture deep dive
- **[Deployment Guide](DEPLOYMENT.md)** — Production deployment (Traefik, Nginx, Docker)
- **[Database Guide](database/README.md)** — Schema, backup, restore
- **[Contributing](CONTRIBUTING.md)** — How to contribute

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     ClawBoard Core                          │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Auth &   │  │  Tasks & │  │  Agent   │  │  Plugin   │  │
│  │  Users    │  │ Projects │  │ Sessions │  │  Loader   │  │
│  └──────────┘  └──────────┘  └──────────┘  └─────┬─────┘  │
│                                                   │        │
└───────────────────────────────────────────────────┼────────┘
                                                    │
          ┌─────────────────────────────────────────┤
          │              │              │            │
    ┌─────▼─────┐  ┌────▼──────┐  ┌───▼────┐  ┌───▼────────┐
    │   claw-   │  │   claw-   │  │  claw- │  │  your-own  │
    │  journal  │  │  monitor  │  │  blog  │  │  plugin    │
    │ (Docker)  │  │ (Docker)  │  │(Docker)│  │  (Docker)  │
    └───────────┘  └───────────┘  └────────┘  └────────────┘
```

**Components:**
- **Frontend:** Static React app served by nginx
- **Backend:** REST API + WebSocket gateway + Plugin proxy
- **Database:** PostgreSQL for persistent storage
- **OpenClaw:** Read-only integration for session data
- **Plugins:** Docker containers loaded on startup (optional)

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
OPENCLAW_GATEWAY_URL=ws://localhost:3120

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

See [Getting Started](docs/getting-started.md) for complete reference.

## 🔌 Plugins

ClawBoard V2 supports a plugin system where each plugin runs as its own Docker container. Plugins can add sidebar items, API endpoints, and full UI pages to your dashboard.

### Quick Plugin Setup

```bash
# 1. Create clawboard.plugins.json (or copy the example)
cp clawboard.plugins.example.json clawboard.plugins.json

# 2. Add your plugin entries
# 3. Start with plugins
docker compose up -d
```

### Creating a Plugin

See the full [Plugin Development Guide](docs/plugin-development.md).

Every plugin needs:
1. A `plugin.json` manifest at its root
2. A `/health` endpoint
3. A Dockerfile
4. An entry in `clawboard.plugins.json`

### No Plugins? No Problem

ClawBoard works perfectly without any plugins. The plugin system is completely optional — if `clawboard.plugins.json` is empty or missing, ClawBoard runs in core-only mode.

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

See [Database Guide](database/README.md) for schema and management.

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

## ✅ Functional Tests

After deployment, verify that everything works:

```bash
# 1. Check all containers are healthy
docker compose ps

# Expected: All containers show "healthy" or "Up"

# 2. Test API health endpoint
curl http://localhost:8080/api/health

# Expected: {"status":"ok","timestamp":"..."}

# 3. Test login
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"your-password"}'

# Expected: {"token":"...","user":{...}}

# 4. Access dashboard in browser
open http://localhost:8080/dashboard/

# Expected: Login page loads, successful login redirects to dashboard
```

**Troubleshooting:**
- **API 502 Bad Gateway:** Backend container not healthy. Check: `docker compose logs clawboard-backend`
- **Login fails:** Password hash mismatch. Regenerate: `./setup.sh` (reconfigure)
- **Dashboard blank:** Check browser console for API errors. Verify `/api/` proxy in nginx

## 🐛 Troubleshooting

### Dashboard Won't Load

```bash
# Check containers
docker compose ps

# View logs
docker compose logs -f

# Restart
docker compose restart
```

### OpenClaw Connection Failed

```bash
# Verify OpenClaw is running
openclaw status

# Check gateway URL
grep OPENCLAW_GATEWAY_URL .env

# Restart backend
docker compose restart clawboard-backend
```

### Database Issues

```bash
# Check database logs
docker compose logs clawboard-db

# Restart database
docker compose restart clawboard-db
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for more deployment and troubleshooting guidance.

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, including how to maintain a private fork (upstream/downstream workflow).

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
| **Paulina Stopa** | Creator & Architect | pstopa@skyday.eu |
| **Nim** 🌀 | AI Co-Creator & Lead Engineer | nim@skyday.eu |

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

- **Email:** pstopa@skyday.eu
- **Repository:** [ClawBoard on Gitea](https://git.skyday.eu/Homelab/ClawBoard)
- **Wiki:** [Documentation](https://git.skyday.eu/Homelab/ClawBoard/wiki/)

## 🗺️ Roadmap

**V2.0.0 (Current):**
- ✅ Plugin system (Docker-based, config-driven)
- ✅ Multi-entry journal (multiple entries per day)
- ✅ Mobile UX improvements
- ✅ Backend stability (OOM fixes, debounced watchers)
- ✅ Upstream/downstream fork workflow

**Planned:**
- 🌍 Multi-language support
- 🔔 Notification system
- 👥 Multi-user collaboration
- 📱 Mobile app
- 📊 Advanced analytics
- 🎨 Theme marketplace
- 🔌 Plugin marketplace & registry

---

**Built with ❤️ for the OpenClaw community**

[Get Started](docs/getting-started.md) | [Documentation](docs/) | [Contributing](CONTRIBUTING.md)

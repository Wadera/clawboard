# 🔌 ClawBoard

**Your AI dashboard for every harness.**

ClawBoard is a comprehensive web-based dashboard for managing and monitoring your AI agents — a shared board where your tools and agents interconnect and share **tasks, projects, reports, journal, knowledge, skills, and tools**. It gives you a beautiful, modern interface for task management, project tracking, journal entries, conversation history, and real-time agent monitoring.

It began as a dashboard **for OpenClaw**, grew to make **Hermes** its primary harness, and is heading toward being **harness-agnostic** — a native MCP connection (on the roadmap) that lets *any* tool or agent plug into the same board: OpenClaw, Hermes, Claude Code, Codex, Antigravity, or whatever comes next. Everything the web UI does is already exposed over a documented REST/OpenAPI surface (`GET /api/openapi.json`) and a CLI, so any agent with the right skill can drive it today.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ready-brightgreen)](docker-compose.yml)
[![PostgreSQL](https://img.shields.io/badge/postgresql-16-blue)](https://www.postgresql.org/)

> **Repository:** [github.com/Wadera/clawboard](https://github.com/Wadera/clawboard)

## ✨ Features

- **📋 Task Board** — Kanban-style task management with drag-and-drop, subtasks, priorities, and dependencies
- **🗂️ Project Management** — Organize tasks into projects with links, notebooks, environments, and resources
- **📝 Journal** — Daily journal entries with mood tracking, multi-entry per day, and navigation
- **💬 Sessions** — Browse and search through all agent conversation transcripts
- **🤖 Real-time Agent Status** — Monitor your agents' activity, connections, and health across harnesses (Hermes & OpenClaw)
- **📊 Statistics** — Visual insights into task completion, project progress, and agent activity
- **🔌 Plugin System** — Extend your dashboard with Docker-based plugins (journals, monitors, blogs, etc.)
- **🎨 Fully Customizable** — Theme colors, branding, feature toggles, custom avatars
- **🔐 Secure** — Password-protected with JWT authentication
- **🐳 Docker-Ready** — Complete Docker Compose setup with health checks
- **🔄 Real-time Updates** — WebSocket integration for live dashboard updates

## 🖼️ Screenshots

*Live dashboard captures (v2.1); some entries show representative sample data.*

### Dashboard
![Dashboard](docs/screenshots/dashboard.png)

### Tasks
![Tasks Board](docs/screenshots/tasks-board.png)
![Task Detail](docs/screenshots/task-detail.png)

### Projects
![Projects](docs/screenshots/projects.png)
![Project Detail](docs/screenshots/project-detail.png)

### Reports
![Reports](docs/screenshots/reports.png)

### Sessions
![Sessions](docs/screenshots/sessions.png)

### Journal
![Journal](docs/screenshots/journal.png)
![Journal Post](docs/screenshots/journal-post.png)

### Agent Types
![Agent Types](docs/screenshots/agent-types.png)

### Content Engine
![Content Engine](docs/screenshots/content-engine.png)

### Second Brain
![Second Brain](docs/screenshots/second-brain.png)

### Stats, Tools & Audit
![Stats](docs/screenshots/stats.png)
![Tools](docs/screenshots/tools.png)
![Audit](docs/screenshots/audit.png)

### Plugins: GPU Gateway & NimOrb
![GPU Gateway](docs/screenshots/gpu-gateway.png)
![NimOrb Avatar](docs/screenshots/nim-orb.png)

## 🚀 Quick Start

Get ClawBoard running in **5 minutes**:

```bash
# 1. Clone repository
git clone https://github.com/Wadera/clawboard.git
cd clawboard

# 2. Run setup script (generates .env with password hash)
./setup.sh

# 3. Start services
docker compose up -d

# 4. Access dashboard
open http://localhost:8082/dashboard/
```

**Prerequisites:**
- Docker & Docker Compose
- OpenClaw installed and running
- 2GB RAM, 1 CPU core

> 🧭 **New install?** After Quick Start, read [docs/going-further.md](docs/going-further.md) — what ships as the generic starter pack and how to wire your own tools, personas, LLM proxy, and orchestration to unlock everything shown in the screenshots.

**What the setup script does:**
- Creates `.env` from `.env.example`
- Generates bcrypt password hash for dashboard login
- Sets up database credentials and JWT secret
- Configures OpenClaw integration paths
- Creates data and backup directories

## 🧠 OpenClaw Workspace Integration

ClawBoard automatically reads and displays your bot's workspace files, giving you direct visibility into your agent's personality, memory, and configuration.

### What Gets Loaded

The following files from your OpenClaw workspace are accessible in the dashboard:

- **SOUL.md** — Your bot's personality, identity, and core values
- **HEARTBEAT.md** — Heartbeat monitoring configuration and tasks
- **AGENTS.md** — Agent behavior, memory rules, and conventions
- **USER.md** — Information about the human the bot serves
- **memory/YYYY-MM-DD.md** — Daily memory logs
- **memory/*.md** — Additional memory files

### How It Works

The workspace is mounted **read-only** into the ClawBoard backend container:

```yaml
volumes:
  - ${OPENCLAW_WORKSPACE:-~/.openclaw/workspace}:/workspace:ro
```

Configuration in `.env`:

```bash
# Path to your bot's workspace directory
OPENCLAW_WORKSPACE=~/.openclaw/workspace
```

### Dashboard Features

When workspace files are loaded, you'll see:

- **Workspace Files Widget** — Browse and view workspace files directly in the dashboard
- **Bot Personality Card** — Displays bot name and identity from SOUL.md
- **Memory Timeline** — Navigate through daily memory logs
- **Quick File Access** — Jump to any workspace file with one click

### Verification

To verify the workspace integration is working:

1. Log into the dashboard at `http://localhost:8082/dashboard/`
2. Look for the "Workspace Files" widget on the main dashboard
3. Click on any file (e.g., SOUL.md) to view its contents
4. If files don't appear, check:
   - `.env` has correct `OPENCLAW_WORKSPACE` path
   - The path exists and contains the expected files
   - Docker container has been restarted after .env changes

### Troubleshooting

**Files not showing up?**

```bash
# Check if workspace path is correct
ls -la ~/.openclaw/workspace

# Verify .env configuration
grep OPENCLAW_WORKSPACE .env

# Restart containers to pick up changes
docker compose restart clawboard-backend
```

**Permission issues?**

The workspace is mounted read-only, so ClawBoard cannot modify your files. If you need to edit them, use your preferred editor on the host system.

## 💓 Heartbeat Watchdog

ClawBoard includes **clawbeat** — a proactive monitoring tool that checks task status, agent activity, and orchestration needs.

### What It Does

Clawbeat runs periodically (e.g., every 15 minutes) to:

1. **Check Active Sub-agents** — Avoids interrupting ongoing work
2. **Monitor Stuck Tasks** — Detects tasks awaiting subtask review with retry tracking
3. **Track In-Progress Tasks** — Identifies stalled or crashed processes
4. **Auto-Start Ready Tasks** — Generates spawn-ready prompts for tasks marked `autoStart=true`

### Configuration

Set up environment variables or config file:

```bash
# Environment variables
export CLAWBOARD_API_URL="http://localhost:3001/api"
export CLAWBOARD_TOKEN="your-api-token"

# Or use config file
mkdir -p ~/.config/clawboard
echo '{"api_token": "your-token"}' > ~/.config/clawboard/config.json
```

### Usage

```bash
# Normal run (outputs JSON)
python3 cli/clawbeat.py

# Debug mode
python3 cli/clawbeat.py --verbose

# Dry run (no side effects)
python3 cli/clawbeat.py --dry-run

# Override API URL
python3 cli/clawbeat.py --api http://custom-host:3001/api
```

### Example Output

```json
{"action": "HEARTBEAT_OK", "reason": "All systems nominal"}

{"action": "WAKE", 
 "message": "ORCHESTRATE: Stuck Task [abc123] Needs Review\n...", 
 "reason": "Task abc123 stuck — needs subtask review",
 "task_id": "abc123", 
 "attempt": 1, 
 "recommended_action": "review"}
```

### Integration with HEARTBEAT.md

Run via cron or OpenClaw heartbeat polling:

**Option 1: Cron (runs every 15 minutes)**
```bash
*/15 * * * * cd /path/to/clawboard && python3 cli/clawbeat.py
```

**Option 2: HEARTBEAT.md in OpenClaw workspace**
```markdown
# HEARTBEAT.md

Every heartbeat (15 min interval):
1. Check clawbeat status
2. If WAKE action, follow orchestration instructions
3. Log actions to /tmp/orchestration-actions.log

Command:
cd /path/to/clawboard && python3 cli/clawbeat.py
```

### Features

- **Context-Rich Prompts** — Full task details, subtasks, project context
- **Retry Tracking** — Escalates after 3 failed attempts (`/tmp/clawbeat-retries.json`)
- **Deduplication** — Won't re-wake for same task within 30 minutes (`/tmp/orchestration-actions.log`)
- **Process Monitoring** — Checks external process health via `/tmp/task-*-status.json`
- **Zero Dependencies** — Python 3 stdlib only (requests optional)

### How It Works

1. **Active Sub-agent Check** — Scans `~/.openclaw/agents/main/sessions/` for recently active subagent sessions
2. **API Queries** — Fetches tasks via ClawBoard API (`/api/tasks?status=stuck`, etc.)
3. **Context Gathering** — Uses `clawboard` CLI to get full task details, subtasks, and project info
4. **Decision Tree** — Outputs `HEARTBEAT_OK` if all clear, or `WAKE` with detailed orchestration instructions

### Retry Escalation

Tasks are retried automatically with escalation:
- **Attempt 1-2:** Normal retry with context
- **Attempt 3+:** Escalation warning — approach may be wrong, consider human review

### Recommended Actions

The `recommended_action` field guides the orchestrator:
- `review` — Check subtasks and approve/reject
- `spawn_agent` — Ready to spawn agent for new task
- `restart_process` — External process crashed, needs restart
- `escalate` — 3+ failures, needs human intervention

See the [heartbeat-monitoring tool](database/init.sql) for full details.

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
  Clients:  Web UI  ·  clawboard CLI  ·  any agent/tool via REST + OpenAPI  ·  MCP (roadmap)
                                    │
                                    ▼
  ┌──────────────────────────────────────────────┐
  │               ClawBoard Frontend             │
  │            React + TypeScript + Vite         │
  │                Port: 8082 → 80               │
  └───────────────────────┬──────────────────────┘
                          │
                          ▼
  ┌──────────────────────────────────────────────┐
  │               ClawBoard Backend              │
  │         Node.js + Express + TypeScript       │
  │     REST API · OpenAPI · WebSocket · Plugins │
  │                Port: 3001 (internal)         │
  └───┬──────────────────┬───────────────────┬───┘
      │                  │                   │
      ▼                  ▼                   ▼
  Execution          PostgreSQL 16        Plugins
  harnesses          (internal only)      (Docker, optional)
      │
      ├──► Hermes    (primary — spawns `hermes`, reads state.db)
      └──► OpenClaw  (gateway WebSocket ws://host.docker.internal:18789)
```

**Components:**
- **Frontend:** Static React app served by nginx
- **Backend:** REST API (OpenAPI-documented) + WebSocket + Plugin proxy — driven by the web UI, the `clawboard` CLI, or any external agent/tool
- **Database:** PostgreSQL for persistent storage
- **Execution harnesses:** Agents run through **Hermes** (primary) or **OpenClaw**, selected per task via execution profiles
- **OpenClaw:** Also a read-only source of session transcripts
- **Plugins:** Docker containers loaded on startup (optional)

> **Agent-agnostic by design.** Everything the web UI does goes through the same REST API, published as an OpenAPI spec (`GET /api/openapi.json`) and wrapped by the `clawboard` CLI — so any agent or tool with the right skill and credentials can drive the board today. A native **MCP wrapper** (see Roadmap) will additionally expose ClawBoard's tasks, projects, and reports as first-class tools to any MCP-speaking client.

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
# Set POSTGRES_PASSWORD, JWT_SECRET, DASHBOARD_PASSWORD_HASH, OPENCLAW_DIR

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

## 🖥️ CLI Tool

ClawBoard includes a command-line tool for managing tasks, projects, tools, and journals.

### Setup

```bash
# Make executable and add to PATH
chmod +x cli/clawboard
export PATH="$(pwd)/cli:$PATH"

# Or create a symlink
ln -s "$(pwd)/cli/clawboard" /usr/local/bin/clawboard

# Configure API URL (default: http://localhost:3001)
export CLAWBOARD_API_URL="http://localhost:3001"
```

### Authentication

```bash
# Login (stores token in ~/.config/clawboard/token.json)
clawboard login

# Or use environment variables
export CLAWBOARD_PASSWORD="your-dashboard-password"
```

### Quick Start

```bash
clawboard list                          # List all tasks
clawboard create "My first task"        # Create a task
clawboard projects                      # List projects
clawboard tools list                    # List tools
clawboard tools generate-md --slim      # Generate TOOLS.md
clawboard journal list                  # List journal entries
clawboard status                        # Dashboard overview
```

### TOOLS.md Bootstrapping

After deploying ClawBoard, bootstrap the tool registry so your bot knows how to use the dashboard:

```bash
# 1. Login to the CLI
clawboard login

# 2. Add your tools (or import from a template)
clawboard tools list

# 3. Generate TOOLS.md for your bot's workspace
clawboard tools generate-md --slim -o /path/to/bot/workspace/TOOLS.md
```

The generated `TOOLS.md` gives your OpenClaw bot context about available tools and how to use them.

## ⚙️ Configuration

### Environment Variables (`.env`)

```bash
# Database
POSTGRES_PASSWORD=your-secure-password

# Authentication
JWT_SECRET=your-random-hex-string
# bcrypt hash — generate with: node scripts/hash-password.js yourpassword
DASHBOARD_PASSWORD_HASH=changeme

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
- Login password: bcrypt hash in `.env` (`DASHBOARD_PASSWORD_HASH`, generated by `setup.sh`)
- Database: bound to localhost only (`127.0.0.1:5433`)

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
| `~/.openclaw/workspace/` | `/workspace/` | Bot workspace (SOUL.md, memory/, etc.) |

### Required Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCLAW_DIR` | `~/.openclaw` | Host path to OpenClaw data directory |
| `OPENCLAW_GATEWAY_URL` | `ws://host.docker.internal:18789` | Gateway WebSocket URL |
| `OPENCLAW_WORKSPACE` | `~/.openclaw/workspace` | Bot workspace directory |

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

## ✅ Functional Tests

After deployment, verify that everything works:

```bash
# 1. Check all containers are healthy
docker compose ps

# Expected: All containers show "healthy" or "Up"

# 2. Test API health endpoint
curl http://localhost:8082/api/health

# Expected: {"status":"ok","timestamp":"..."}

# 3. Test login
curl -X POST http://localhost:8082/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"your-password"}'

# Expected: {"token":"...","user":{...}}

# 4. Access dashboard in browser
open http://localhost:8082/dashboard/

# Expected: Login page loads, successful login redirects to dashboard
```

**Troubleshooting:**
- **API 502 Bad Gateway:** Backend container not healthy. Check: `docker compose logs clawboard-backend`
- **Login fails:** Password hash mismatch. Regenerate: `./setup.sh` (reconfigure)
- **Dashboard blank:** Check browser console for API errors. Verify `/api/` proxy in nginx


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
git clone https://github.com/Wadera/clawboard.git
cd clawboard
docker compose -f docker-compose.dev.yml up
```

## 👩‍💻 Authors

| Who | Role | Contact |
|-----|------|---------|
| **Paulina Stopa & swarm of agents** 😉 | Creator & Maintainer | clawboard@skyday.eu |

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

- **Email:** clawboard@skyday.eu
- **Repository:** [ClawBoard on GitHub](https://github.com/Wadera/clawboard)
- **Wiki:** [Documentation](https://github.com/Wadera/clawboard/wiki/)

## 🧭 The vision

ClawBoard started as a dashboard for a single **OpenClaw** bot — a window into one agent's tasks, sessions, and memory. As the work grew into a multi-agent setup, **Hermes** became the primary harness, and ClawBoard learned to drive both — picking a harness per task, side by side on one board.

The direction from here is simple: **stop caring which harness or tool you use.** ClawBoard is growing into a neutral hub where *any* agent or tool — OpenClaw, Hermes, Claude Code, Codex, Antigravity, or whatever ships next — can plug in (natively, over MCP) and share the same tasks, projects, reports, journal, knowledge, skills, and tools. One board, many agents, working together and able to see who is doing what.

Everything the web UI does already runs on a documented REST/OpenAPI surface and a CLI, so that future is being built in the open — one step at a time on the roadmap below.

## 🗺️ Roadmap

**Shipped:**
- ✅ Plugin system (Docker-based, config-driven)
- ✅ Multi-entry journal (multiple entries per day)
- ✅ Pluggable execution harnesses (Hermes + OpenClaw) with per-task execution profiles
- ✅ REST API + OpenAPI spec + `clawboard` CLI (agent-agnostic access)
- ✅ Automated task reviewer & heartbeat orchestration
- ✅ Upstream/downstream fork workflow

**Next up:**
- 👥 **Multi-agent / multi-user ownership** — sessions, tasks, reports, and journal entries attributed to a specific user or agent, so you can see who is working on what and share a single board for group / multi-agent collaboration. *(A natural prerequisite for the MCP wrapper below — identity comes first, so external tools can act as themselves.)*
- 🔌 **MCP server wrapper** over the CLI/API — expose ClawBoard's tasks, projects, and reports as native tools to any MCP-speaking client (Claude Code, ChatGPT, Codex, …). Already buildable on top of the existing OpenAPI surface; the goal is a first-class, supported wrapper.

**Later:**
- 🌍 Multi-language support
- 🔔 Notification system
- 📱 Mobile app
- 📊 Advanced analytics
- 🎨 Theme marketplace
- 🔌 Plugin marketplace & registry

---

**Built with ❤️ — born in the OpenClaw community, open to every harness**

[Get Started](docs/getting-started.md) | [Documentation](docs/) | [Contributing](CONTRIBUTING.md)

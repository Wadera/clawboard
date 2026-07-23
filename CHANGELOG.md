# Changelog

All notable changes to the ClawBoard project.

## [v2.1.1] - 2026-07-23

### 🧹 Public release polish

- **Refreshed README** — new 17-image screenshot gallery covering Dashboard, Tasks, Projects, Reports, Sessions, Journal, Agent Types, Content Engine, Second Brain, Stats/Tools/Audit, and the GPU Gateway & NimOrb plugins
- **Generic `docker-compose.yml`** — `docker compose up -d` now works out of the box on a fresh clone (db + backend + frontend)
- **Documentation accuracy pass** — corrected login variable (`DASHBOARD_PASSWORD_HASH`, not `LOGIN_PASSWORD`), gateway port (`18789`), standardized frontend port (`8082`), CLI API default (`http://localhost:3001`), plugin core URL (`:3001`), dev-stack ports, container mount paths, and made setup/backup scripts executable
- **Docs index** — `docs/README.md` is now a real index of the living documentation
- **Authors & contact** — Paulina Stopa & swarm of agents 😉, clawboard@skyday.eu

## [v2.1.0] - 2026-07-23

### 🔄 Curated public snapshot of the converged main line

Rolls up post-v2.0.0 development: hardened task orchestration and the automated
QA reviewer, Hermes harness integration, Content Engine and Second Brain
integrations, Reports and Journal upgrades, plugin improvements (NimOrb, GPU
Gateway), API platform additions (webhooks, batch PATCH, OpenAPI spec), and
deploy/ops hardening.

## [v2.0.0] - 2026-02-13

### 🎉 Major Release: Plugin System

**ClawBoard V2 introduces a comprehensive plugin architecture for extending the dashboard.**

### 🚀 New Features

- **🧩 Plugin System**
  - Docker-based plugin architecture
  - Language-agnostic (Node.js, Python, Go, Rust, etc.)
  - Plugin discovery from `clawboard.plugins.json`
  - Plugin manifest validation (`plugin.json` schema)
  - Health check monitoring (60s interval)
  - Dynamic sidebar integration
  - API proxy routing (`/api/plugins/{name}/*`)
  - UI proxy routing (`/plugins/{name}/*`)
  - Configuration overrides and defaults
  - Network isolation via Docker

- **📋 Plugin Loader Service**
  - Automatic plugin discovery on startup
  - Manifest validation (required fields, port conflicts)
  - In-memory plugin registry
  - Health check polling
  - Plugin registry API (`GET /api/plugins`)

- **🔌 Plugin Proxy Middleware**
  - HTTP request proxying to plugin containers
  - Authentication header forwarding
  - Error handling for unreachable plugins
  - Support for both API and UI routes

### 🎨 UI/UX Improvements

- **Blocked Task Sorting** — Blocked tasks now appear below unblocked tasks in kanban columns (while maintaining priority order within each group)
- Improved visual clarity of actionable vs blocked tasks

### 📚 Documentation

- **New Wiki Pages:**
  - Plugin Development Guide (complete tutorial)
  - Plugin Manifest Reference (full schema docs)
  - Plugin Architecture (design deep dive)
- **FORK.md** — Comprehensive guide for forking ClawBoard and tracking upstream
- **TEST-PLAN-V2.md** — Testing checklist for V2.0.0 release (historical; no longer in the repo)

### 🔧 Configuration

- Added `plugins` section to `clawboard.config.json`
  - `configFile` — Path to plugin config
  - `enabled` — Toggle plugin system
  - `healthCheckIntervalMs` — Health check frequency
- Added `clawboard.plugins.json` for plugin configuration
- Added `clawboard.plugins.example.json` template

### 📁 Repository Structure

- `backend/src/services/PluginLoader.ts` — Plugin discovery and management
- `backend/src/middleware/pluginProxy.ts` — HTTP proxy for plugins
- `backend/src/routes/plugins.ts` — Plugin registry API
- `clawboard.plugins.json` — Empty plugin array (clean install)
- `clawboard.plugins.example.json` — Configuration template

### 🚀 Migration Guide

ClawBoard V2 is **backward compatible**. To upgrade:

1. Pull latest code: `git pull upstream main` (or `git fetch upstream && git merge v2.0.0`)
2. Version already bumped to 2.0.0 in package.json files
3. Plugin system is opt-in — no plugins = no changes to behavior
4. To add plugins, create `clawboard.plugins.json` and list your plugins
5. See [FORK.md](FORK.md) for deployment patterns

### 🔒 Breaking Changes

**None** — V2.0.0 is fully backward compatible with V1.x deployments.

### 📊 Audit Summary

- Plugin system: **100% implemented**
- UI improvements merged: **1 commit** (blocked task sorting)
- Documentation: **7 new pages** (wiki + guides)
- Test coverage: **Comprehensive test plan** created
- Deployment guides: **FORK.md** for upstream/downstream workflows

---

## [v1.5.0] - 2026-01-31

### 🚀 New Features
- **Stats & Analytics Page** (`/stats`) — Usage over time, tool distribution, command frequency, event types, tasks completed per day with Recharts
- **Audit Dashboard** (`/audit`) — Searchable event timeline from session JSONL files, filterable by event type and tool, with stats cards and pagination
- **Enhanced Task Creation & Editing** — Inline edit modal with subtasks, links, model selection, execution mode, and active agent tracking
- **Task Spawn System** — Play button on tasks to generate sub-agent prompts
- **Agent Detail Cards** — Sidebar cards showing active sub-agents
- **File Viewer** — View arbitrary project files from workspace
- **Auto Task Status Updates** — Task status auto-updates when sub-agent sessions complete
- **Agent Session History** — Persist completed task session history
- **Rate Limit Display Widget** — Shows current API rate limit status
- **Real-time Task Updates** — WebSocket subscriptions for live task changes

### 🎨 UI/UX Improvements
- **Phase 7 Polish** — Error handling, loading spinners, ARIA labels throughout
- **Priority Badge Contrast** — Brighter/whiter text on priority badges
- **Kanban Column Collapse** — Fixed vertical title text and expand arrow positioning
- **Mental State Widget** — Fixed to fetch from `/api/tasks`, includes ideas and stuck statuses
- **Reduced Poll Frequency** — 250ms → 1s for smoother performance
- **Softer Animations** — Widget animations only trigger on data change
- **10-minute Heartbeat Timer** — Extended heartbeat display timer
- **View Full Context Modal** — Expandable context viewer
- **Task Links** — Open in file viewer; workspace files foldable

### 🐛 Bug Fixes
- Fixed PieLabel type compatibility for Recharts
- Removed unused imports/vars for clean production builds
- Fixed collapsed Kanban column title display (removed upside-down rotation)
- Fixed file path prepending for workspace file reads
- Fixed TypeScript build errors (unused vars, type mismatches)

### 📚 Documentation
- Comprehensive DOCUMENTATION.md update for all Phase 4-7 features
- Phase 4 implementation tracking (Steps 1-8)
- Session handover documents
- UX analysis reports and fix plans

### 🔧 Technical
- **TaskAnalyzer + AutoArchive** services for intelligent task management
- **WorkMonitor + TaskDetector** services for background work monitoring
- **Heartbeat Task Picker API** for task prioritization
- **Rich UI Components** for enhanced task cards

## [v1.4.0] - 2026-01-30

### Features
- Phase 4 Steps 1-2: Work orchestration foundation
- Edit Task modal with priority sorting in Kanban columns
- Model selection and execution mode in task modals
- Task spawn system with agent prompt generation
- Real-time task updates via WebSocket subscriptions

## [v1.3.0] - 2026-01-30

### Features
- Phase 3: Model Status, Stop Controls & File Monitoring
- Model status badge with context usage bar
- Workspace file monitoring with viewer modal
- Stop controls (main session, sub-agents, emergency stop all)
- Keyboard shortcut: Ctrl+Shift+X for stop

## [v1.1.0] - 2026-01-29

### Features
- Phase 1.5: Real-Time Status tracking
- WebSocket server with session monitoring
- Lock file detection for AI inference state
- Status states: idle, thinking, tool-use, typing, waiting

## [v1.0.0] - 2026-01-29

### Features
- Phase 1: Foundation
- Docker infrastructure (4 containers)
- PostgreSQL database with 6-table schema
- Express + TypeScript backend
- React + TypeScript + Vite frontend
- Dark theme UI (Klaus-inspired)
- Dual environment strategy (prod + dev)

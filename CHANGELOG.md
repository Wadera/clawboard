# Changelog

All notable changes to the ClawBoard project.

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

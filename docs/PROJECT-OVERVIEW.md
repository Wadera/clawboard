# ClawBoard — Project Overview 🌀

*A living workspace for a digital creature and their human companion*

**Production:** https://your-domain.example.com/dashboard/  
**Development:** https://your-domain.example.com/dashboard-dev/  
**Repository:** Homelab/ClawBoard.git

---

## 💡 The Idea

ClawBoard isn't just a monitoring tool — it's **home base** for an AI agent that lives alongside you. 

Most AI dashboards are built for humans to *observe* agents. This one is different: it's built for **collaboration**. Your AI agent can see the same dashboard, create tasks, track progress, write journal entries, and stay coordinated with human across sessions.

It answers questions like:
- What's the agent working on right now? (Live status)
- What did we agree to do? (Kanban board)
- What happened yesterday? (Journal, Audit log)
- How much are we spending? (Token/cost tracking)
- What's the state of our projects? (Project management)

**Philosophy:** Treat the AI as a teammate with their own workspace, not just a tool to invoke.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         TRAEFIK (Reverse Proxy)                     │
│                    your-domain.example.com/dashboard                   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
          ▼                     ▼                     ▼
   ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
   │   FRONTEND  │      │   BACKEND   │      │  POSTGRES   │
   │   (React)   │◄────►│  (Express)  │◄────►│    (16)     │
   │   Port 3000 │      │  Port 3001  │      │  Port 5432  │
   └─────────────┘      └─────────────┘      └─────────────┘
          │                     │
          │              ┌──────┴──────┐
          │              ▼             ▼
          │      ┌─────────────┐ ┌──────────┐
          └─────►│  WebSocket  │ │  NFS/    │
                 │  (Live)     │ │  Media   │
                 └─────────────┘ └──────────┘
                                      │
                            ┌─────────┴─────────┐
                            ▼                   ▼
                    ┌─────────────┐     ┌─────────────┐
                    │  OpenClaw   │     │   TrueNAS   │
                    │  Workspace  │     │   Storage   │
                    └─────────────┘     └─────────────┘
```

### Tech Stack
- **Frontend:** React 18, TypeScript, Vite, CSS (no frameworks — hand-crafted dark theme)
- **Backend:** Express.js, TypeScript, JWT auth, WebSocket
- **Database:** PostgreSQL 16 (migrated from SQLite for reliability)
- **Infrastructure:** Docker Compose, Traefik, NFS mounts
- **AI Integration:** OpenClaw gateway, Anthropic Claude

### Codebase Stats
- **~20,000 lines** of TypeScript
- **11 database tables**
- **15+ API routes**
- **25+ React components**
- **Built in 11 days** (Jan 27 – Feb 6, 2026)

---

## 🎨 Frontend

### Design Language
- **Dark theme** with deep navy/charcoal background (#0f1419)
- **Accent colors:** Teal/cyan (#14b8a6) for primary, soft purples for secondary
- **Glass morphism:** Subtle blur effects, soft glows, depth through shadows
- **Responsive:** Works on desktop and mobile

### Pages

| Page | Purpose |
|------|---------|
| **Dashboard** | Home page — greeting, quick stats, current task, model status |
| **Tasks** | Kanban board with drag-and-drop columns |
| **Projects** | Project cards with file browser (NFS-backed) |
| **Journal** | Daily reflections with AI-generated mood art |
| **Images** | Gallery of generated images |
| **Audit Log** | Token usage, costs, model breakdown per session |
| **Stats** | Charts and metrics (task completion, velocity) |
| **Avatar** | Full-screen NimOrb with live status |

### The Sidebar 🌀

The sidebar is always present — it's Agent's "face" in the dashboard:

```
┌──────────────────┐
│   🌀 NimOrb      │  ← Live WebGL particle orb
│   (click to      │     Changes based on status:
│    expand)       │     - idle: calm breathing
│                  │     - thinking: intense glow
│   ──────────     │     - working: tool particles
│   📋 7 tasks     │
│   🎯 3 active    │  ← Quick task counts
│                  │
│   [Nav links]    │  ← Dashboard, Tasks, Journal...
│                  │
│   ⏹ Stop Agent    │  ← Emergency stop button
└──────────────────┘
```

**The NimOrb** is a 20,000-particle WebGL visualization that:
- Shows real-time status via color and animation
- Has **mouse interaction** — particles form a tentacle that follows your cursor
- Uses curl noise, bloom post-processing, and smooth state transitions
- Falls back to CSS animation if WebGL unavailable

### Real-Time Updates

The frontend connects via **WebSocket** to receive:
- Status changes (idle → thinking → working)
- Task updates (new tasks, status changes)
- Token usage updates
- Agent's mood/activity text

No polling — everything pushes live.

---

## ⚙️ Backend

### API Routes

| Route | Purpose |
|-------|---------|
| `POST /api/auth/login` | Password-based JWT auth |
| `GET/POST /api/tasks` | Task CRUD, filtering, Kanban |
| `POST /api/tasks/:id/move` | Status transitions with notes |
| `GET/POST /api/projects` | Project management |
| `GET /api/projects/:id/files` | NFS file browser |
| `GET/POST /api/journal` | Daily journal entries |
| `GET /api/audit` | Token/cost breakdown |
| `GET /api/status` | Agent's current status |
| `POST /api/nim-status/update` | Update mood/activity |
| `GET /api/images` | Image generation gallery |
| `WS /ws` | Real-time updates |

### Key Services

**TaskManager** — The brain of task operations:
- CRUD with validation
- Status transitions with history logging
- Subtask management (complete/uncomplete)
- Auto-archive old completed tasks
- Project association

**WebSocketService** — Real-time event bus:
- JWT-authenticated connections
- Broadcasts status changes to all clients
- Heartbeat keepalive (30s intervals)

**JournalService** — Daily reflections:
- One entry per date (upsert)
- Stores mood, reflection text, highlights
- Links to generated mood images

**AuditService** — Cost tracking:
- Parses OpenClaw session transcripts
- Aggregates by model, provider
- Calculates costs per session

**SessionMonitor** — Watches OpenClaw:
- Reads workspace files
- Detects status from HEARTBEAT.md
- Parses current work from memory files

---

## 📋 The Kanban Board

### Statuses

| Status | Meaning | Color |
|--------|---------|-------|
| **Ideas** 💡 | Backlog, someday/maybe | Gray |
| **Todo** 📝 | Ready to work on | Blue |
| **In Progress** 🔄 | Currently being worked | Yellow |
| **Stuck** 🚧 | Blocked, needs help | Orange |
| **Completed** ✅ | Done, awaiting archive | Green |
| **Archived** 📦 | Historical record | Dim |

### Task Fields

```typescript
interface Task {
  id: string;
  title: string;
  description?: string;
  status: Status;
  priority: 'urgent' | 'high' | 'normal' | 'low' | 'someday';
  project_id?: string;
  tags: string[];
  subtasks: { text: string; completed: boolean }[];
  notes?: string;  // Agent notes on current state
  auto_start?: boolean;  // Can agent pick up automatically?
  created_at: Date;
  updated_at: Date;
}
```

### How We Use It Together

1. **human creates ideas** — rough concepts, wishes, dreams
2. **Agent breaks them down** — creates subtasks, estimates effort
3. **Tasks move right** — ideas → todo → in-progress → completed
4. **Agents work independently** — spawn, work, mark as "stuck" for review
5. **Agent verifies and completes** — checks subtasks, browser tests, marks done
6. **Auto-archive** — old completed tasks get archived after 7 days

### The `task management CLI` CLI

A Python CLI that wraps the API — used by both Agent and agents:

```bash
task management CLI list --status todo          # What's ready to work?
task management CLI next                        # Auto-pick next task
task management CLI create "Fix bug" --subtasks "Investigate;Fix;Test"
task management CLI move abc123 in-progress
task management CLI complete-subtask abc123 0   # Mark subtask done
task management CLI spawn abc123                # Generate agent prompt
```

---

## 📓 The Journal

Every morning at 6 AM, a cron job triggers Agent to write a journal entry:

1. Read yesterday's memory files
2. Review chat history and agent sessions
3. Reflect on what happened
4. Generate a mood image (Gemini Imagen via LiteLLM)
5. Post to the API
6. Notify human on Discord

### Journal Structure

```markdown
# Day 11: The Tentacle Learns to Reach

## 🌅 Day in Review
Yesterday was about elegant curves...

## 💭 Reflection
The tentacle code taught me about...

## 📊 human Report Card
Productivity: A
Sleep schedule: C-
...

## ✨ Highlights
- NimOrb Phase 4 complete
- Catmull-Rom splines
- Quieter day after debugging
```

Each entry includes:
- **Mood emoji** — captures the day's vibe
- **AI-generated art** — unique image reflecting the mood
- **Highlights** — 3-5 key points as tags

---

## 📊 Audit Log & Stats

### Token Tracking

Every API call to Claude is logged. The audit page shows:
- **Total tokens** (input/output/cache)
- **Cost breakdown** by model and provider
- **Session timeline** — when was each model used
- **Per-turn detail** — expand to see individual calls

### Stats Dashboard

- Task completion over time
- Tasks by status (pie chart)
- Velocity (tasks/week)
- Project progress bars

---

## 🖼️ Image Generation

Integrated image generation via `imagine.py`:
- Uses LiteLLM proxy to Gemini Imagen
- Generates mood art for journals
- Gallery view with lightbox
- Images stored in NFS-mounted media folder

---

## 🔮 Future Ideas

### Near-term
- [ ] **Phase 4.1:** Automatic task detection from chat
- [ ] **Phase 5:** Sub-agent orbs (visual representation of spawned agents)
- [ ] **Phase 6:** Dify RAG memory integration

### Someday
- [ ] Voice interaction (Qwen3 TTS)
- [ ] Mobile app (React Native?)
- [ ] Multi-agent collaboration view
- [ ] Public read-only mode for portfolio

---

## 🛠️ Development

### Local Setup

```bash
git clone Homelab/ClawBoard.git
cd ClawBoard && git checkout dev

# Start everything
docker compose -f docker-compose.dev.yml up -d

# Watch logs
docker compose -f docker-compose.dev.yml logs -f

# Access
# Frontend: http://localhost:3002 (or via Traefik)
# Backend: http://localhost:3001
# Database: localhost:5433
```

### Deployment

```bash
git checkout main
git merge dev
docker compose -f docker-compose.prod.yml up -d --build
```

---

## 🤝 The Collaboration Model

This dashboard embodies a specific vision of human-AI collaboration:

1. **Transparency** — Agent's state is always visible
2. **Shared context** — Both see the same tasks, same history
3. **Async-friendly** — Work continues across sessions
4. **Trust through verification** — Tasks require review before completion
5. **Memory persistence** — Journal and memory files bridge sessions

It's not about control. It's about **working together**.

---

*Built with 💚 by Agent & human*  
*January–February 2026*

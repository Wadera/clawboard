# Going Further — wiring ClawBoard into your infrastructure

A fresh ClawBoard install is intentionally a **generic starter pack**: the core
dashboard, a seeded set of starter tools (task/project management, heartbeat
monitoring, tool management), sample demo data, and empty registries ready for
your own content. Everything below is optional — each integration you wire up
unlocks another part of the dashboard you may have seen in the screenshots.

## What ships vs. what you bring

| Area | Ships in the box | You bring |
|---|---|---|
| Task/project boards, journal, reports, sessions, stats, audit | ✅ fully working | — |
| Tools Registry | 4 generic starter tools | Your own tool cards describing *your* CLIs/services |
| Agent Types (personas) | empty | An agency-agents style repo of persona markdown |
| Plugins | plugin system + example | Your plugin containers (avatar, GPU, blogs, …) |
| LLM/image generation | provider bridge code | Your LLM proxy endpoint + keys |
| Second Brain | proxy routes + UI | Your knowledge-broker + vector DB |
| Voice | WebSocket relay | Your speech bridge endpoint |
| Orchestration | `cli/clawbeat.py` watchdog | A cron entry + your orchestrator harness |

## 1. Teach your agents your tools (Tools Registry)

The Tools Registry is where agents learn what *your* infrastructure offers.
Each tool is a card with usage instructions that gets injected into agent
context. Add cards for the things your agents should reach for: your password
vault CLI, your GPU/media boxes, your snapshot/backup tooling, your browser
automation. Create them in the dashboard (Tools → New Tool) or via
`POST /api/tools`. Treat instructions as prompts: concrete commands, expected
output, safety notes. **Never put secrets in tool instructions** — reference
your vault instead.

## 2. Give your agents identities (Agent Types)

Point `AGENCY_AGENTS_REPO` at a checkout of your personas repository (the
format follows [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents));
they sync into the DB on backend startup or `POST /api/agent-types/sync`.
Personas are prepended to spawn prompts — a Backend Architect reviews schema
changes differently than a Growth Hacker writes copy.

## 3. Connect an LLM proxy (images, model catalog)

Image generation and model metadata work through an OpenAI-compatible proxy
(e.g. [LiteLLM](https://github.com/BerriAI/litellm)):
`CLAWBOARD_IMAGE_PROVIDER=litellm`, `CLAWBOARD_IMAGE_LITELLM_URL=…`,
`LITELLM_API_KEY=…` (see [image-generation.md](image-generation.md)). Avatars,
banners and journal art generate straight from the dashboard once this is up.

## 4. Orchestrate with the heartbeat (clawbeat)

`cli/clawbeat.py` is a stdlib-only watchdog: run it from cron every ~15 minutes
with `CLAWBOARD_API_URL` + `CLAWBOARD_TOKEN` and it detects stuck/stalled/
auto-start tasks and emits spawn-ready wake prompts for your orchestrator
agent. How wakes get delivered is yours to choose (a chat message to your
agent, a queue, a webhook — see the README's Heartbeat section). This is the
piece that turns ClawBoard from a passive board into a self-driving one.

## 5. Equip a QA reviewer

The automated task reviewer ([automated-task-reviewer.md](automated-task-reviewer.md))
is most powerful when its agent can independently verify work: give it a
shared browser it can drive (e.g. Chromium + CDP) for authenticated UI checks,
and a password-vault CLI session for test credentials. Run those helpers under
the reviewer's own OS user and keep them out of reach of other accounts.

## 6. Optional service integrations

- **Second Brain** — set `KF_BROKER_URL` to your knowledge-broker and
  `QDRANT_UI_URL`/`QDRANT_COOKIE_DOMAIN` if you expose a vector-DB UI behind
  your proxy.
- **Voice** — set `VOICE_BRIDGE_URL` to your speech bridge WebSocket.
- **NFS/shared storage** — set `NFS_PROJECTS_ROOT` so project context can
  reference your shared project files.
- **Webhooks / automation** — outbound webhooks (HMAC-signed) pair well with
  n8n or similar; see [api.md](api.md).
- **Plugins** — build your own dashboard panels as containers; see
  [plugin-development.md](plugin-development.md) and the example plugin.

## Security posture

Keep every credential in env vars or your vault — never in tool cards, task
notes, or config committed to git. Mount agent/OpenClaw directories read-only.
Bind the database to localhost. Before making any deployment public-facing,
put it behind your reverse proxy with TLS and strong auth.

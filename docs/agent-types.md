# Agent Types — ClawBoard Documentation

Agent Types are first-class entities in ClawBoard that define AI persona templates for agent tasks. They're sourced from an agency-agents repository (forked from [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)) and synced into the database on startup.

## Overview

When you assign an Agent Type to a task, the full persona definition (personality, mission, rules, tech stack) is automatically prepended to the agent's spawn prompt. This gives the agent a consistent identity and working style for the type of work the task requires.

## Available Categories

| Category | Description |
|----------|-------------|
| engineering | Software development, backend, frontend, devops, AI, security |
| design | UI/UX, brand, visual storytelling |
| product | Sprint planning, research, behavioral analysis |
| project-management | Studio operations, experiment tracking, senior PM |
| testing | API testing, accessibility, performance, reality checks |
| support | Infrastructure, finance, legal compliance |
| marketing | Social media, content, growth hacking |
| spatial-computing | visionOS, XR, macOS Metal |
| specialized | Orchestrators, LSP engineers, data analysts |

## Custom Personas

Two custom personas were added for homelab-specific workflows:

### Homelab Admin (`engineering/homelab-admin`)
Expert in Proxmox, Docker/LXC, networking, and home server automation. Use for infrastructure tasks involving the homelab setup.

### OpenClaw Plugin Developer (`engineering/openclaw-plugin-dev`)
Specialist in building OpenClaw skills, channel plugins, and agent personalities. Use for tasks extending OpenClaw's capabilities.

## Usage

### Via Dashboard
1. Go to **Tasks** → Create/Edit a task
2. Under "Agent Persona (optional)" dropdown, select a persona
3. The persona will be injected when the task is spawned

### Via CLI
```bash
# Create task with agent type
clawtasks create "Refactor auth module" \
  --project clawboard \
  --agent-type engineering-backend-architect

# Spawn with agent type override
clawtasks spawn <task-id> --run \
  --agent-type engineering-devops-automator

# List available agent types
curl -s http://localhost:3001/agent-types | python3 -m json.tool
```

### Agent Type Slugs (commonly used)
| Slug | Name |
|------|------|
| `engineering-backend-architect` | Backend Architect |
| `engineering-frontend-developer` | Frontend Developer |
| `engineering-devops-automator` | DevOps Automator |
| `engineering-senior-developer` | Senior Developer |
| `engineering-ai-engineer` | AI Engineer |
| `engineering-security-engineer` | Security Engineer |
| `engineering-homelab-admin` | Homelab Admin (custom) |
| `engineering-openclaw-plugin-dev` | OpenClaw Plugin Developer (custom) |
| `testing-api-tester` | API Tester |
| `project-management-senior-project-manager` | Senior Project Manager |

## Cross-Linking

- **Tasks page**: Agent type badge shown on task cards → click to jump to agent detail page
- **Sessions page**: Agent type badge shown on session cards if the session used a persona
- **Agent detail page**: Shows all tasks and sessions that used this persona, with links

## Syncing

Agent types are synced from `/tmp/agency-agents-local` on every backend startup.

To manually re-sync:
```bash
# Via API
curl -X POST http://localhost:3001/agent-types/sync

# Or pull the latest agency-agents and restart backend
cd /tmp/agency-agents-local
git pull origin main
# restart backend
```

## Adding Custom Personas

1. Clone your agency-agents repository (the source configured via `AGENCY_AGENTS_REPO`)
2. Add a markdown file in the appropriate category directory
3. Use the frontmatter format:
```markdown
---
name: My Custom Agent
description: What this agent specializes in
color: purple
---

# My Custom Agent Personality

...
```
4. Commit and push to `nim/agency-agents`
5. Pull on the server and trigger a sync

## Technical Details

- **Database table**: `agent_types` (migration 034)
- **FK on tasks**: `tasks.agent_type_id → agent_types.id`
- **FK on sessions**: `sessions.agent_type_id → agent_types.id`
- **Backend service**: `src/services/AgentTypeService.ts`
- **Routes**: `GET /api/agent-types`, `GET /api/agent-types/:id`, `POST /api/agent-types/sync`
- **Frontend pages**: `/agent-types`, `/agent-types/:id`
- **Prompt injection**: In `src/utils/promptTemplate.ts`, the full persona markdown is prepended to the spawn prompt

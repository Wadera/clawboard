# Session taxonomy for mixed harnesses

ClawBoard now separates three concerns that were previously blended into `kind`:

- `harness`: which agent framework owns the session (`openclaw`, `hermes`, `unknown`)
- `sessionType`: normalized runtime/conversation type (`main`, `heartbeat`, `cron`, `subagent`, `acp`, `cli`, `dm`, `group`, `channel`, `thread`, `unknown`)
- `channel`: delivery surface (`discord`, `telegram`, `cron`, `heartbeat`, etc.)

## Display naming rules

- OpenClaw main session → `Main OpenClaw`
- Hermes local main/CLI session → `Main Hermes`
- Existing stored `Main Session` labels are normalized at read/write time
- Non-main sessions keep explicit labels when present
- Otherwise labels fall back to `Kind: DD Mon` style, then badges carry the taxonomy

## Harness classification rules

### OpenClaw
- `agent:main:main`
- `agent:main:heartbeat...`
- `agent:main:cron:...`
- `cron:...`
- `agent:main:subagent:...`
- `agent:main:acp:...`
- `agent:main:discord:channel:...` by default

### Hermes
- `agent:main:local:dm`
- `agent:main:<platform>:dm:...`
- `agent:main:<platform>:group:...`
- `agent:main:<platform>:thread:...`
- `agent:main:<platform>:channel:...` when explicitly tagged as Hermes in metadata

## Badge examples

- `Main OpenClaw` + badges: `OpenClaw`
- `Main Hermes` + badges: `Hermes`, `cli`
- OpenClaw cron run + badges: `OpenClaw`, `cron`
- OpenClaw spawned child + badges: `OpenClaw`, `sub agent`
- OpenClaw Discord session + badges: `OpenClaw`, `channel`, `Discord`
- Hermes Discord thread + badges: `Hermes`, `thread`, `Discord`
- Hermes Telegram group + badges: `Hermes`, `group`, `Telegram`

## Notes

- `kind` remains for backwards compatibility and DB compatibility.
- `harness` and `sessionType` are derived in the API layer so older rows do not need a migration.
- When ingestion metadata includes stronger hints, those hints win over ambiguous key shapes.

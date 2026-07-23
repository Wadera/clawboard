# ClawBoard Documentation

Index of the documentation in this directory. Start with the main [README](../README.md), [DEPLOYMENT](../DEPLOYMENT.md), and [CONTRIBUTING](../CONTRIBUTING.md) at the repo root.

## Getting Started
- [getting-started.md](getting-started.md) — 5-minute setup guide
- [mount-points.md](mount-points.md) — volume mounts the stack needs

## API
- [api.md](api.md) — API usage notes; the machine-readable spec is served at `GET /openapi.json`

## Features
- [agent-types.md](agent-types.md) — AI persona templates for agent tasks
- [execution-profiles.md](execution-profiles.md) — task execution modes and access profiles
- [task-orchestration.md](task-orchestration.md) — task lifecycle, review flow, reviewer heartbeat
- [automated-task-reviewer.md](automated-task-reviewer.md) — the automated QA reviewer
- [task-execution-options.md](task-execution-options.md) — spawn/execution option reference
- [image-generation.md](image-generation.md) — image generation provider bridge
- [session-taxonomy.md](session-taxonomy.md) — session harness/type/role model
- [tools-auto-generation.md](tools-auto-generation.md) — TOOLS.md generation from the tools registry
- [dependency-picker.md](dependency-picker.md) — task dependency picker behavior
- [clawboard-doctor-usage.md](clawboard-doctor-usage.md) — `clawboard doctor` CLI

## Plugins
- [plugin-development.md](plugin-development.md) — how to build a plugin
- [example-plugin/](example-plugin/) — minimal hello-world plugin

## Engineering References
- [PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md) — architecture narrative
- [partitioning-strategy.md](partitioning-strategy.md) — session message storage strategy
- [acp-integration-design.md](acp-integration-design.md) — ACP session integration design
- [CONTEXT-OPTIMIZATION.md](CONTEXT-OPTIMIZATION.md) — agent context optimization guidance

Files keyed to internal task IDs or dates are point-in-time working notes, not living documentation.

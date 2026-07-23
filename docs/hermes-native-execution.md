# Hermes-native execution and observability plan

This document turns the current OpenClaw-only task runtime into a mixed-harness design that can support both OpenClaw and Hermes without pretending the two systems expose the same APIs.

## 1. Current OpenClaw-only assumptions to remove

### Spawn path

Current `POST /tasks/:id/spawn-agent` logic in `backend/src/routes/tasks.ts` assumes:

- task execution happens through `GatewayConnector`
- fire-and-forget work is always `cron.add` + `cron.run`
- interactive work is always `spawnInteractiveSession()` backed by OpenClaw cron jobs
- task session keys follow OpenClaw cron/session formats like `cron:<id>` or `agent:main:*`
- delivery and announce settings are OpenClaw gateway concepts

### Control path

Current task control assumes:

- steer is `chat.send`
- cancel is `chat.abort`
- live state comes from OpenClaw gateway live state cache
- `acpSessionKey` is the canonical steerable session identifier

### Session ingest / observability path

Current session ingest assumes:

- a single source of truth at OpenClaw `sessions.json`
- transcript JSONL files live under `/clawdbot/sessions`
- kinds are derived from OpenClaw session-key conventions
- model status comes from OpenClaw `sessions.json`, `auth-profiles.json`, and `version.json`

### Prompt / workflow assumptions

Current prompts assume:

- agents always have access to the Nim/OpenClaw repo-local CLI path
- `CLAWBOARD_AGENT=1` is always the right guardrail mechanism
- the subtask-review workflow is tied to the local `python3 .../cli/clawboard` path

### Sidebar / workspace assumptions

Current dashboard status widgets assume:

- one runtime system exists
- one workspace root exists
- one model/auth/profile source exists

## 2. Target executor abstraction

Add a runtime boundary between task orchestration and the concrete harness.

```ts
interface TaskExecutor {
  harness: 'openclaw' | 'hermes';

  spawn(input: ExecutorSpawnRequest): Promise<ExecutorSpawnResult>;
  steer(input: ExecutorSteerRequest): Promise<ExecutorSteerResult>;
  cancel(input: ExecutorCancelRequest): Promise<ExecutorCancelResult>;
  getSessionStatus(input: ExecutorSessionStatusRequest): Promise<ExecutorSessionStatusResult>;
}
```

### Shared request model

```ts
interface ExecutorSpawnRequest {
  taskId: string;
  title: string;
  prompt: string;
  model: string;
  thinking: string;
  interactive: boolean;
  executionProfile?: TaskExecutionProfile | null;
  attachments?: AttachmentManifest | null;
}
```

### OpenClaw executor

`OpenClawExecutor` keeps current behavior:

- standard spawn → `cron.add` + `cron.run`
- interactive spawn → persistent cron session
- steer → `chat.send`
- cancel → `chat.abort`
- session status → gateway live-state cache + cron/job lookup

### Hermes executor

`HermesExecutor` should use Hermes-native primitives instead of OpenClaw RPC emulation:

- spawn via Hermes CLI or Hermes ACP/session tools
- steer via Hermes session messaging / ACP continuation
- cancel via Hermes session stop or task cancellation primitive
- session status via Hermes session registry / dashboard / status output

The executor result must normalize everything into ClawBoard fields:

```ts
interface ExecutorSpawnResult {
  harness: 'openclaw' | 'hermes';
  sessionKey: string;
  controlSessionKey?: string | null;
  runId?: string | null;
  interactive: boolean;
  raw?: Record<string, unknown>;
}
```

## 3. Hermes control mapping

Based on verified Hermes CLI surfaces, ClawBoard should map task lifecycle like this.

### Spawn

Preferred order:

1. Hermes ACP/session-native spawn when a persistent steerable run is required
2. Hermes run/session command for one-shot work
3. Hermes `claw` subcommands only for task/project operations, not for runtime steering

### Steer

Map ClawBoard `steer` to the Hermes session/channel continuation primitive tied to the stored Hermes session key.

### Cancel

Map ClawBoard `cancel` to Hermes session termination or stop primitive. Do not overload OpenClaw `chat.abort` semantics.

### Session status

Map ClawBoard `session-status` to Hermes-native session inspection:

- active / idle / running / waiting
- model or provider in use
- task-linked session key
- harness badge = `Hermes`

## 4. Hermes observability source

ClawBoard should treat Hermes as a second observability source, not a transformed OpenClaw clone.

### Required data for dashboard sessions

For each Hermes session row, ingest:

- `sessionKey`
- `sessionId` if Hermes exposes one
- `harness = hermes`
- normalized `sessionType`
- label / display name
- model / provider
- started / updated / ended timestamps
- live state if available
- transcript or message source pointer if available
- task linkage metadata

### Ingestion model

Use dual-source ingestion:

- OpenClaw ingester reads OpenClaw `sessions.json` and transcript JSONL
- Hermes ingester reads Hermes-native session/status/transcript source
- both write into the same ClawBoard sessions table shape
- API derives taxonomy and badges uniformly

### Audit views

Store enough metadata in `spawn_info` or equivalent structured columns to answer:

- which harness spawned this run
- which runtime created the session
- which control key is steerable
- which transcript source backs the session detail page

## 5. Prompt and metadata cleanup

Hermes-targeted tasks must not assume Nim-only filesystem layout.

### Prompt changes

Prompts should:

- prefer `clawboard` on `$PATH`
- fall back to the repo-local Python entrypoint only when needed
- keep `CLAWBOARD_AGENT=1` as a ClawBoard workflow guard, not as an OpenClaw identity marker
- avoid telling Hermes agents they are inside Nim/OpenClaw-specific paths unless that is actually true

### Metadata changes

Task execution metadata should carry enough intent to choose an executor without parsing prose:

- `executionProfile.mode`
- `executionProfile.accessProfile`
- `requiredCapabilities`
- harness hint from structured metadata or task tags

## 6. Hermes CLI config and auth bootstrap

Hermes should be considered ready for ClawBoard use only when these are documented and testable:

- Hermes binary path
- Hermes project path
- Hermes runtime home/config path
- auth bootstrap flow for the chosen provider profile
- a non-destructive status check command

Recommended minimum bootstrap contract:

```bash
hermes version
hermes status
hermes sessions list
hermes acp --help
hermes claw --help
```

ClawBoard must degrade gracefully when Hermes config is unreadable or not mounted, showing `unavailable` instead of crashing the dashboard.

## 7. Phased rollout

### Phase A, docs and taxonomy

- document assumptions
- finalize mixed-harness taxonomy
- make Sessions page badges harness-aware

### Phase B, metadata and UI scaffolding

- make prompts runtime-agnostic
- split sidebar/workspace/model views into OpenClaw and Hermes sections
- expose Hermes status as optional data in the API

### Phase C, executor boundary

- introduce `TaskExecutor` abstraction
- route OpenClaw tasks through `OpenClawExecutor`
- add feature-flagged `HermesExecutor`

### Phase D, Hermes ingestion

- ingest Hermes sessions into shared Sessions page
- expose live status and audit metadata
- verify steering/cancel/session-status end to end

### Phase E, promotion

- validate on `dashboard-dev`
- only then merge and rebuild production workflows

## 8. Mixed-harness session taxonomy

See `docs/session-taxonomy.md`.

Key rule: `kind` is no longer enough. Every session should expose:

- `harness`
- `sessionType`
- `channel`

## 9. Dual-source Sessions page

The Sessions page should display mixed data with:

- harness badge: `OpenClaw` or `Hermes`
- normalized runtime badge: `main`, `cron`, `sub agent`, `cli`, `thread`, etc.
- provider/channel badge when known
- control affordances only when the selected harness supports them

## 10. Sidebar and workspace split

The sidebar should show two runtime blocks:

- OpenClaw status block
- Hermes status block

Workspace files should be grouped by system:

- OpenClaw Files
- Hermes Files

If Hermes roots are not mounted or readable, show an explicit unavailable state instead of hiding the section.

## 11. Model status split

Model status should become a dual-system surface:

- OpenClaw, active model, auth profile, context usage, subagents
- Hermes, version, provider/model hint, gateway/runtime state, auth/config readability

OpenClaw remains the source for context-window math. Hermes gets its own lightweight status summary.

## 12. Worktree workflow

Use isolated worktrees from dev for larger feature streams.

Recommended pattern:

```bash
git fetch origin
git worktree add ../clawboard-hermes-executor origin/main -b feat/hermes-executor
git worktree add ../clawboard-hermes-ui origin/main -b feat/hermes-ui
git worktree add ../clawboard-hermes-ingest origin/main -b feat/hermes-ingest
```

Workflow:

1. implement in dedicated worktree
2. run targeted backend/frontend tests in that worktree
3. merge into dev branch only after local verification
4. rebuild dev containers
5. validate on `dashboard-dev`
6. promote to main only after dev sign-off

## 13. Validation checklist for `dashboard-dev`

For each merged feature stream:

1. rebuild backend and frontend containers on dev
2. open `https://nimspace.skyday.eu/dashboard-dev/`
3. verify Sessions badges and labels
4. verify sidebar shows OpenClaw and Hermes blocks
5. verify Workspace Files splits by system
6. verify Model Status shows both systems without breaking OpenClaw telemetry
7. verify unsupported Hermes paths fail soft, not hard
8. only then promote the change further

## Immediate implementation notes

What this repo now does in the DEV branch:

- routes task spawn, steer, cancel, and session-status through a harness-aware executor boundary
- keeps OpenClaw behavior as the default executor
- launches Hermes turns through the Hermes CLI with task-linked source tags
- stores Hermes task linkage in `activeAgent` metadata (`sessionKey`, `pid`, `sourceTag`, `logPath`)
- reads Hermes sessions from the Hermes SQLite state DB for Sessions page visibility and task lifecycle updates
- keeps Discord thread creation and existing OpenClaw delivery behavior unchanged

Current caveats for the Hermes bridge:

- steering is serialized turn-by-turn via `hermes chat --resume`, not a long-lived duplex control socket
- cancel currently kills the linked Hermes worker PID instead of using a Hermes-native stop RPC
- production compose still needs an explicit promotion check because Hermes runtime seeding depends on `/data/hermes-home`

## Writable runtime rule for project-backed Hermes tasks

Project-backed Hermes runs must use a writable task workspace/worktree as both:

- the Hermes `cwd`
- the `.openclaw/attachments/<uuid>` materialization root

Never launch Hermes directly in `/project-sources/...` unless the path is explicitly writable. In PRD that mount is read-only, so using it as `cwd` or attachment root breaks task spawn.

Resolution order for project-backed tasks:

1. project SSD/worktree path (`resources.localPaths.ssdBuild`) translated into the runtime, preferring `/task-projects/<project>/repo`
2. any other translated project path only if it is writable
3. writable fallback roots such as `AGENT_WORKSPACE_DIR`, `HERMES_TASK_CWD`, or `/task-projects`

Operational rule:

- if the translated project path exists but is read-only, do not use it for Hermes spawn
- write attachments into the same writable workspace that Hermes will use as `cwd`
- prefer repo-local `cli/clawboard` from that writable worktree so agent instructions and runtime agree

This keeps project context attachments, repo writes, branch operations, and task-local artifacts inside the dedicated writable worktree instead of the read-only source mirror.

## 2026-04-18 DEV proof snapshot

Validated end to end on `dashboard-dev` with a real Hermes interactive task session:

- spawned DEV proof task `d04e6b84-47d5-4516-8df0-2bcd0a623458`
- `clawboard session-status d04e6b84` returned `Harness: hermes`, `Mode: interactive`, and the live Hermes control key
- `/sessions` showed the Hermes row linked back to the task even though the visible session row was keyed as `agent:main:local:dm:20260418_004153_ff592d`
- `/sessions/:key/steer` resumed the Hermes session successfully and updated task metadata (`activeAgent.pid=50`, `sourceTag=tool-task-d04e6b84`, `logPath=/data/hermes-task-runs/d04e6b84-2026-04-18T00-46-02-334Z.log`)
- the steered Hermes agent completed the required ClawBoard workflow and moved the proof task to `review`

The last missing wiring for that proof was not session discovery, but agent runtime bootstrap. Hermes task runs now need all three injected at launch:

- `CLAWBOARD_CLI` resolving to an actual repo-local CLI path inside the Hermes runtime
- `CLAWBOARD_API_URL` pointing at the dashboard backend (`http://127.0.0.1:$PORT` in the dev container)
- `CLAWBOARD_TOKEN` so the CLI can authenticate without interactive login

## Promotion path: branch -> dev -> dashboard-dev -> review -> main -> PRD

1. work on an isolated feature branch
2. run local backend build plus CLI sanity checks
3. merge into `dev`
4. rebuild `dashboard-dev` backend so Hermes runtime mounts/env match the new bridge
5. validate on `https://nimspace.skyday.eu/dashboard-dev/`
   - spawn OpenClaw task, confirm no regression
   - spawn Hermes task, confirm Sessions page shows a Hermes-backed row
   - run `clawboard session-status <task>` and confirm harness/state/model metadata
   - run `clawboard steer <task> ...` and confirm a new Hermes continuation turn is recorded
   - run `clawboard cancel <task>` and confirm task falls back to `stuck`
6. move the task to `review`
7. after review sign-off, merge to `main`
8. before PRD deploy, verify production backend seeds `/data/hermes-home/.hermes` from `/seed/hermes-config`
9. deploy PRD and repeat the OpenClaw + Hermes smoke checks

## 2026-04-19 DEV proof snapshot: ClawBeat dual-harness dependency chains

Validated on the DEV backend with real proof tasks created in ClawBoard and advanced through dependency unblocking.

### OpenClaw chain

Parent: `b17b8bf2-f65b-45b7-a385-4733d76fed81`
Child: `150e7153-f8e5-4ee1-a2a7-82833cd86590`

Observed sequence:

- parent was moved to `completed`, which removed the child's dependency block
- running `clawbeat` against the real DEV task data emitted a `spawn_agent` wake for the child with `Harness: openclaw`
- the wake instructed the orchestrator to run `clawboard spawn 150e7153 --run --harness openclaw --interactive`
- executing that spawn produced OpenClaw session `agent:main:cron:3e73811e-7b10-4fa9-82cc-f36574d5532d`
- `clawboard session-status 150e7153` then reported `Harness: openclaw`, `Mode: interactive`, `State: idle`, and the matching control/session key
- a targeted heartbeat run on the spawned task did not misclassify it as stale; it skipped stale handling because the task was still within the spawn grace period (`spawned 1m ago (grace: 5m)`)

### Hermes chain

Parent: `23776718-7e61-438a-8735-63f5e2cfe6b0`
Child: `edb1cfa5-79f2-4aa5-aad9-4191d3d9d261`

Observed sequence:

- parent was moved to `completed`, which removed the child's dependency block
- running `clawbeat` against the real DEV task data emitted a `spawn_agent` wake for the child with `Harness: hermes`
- the wake instructed the orchestrator to run `clawboard spawn edb1cfa5 --run --harness hermes --interactive`
- executing that spawn produced Hermes session `hermes:tool:20260419_163413_39768d`
- `clawboard session-status edb1cfa5` then reported `Harness: hermes`, `Mode: interactive`, `State: running`, and the matching control/session key
- a targeted heartbeat run on the spawned task returned `HEARTBEAT_OK` with reason `Active sub-agent: edb1cfa5 (Hermes session running)`

Both proof sessions were then cancelled via `clawboard cancel` so the DEV board was left with validation evidence but no live background proof runs.

## Current validation status in this repo mount

- Frontend production build passes locally when Vite writes to a writable temp outDir (`npm run build -- --outDir /tmp/dashboard-dev-dist`).
- Backend TypeScript build passes in the dev container (`docker compose -f docker-compose.dev.yml exec -T backend npm run build`).
- Focused backend session taxonomy coverage passes in the dev container (`docker compose -f docker-compose.dev.yml exec -T backend npm test -- --runInBand sessionTaxonomy.test.ts`).
- `dashboard-dev` was rebuilt from merged `origin/dev` and manually checked at `https://nimspace.skyday.eu/dashboard-dev/`, including the Sessions page execution-system blocks and Hermes session rows.
- ClawBeat dependency-unblock validation now includes one real OpenClaw proof chain and one real Hermes proof chain, with captured wake/action/runtime evidence recorded above.
- Before PRD promotion, repeat the checklist above against the production compose/runtime, especially the Hermes home seeding and backend runtime dependencies.

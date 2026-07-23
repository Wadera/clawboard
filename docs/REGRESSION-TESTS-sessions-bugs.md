# Regression Test: Sessions Page Bug Fixes

## Bug 1: "Session is starting…" stale state on ended sessions

### Root Cause
When a cron/sub-agent session ends, the frontend's `liveState` may still reflect
`isGenerating: true` from the WebSocket snapshot before the session completion event
propagates. If the transcript is also unavailable (returns empty array), the panel
showed "Session is starting…" indefinitely.

### Fix Applied
`SessionsPage.tsx` — empty-state message logic now checks `session.messageCount`:
```tsx
{isActive
  ? (session.messageCount > 0 ? 'Loading transcript…' : 'Session is starting…')
  : (session.messageCount > 0 ? 'Transcript unavailable' : 'No messages recorded')}
```

### Manual Test Steps

**Scenario A — Active session with no messages yet (should say "Session is starting…")**
1. Open Sessions page
2. Trigger a cron job that starts a new isolated session (e.g. via ClawBoard)
3. Click on the session card within ~1 second of it starting
4. Expected: "Session is starting…" (messageCount = 0, isActive = true) ✓

**Scenario B — Completed session whose transcript is unavailable**
1. Find a completed session in the sidebar (grey dot)
2. Check the DB: if `message_count > 0` but `transcript_path = null`
3. Click on it
4. Expected: "Transcript unavailable" (NOT "Session is starting…") ✓

**Scenario C — Race condition: session just ended, liveState stale**
1. Watch a cron session that is actively running
2. At the moment it ends (within 5s), click on it before WebSocket event fires
3. Expected: "Loading transcript…" (messageCount > 0, isActive still stale-true)
4. After ~5s poll: messages load or "Transcript unavailable" shows ✓

---

## Bug 2: Plugin loader not ready on first /plugins request

### Root Cause
`pluginLoader.initialize()` was called inside `server.listen()` callback, after many
`await`-ed service startups. Early requests to `/api/plugins` returned `[]`.

### Fix Applied
`server.ts` — `pluginLoader.initialize()` now fires BEFORE `server.listen()` as a
non-blocking Promise. The in-callback call is removed (no double-init).

### Manual Test Steps

1. Restart the backend container: `docker compose restart backend`
2. Immediately open the Sessions/Dashboard page (within 1-2s of backend starting)
3. Open browser DevTools → Network → filter for `plugins`
4. Expected: `/api/plugins` returns the configured plugins (e.g. `nim-orb`), NOT `[]`
5. The Orb avatar should appear in the sidebar on first load (not after 3s retry) ✓

**Frontend safety net**: if the first response returns `[]`, the `PluginContext` retries
after 3 seconds automatically. Check the console for:
```
🔌 Plugins loaded: 0 []   ← first attempt (backend still init-ing)
🔌 Plugins loaded: 1 ["nim-orb"]   ← retry after 3s
```

---

## Bug 3: Duplicate session label disambiguation

### Root Cause
Two cron sessions spawned with the same label (e.g. both triggered by the same task)
showed identical entries in the sidebar.

### Fix Applied
`SessionsPage.tsx` — at render time, labels are counted; any label appearing >1 time
gets a suffix appended: `Label (abc12345)` where the suffix is the last 8 chars of the
session UUID.

### Manual Test Steps

1. Trigger two cron sessions with the same label (e.g. `clawbeat` spawning an agent and
   another tool also triggering under the same task label)
2. Open Sessions page
3. Expected: both appear as:
   - `Cron: spawn-task-0dd5de41 (aecf437c)`
   - `Cron: spawn-task-0dd5de41 (44a1e05f)`
4. Hovering the label shows the full label without suffix ✓

---

## Bug 4: Visual indicator for transcript-unavailable sessions

### Root Cause
No visual cue existed on session cards or in the detail panel to indicate that a
completed session's transcript is unavailable.

### Fix Applied
- **Session card**: `FileX` icon (🗂️✗) appears in the top-right corner when
  `!isActive && messageCount > 0 && !transcriptPath`
- **Detail panel**: empty messages area shows "Transcript unavailable" instead of
  "No messages recorded"
- **CSS**: `.session-card-no-transcript` — subtle grey icon, non-intrusive

### Manual Test Steps

1. Find or create a session where `transcript_path IS NULL` in the DB but `message_count > 0`
2. Check the session card in the sidebar
3. Expected: small `FileX` icon visible in the card's right side ✓
4. Click the card → detail panel shows "Transcript unavailable" in the messages area ✓

---

## Bug 5: Hermes spawned sessions stay "running" with zero messages

### Root Cause
Two compounding problems:

1. **Spawn-detection**: `launchHermesTurn` spawned a detached `hermes chat` child and then
   tried to discover the session id synchronously — a 5s `state.db` poll plus a 90s grep of
   the run log. Hermes defers the session-row INSERT to the first conversation turn (after
   venv import + MCP discovery, routinely > 5s cold) and only prints `session_id:` to stderr
   at end of turn, so both probes usually missed. The spawn endpoint then threw HTTP 500,
   `updateTask` never ran, `activeAgent`/`acpSessionKey` were never set, and the detached
   child kept running as an orphan. Retries stacked more orphans.
2. **State-classification**: Hermes can register a session row before it records any
   messages or tool calls. If that process dies, never starts meaningful work, or leaves an
   empty run log, the persisted row may remain `ended_at = NULL`, `message_count = 0`, and
   `tool_call_count = 0`. Runtime code previously treated a fresh `started_at`/`updatedAt`
   timestamp as activity, so ClawBoard could report `State: running` even though there was
   no live process and no Hermes message activity.

### Fix Applied
- **Non-throwing provisional spawn**: `launchHermesTurn` keeps the single quick poll but no
  longer throws when the session row is not yet visible. It returns a provisional result
  (`provisional: true`, `sessionId: null`) and `HermesTaskExecutor.spawn` maps that to the
  existing provisional convention `sessionKey: 'pending'`. The spawn route therefore always
  records `activeAgent` with `pid`, `sourceTag`, `logPath`, and `spawnedAtUnix` immediately —
  HTTP 500 is reserved for true pre-fork failures, and no orphan is left untracked.
- **Bind-by-sourceTag reconciliation**: `SubAgentTaskUpdater` (the existing 5s Hermes
  lifecycle poller) gains a bind step at the top of its Hermes branch. For tasks with
  `sessionKey === 'pending'` it resolves the real session via
  `resolveLaunchedHermesSession`: (1) `sessions.source = sourceTag` lookup — when several
  rows carry the tag (nested hermes runs inherit `HERMES_SESSION_SOURCE` and register
  after the root turn), the OLDEST row at/after the spawn timestamp wins; (2) one-shot
  `session_id:` read from the recorded run log. There is deliberately NO unfiltered
  "single recent row" fallback — it could bind the task to an unrelated session
  (back-to-back task spawns, user CLI/Discord chats); an unresolvable provisional task
  simply waits while its PID lives and is reaped when it dies. ClawBoard also no longer
  sets `HERMES_SESSION_SOURCE` in the child env (hermes exports it internally from
  `--source`; our copy only amplified nested-run tagging). On a hit the bind rewrites
  `activeAgent.sessionKey`, merges `sessionRefs`, sets `acpSessionKey` for interactive
  tasks, rebinds any tracked Discord thread, and records a `session.linked` timeline
  event so the provisional `session.spawned` event has a resolvable follow-up.
- **Reaper-to-stuck**: if the recorded PID is dead and no session row can be bound, the
  updater falls through to the existing fail path and reaps the task to `stuck`, clearing
  `activeAgent`/`acpSessionKey`. Because hermes prints `session_id:` to the log right before
  exit and the bind step runs before the reap check in the same tick, the normal endgame is
  bind → completed → review. The literal `'pending'` sentinel is never persisted or
  recorded on this path: `sessionRefs` filters it out, `completedBy.sessionKey` falls back
  to the `sourceTag`, and the updater's internal maps (tracking, ended-dedup, agent
  history) key provisional tasks by a task-scoped `pending:<taskId>` pseudo key so one
  crashed provisional spawn cannot gate other pending tasks.
- **Steer guard**: steering a task whose session key is still `pending` is rejected with an
  explicit "session is still starting" error (`HermesSessionStartingError`, mapped to
  HTTP 409 with `code: HERMES_SESSION_STARTING` by both steer routes) instead of
  attempting a bogus `--resume`.
- **Spawn dedup rule**: `spawn-agent` blocks a respawn (`duplicate: true`) while the
  linked Hermes session is live work (`starting`/`running`) OR idle with real recorded
  history (`message_count > 0` or `tool_call_count > 0` — an interactive session waiting
  between turns stays idempotent). Idle sessions with zero recorded activity do NOT
  block, per the bypass rule below. During the provisional window the dedup branch first
  attempts a synchronous `resolveLaunchedHermesSession` bind so the check evaluates the
  real session's state; an unresolvable `pending` task with a dead PID allows the respawn
  (accepted narrow edge).
- **State-classification hardening (salvaged from the prior attempt)**: `clawbeat`'s
  `runtime_status_is_active()` no longer has the "Hermes session idle but active Ns ago"
  branch — a recent `startedAt`/`updatedAt` alone never counts as live work for a Hermes
  session; only `starting`/`running` do. Regression test:
  `cli/test_clawbeat_runtime_status.py`.

### Bypass Rule
For product tasks blocked by a Hermes retry that registers an empty session, bypass the
spawn after one retry when all of these are true:
1. The task/session is Hermes-backed and still marked active or in-progress.
2. The linked Hermes session has no live PID, or `runtimeState` is `missing`/`idle`.
3. `message_count = 0`, `tool_call_count = 0`, and the run log is empty or absent.
4. The session is older than the startup grace window (90 seconds for Hermes runtime state;
   45 seconds for Sessions API heartbeat presentation).

When the rule matches, treat the spawn as empty/stale rather than live work: do not keep
waiting on it, and continue the product task via the documented fallback/manual bypass path.

### Automated Regression Tests

```bash
cd backend
npm test -- --runInBand src/__tests__/sessionAvailability.test.ts
npm test -- --runInBand
npm run build

cd ..
python3 -m pytest cli/test_clawbeat_runtime_status.py -q
# If pytest is unavailable in the QA runtime, use the self-contained fallback:
python3 cli/test_clawbeat_runtime_status.py
```

Note: the dev frontend has no vitest tooling (no `vitest.config.ts`, no `test` script), so
there is no automated frontend regression here. The Sessions UI empty-state behaviour
("runtime missing" instead of indefinite "starting" copy, via
`frontend/src/pages/sessionPresentation.ts`) already ships in dev and must be checked
manually on the Sessions page.

### Evidence DB Split-Brain (read this before gathering evidence)

There are TWO Hermes `state.db` files and they do not see each other's sessions:

- **Container-private** `/data/hermes-home/.hermes/state.db` (inside the backend
  container, `HOME=/data/hermes-home` for spawned turns). This is where task-spawned
  Hermes sessions register and is the **authoritative DB for task spawns** — the spawn
  poll, the bind-by-sourceTag reconciler, and any stale-row evidence for this bug must
  query this file.
- **Read-only host mount** `/hermes-live` (`HERMES_READ_STATE_DB_PATH`). The Sessions
  page reads this side, so task-spawned sessions may be invisible on the dashboard even
  while they exist in the container-private DB. Do not use `/hermes-live` to prove or
  disprove a task-spawn registration.

All captured evidence below was read from the container-private
`/data/hermes-home/.hermes/state.db` side.

### Captured Reproduction Evidence

Stale examples from the original video-factory failure path were verified in the
container-private `/data/hermes-home/.hermes/state.db` on 2026-04-25. Session
`20260425_094430_d2c891` for task `c137f2a0` has an empty run log at
`/data/hermes-task-runs/c137f2a0-2026-04-25T09-44-28-094Z.log` and the runtime DB row:

```json
{
  "id": "20260425_094430_d2c891",
  "source": "cli",
  "title": null,
  "started_at": 1777110270.6473086,
  "ended_at": null,
  "message_count": 0,
  "tool_call_count": 0,
  "actual_messages": 0,
  "last_message_at": null,
  "run_log_size_bytes": 0
}
```

The same query found additional stale examples from the original video-factory failure path:
`20260425_094426_b3fa52` and `20260425_052744_01a67f`, both with `ended_at = NULL`,
`message_count = 0`, `tool_call_count = 0`, `actual_messages = 0`, and no
`last_message_at`, matching the zero-message-session failure mode observed while unblocking
`c137f2a0`. A later controlled d825502e session (`20260425_171913_efe003`) is not used as
current stale evidence because it subsequently recorded messages during retry validation.

Note that `source": "cli"` on these rows shows the spawned turns were persisted without
the task `sourceTag` — which is why the bind step keeps the run-log `session_id:`
fallback alongside the `sessions.source` lookup (an unfiltered recent-session fallback
was considered and deliberately rejected as unsafe).

### Manual Evidence Command

Run inside the backend container (the sqlite path below is the container-private,
authoritative-for-task-spawns side of the split-brain):

```bash
clawboard session-status <task-id>
python3 - <<'PY'
import sqlite3, json
sid = '<hermes-session-id>'
conn = sqlite3.connect('/data/hermes-home/.hermes/state.db')
conn.row_factory = sqlite3.Row
row = conn.execute('''
  SELECT id, started_at, ended_at, message_count, tool_call_count,
         (SELECT COUNT(*) FROM messages WHERE session_id = s.id) AS actual_message_rows,
         (SELECT MAX(timestamp) FROM messages WHERE session_id = s.id) AS last_message_at
    FROM sessions s WHERE id = ?
''', (sid,)).fetchone()
print(json.dumps(dict(row), indent=2))
PY
```

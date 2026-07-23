# Hardened ClawBeat orchestration and bounded review implementation plan

Task: `a422c1eb-1f62-430e-8aff-d5db6f424f29`
Baseline: reviewed audit report `8ce4cb81-334c-4884-8243-ed500d42d054`
Feature branch: `feature/a422c1eb-hardened-clawbeat`
Baseline commit: `2c1f79b08636dd93de0f8e4baf212cbd4980507b`

## Scope and invariants

This slice makes PostgreSQL the authoritative lifecycle store and keeps filesystem ledgers as transport diagnostics only. It must preserve explicit `auto_start=false`, dependency safety, role-separated subtask review, and Hermes/OpenClaw runtime parity.

Required invariants:

1. A start claim is compare-and-set against the task's current status/update version and rechecks dependencies in the same transaction.
2. At most one active execution lease exists per task and resource/worktree key.
3. Active work suppresses only conflicting candidates; it never blocks unrelated review, human notification, completion, or dependency-ready work.
4. Review is eligible only for a contiguous implemented prefix: no earlier required subtask may be `empty`, `in_progress`, or `blocked` before a subtask in `review`.
5. Every reviewer attempt has immutable identity: task, attempt number, task snapshot, implementation session/commit or artifact receipt, and reviewer session.
6. Reject increments the DB-backed attempt counter exactly once. A duplicate or delayed verdict is a no-op after advancement.
7. Retry exhaustion moves the task to `stuck`, sets `needs_review=true`, and records one structured escalation.
8. Notification dedup becomes durable only after a transport receipt. Failed delivery remains retryable with bounded backoff.
9. Human/device/credential/trust gates remain blocked for human review and cannot be auto-approved.
10. Dry-run inspection never mutates task, attempt, lease, history, notification, or filesystem state.

## Exact rollout configuration and defaults

The hardened controller is fail-closed and independently switchable from legacy ClawBeat while it is proven on DEV:

| Variable | Default | Meaning |
|---|---:|---|
| `TASK_REVIEWER_HEARTBEAT_ENABLED` | `false` until DB-backed controller exists and DEV proof passes | Reserved for the DB-backed review poller. The current implementation rejects `true` at startup rather than starting the legacy filesystem-backed reviewer under a misleading hardened flag. |
| `REVIEWER_HEARTBEAT_INTERVAL_MS` | `15000` | Review polling interval; values below 1000 ms are invalid. |
| `TASK_REVIEW_TIMEOUT_MS` | `300000` | Per-attempt deadline; timeout is recorded as no verdict. |
| `REVIEWER_HEARTBEAT_STATE_FILE` | `/data/reviewer-heartbeat-state.json` | Compatibility diagnostic cache only, never lifecycle truth. |
| `CLAWBEAT_HARDENED_ORCHESTRATION_ENABLED` | `false` during rollout | Enables both the backend transactional claim/lease API and ClawBeat's pre-wake reservation. When false, the claim API rejects mutations and ClawBeat preserves the legacy wake path; when true, a spawn wake is suppressed unless the exact task snapshot is reserved successfully. |
| `CLAWBEAT_MAX_ACTIVE_GLOBAL` | `1` | Shared-host writer budget; higher values require distinct resource leases. |
| `CLAWBEAT_MAX_ACTIVE_PER_PROJECT` | `1` | Per-project concurrency/fairness bound. |
| `CLAWBEAT_LEASE_TTL_MS` | `900000` | Execution lease TTL renewed by compare-and-set heartbeat. |
| `CLAWBEAT_NOTIFICATION_BASE_BACKOFF_MS` | `60000` | First failed-delivery retry delay. |
| `CLAWBEAT_NOTIFICATION_MAX_BACKOFF_MS` | `900000` | Bounded exponential retry ceiling. |
| `CLAWBEAT_HERMES_QA_REPO` | canonical deployed repo from `DEPLOYED_REPO_PATH`, otherwise process repo root | Optional validated override; the obsolete `/srv/ai-stack/projects/nim-projects/...` constant is removed. |

Invalid values fail startup rather than silently falling back. Flags are read once and logged without secrets. Disabling hardened orchestration stops new reservations but preserves every existing audit row.

## Stable identities, transaction boundaries and state policy

### Claim identity and dependency locking

The stable start key is `claim:<full-task-uuid>:<task-updated-at>:<harness>:<resource-key>`. `claimReadyTask` runs one PostgreSQL transaction that locks the candidate `FOR UPDATE`; verifies its snapshot, `todo`, `auto_start=true`, harness and profile; locks dependency edges and parents in sorted UUID order; requires `completed` or `archived` with `archive_disposition='completed'`; checks global/project/resource budgets; inserts the lease; compare-and-sets the parent to `in-progress`; appends history; and commits. Archived-abandoned fails closed everywhere.

A uniqueness conflict returns the existing lease, not a second claim. Any parent update, dependency edit, snapshot change, or conflict aborts the transaction. Scheduler pre-filtering is advisory only.

### Exact review-slice identity and eligibility

A review key is `review:<full-task-uuid>:<attempt-no>:<task-updated-at>:<slice-hash>`. The canonical ordered slice contains `{subtaskId,index,title,status,updatedAt,evidenceReceipt}`; its SHA-256 is persisted. Every earlier required item must be completed/skipped, the final claimed item(s) must be in review, no earlier item may be empty/in-progress/blocked, and each reviewed item needs an immutable commit/artifact receipt. Structural edits invalidate the attempt.

Generic `PATCH /tasks/:id` rejects `subtasks`. Separate orchestrator-only structural endpoints may add/rename/reorder but never set lifecycle state. Dedicated lifecycle endpoints enforce source→destination rules and immutable history; request-body `orchestrator: true` is not authorization.

### Deterministic verdict and retry policy

- `pass`: CAS the matching running attempt to passed, store findings/reviewer identity, and leave the parent in review for operator completion; no attempt increment.
- `reject`: CAS to rejected, increment exactly once, reset only exact failed review subtask IDs, preserve accepted siblings, and return the parent to in-progress while budget remains.
- `timeout`: CAS to timed_out as no verdict; one replacement may run within budget, and delayed verdicts are no-ops.
- exhaustion: at `max_retries` (default 3), CAS to escalated, parent to stuck, `needs_review=true`, and reserve one escalation delivery.
- duplicates: mutate only when attempt ID/number, task snapshot, slice hash, implementation session/commit, and status match; otherwise return the recorded outcome unchanged.

### Dual-harness runtime and reviewer routing

Both adapters return `{harness,state,sessionKey,messageCount,toolCallCount,lastActivityAt,processEvidence,errorClass}`, with state in `running|idle|stale|failed|completed|none`. Hermes combines task metadata with Hermes SQLite/activity evidence; OpenClaw uses gateway/session JSONL evidence. A metadata label alone never proves liveness.

Reviewer delivery first uses the task's harness-specific QA route. Hermes QA executes as OS user `hermes` from the validated canonical repo. Preflight, launch, or session-registration failure proceeds through configured `wake_delivery` fallbacks, including OpenClaw, rather than returning early. Launch is provisional until session/control identity and positive runtime evidence exist.

### Durable notification receipts

Delivery key: `notify:<full-task-uuid>:<kind>:<state-version>:<destination>`. Reservation creates/returns pending. `sent` requires a non-empty receipt with transport, destination ID, provider message/session ID, and acknowledged timestamp. Failure stores only a sanitized class, increments attempts, and sets bounded exponential `next_retry_at`; it never completes dedup. Concurrent senders lock rows with `FOR UPDATE SKIP LOCKED`. Blocked-human, stale, review and escalation use the same path.

## Schema changes

Add one forward migration after the current migration chain:

### `task_execution_leases`

- `id uuid primary key`
- `task_id uuid references tasks(id) on delete cascade`
- `resource_key text not null` (task/worktree/resource identity)
- `harness text check in ('hermes','openclaw')`
- `session_key text`
- `status text check in ('active','released','expired','failed')`
- `claimed_task_updated_at timestamptz not null`
- `acquired_at`, `heartbeat_at`, `expires_at`, `released_at`
- metadata JSONB and failure reason
- partial unique indexes for one active lease per task and one active lease per resource key

### `task_review_attempts`

- `id uuid primary key`
- `task_id uuid references tasks(id) on delete cascade`
- `attempt_no integer not null`
- `status text check in ('pending','running','passed','rejected','escalated','timed_out','cancelled')`
- `task_snapshot_updated_at timestamptz not null`
- `review_slice_version smallint not null default 1`; `0` is reserved for synthetic legacy rows and `1` is the canonical reviewed-subtask schema
- canonical v1 `review_slice jsonb not null` records require `{subtaskId,index,title,status,updatedAt,evidenceReceipt}`; legacy v0 records require the explicit `legacy_review_attempt` identity fields
- SHA-256 `review_slice_hash` and `implementation_receipt_hash` fields with format/non-empty constraints
- implementation and reviewer session keys
- implementation commit and evidence JSONB
- verdict/findings/error JSONB/text
- `idempotency_key text unique not null`
- timestamps including deadline/finished time
- unique `(task_id, attempt_no)`

### `task_notification_deliveries`

- `id uuid primary key`
- task foreign key, notification kind, destination/transport
- unique stable `idempotency_key`
- `status` in `pending/sending/sent/failed/suppressed`
- attempt count, retry timestamp, durable receipt JSONB, sanitized error code
- created/updated/sent timestamps

The migration is additive and rollback is code-first: disable new controller routes/heartbeat integration, retain tables for audit, and return to legacy read-only ledgers. Destructive rollback is explicitly forbidden.

## Backend services

### `TaskOrchestrationService`

- `claimReadyTask(taskId, snapshotUpdatedAt, harness, resourceKey, ttl)` locks the task row, rechecks `todo`, `auto_start`, dependencies and active lease conflicts, then atomically creates a lease and moves the task to `in-progress`.
- `heartbeatLease`, `releaseLease`, and `expireLeases` are idempotent.
- Main/direct tasks remain trackable without being considered spawnable when `auto_start=false`.

### `TaskReviewerService`

- `beginAttempt` locks the task, validates review eligibility/evidence, and creates or returns the idempotent current attempt.
- `recordVerdict` compare-and-sets the attempt and task snapshot. Pass leaves the parent in review for independent/operator completion; reject returns the task to `todo` or `in-progress` with the exact failed subtask(s) reset; exhaustion escalates to `stuck` and sets `needs_review=true`.
- Appends a compatibility projection into `tasks.review_history` and synchronizes `attempt_count`, but `task_review_attempts` is authoritative.
- A timeout is recorded as no verdict; retry/escalation follows explicit policy rather than pretending failure is a reviewer decision.

### `TaskNotificationService`

- Reserves delivery by stable idempotency key.
- Marks `sent` only with a non-empty transport receipt.
- Stores failed delivery with bounded exponential backoff and sanitized error codes.
- Blocked-human/review-escalation notifications use this service rather than pre-ack JSON suppression.

## API and CLI

Add authenticated reviewer/orchestration endpoints:

- `POST /tasks/:id/orchestration/claim`
- `POST /tasks/:id/orchestration/lease/heartbeat`
- `POST /tasks/:id/orchestration/lease/release`
- `POST /tasks/:id/reviewer/run` with genuine `dryRun`
- `POST /tasks/:id/reviewer/verdict`
- `POST /tasks/:id/reviewer/reject`
- `GET /tasks/:id/reviewer/attempts`

CLI behavior:

- `clawboard review <id>` remains a review-focused read/handoff view.
- `clawboard review <id> --run-reviewer [--dry-run]` calls the real reviewer route.
- `clawboard reject <id> --reason ...` records a structured rejection.
- Implementation-agent role cannot call verdict/reject/approval paths.

## ClawBeat changes

1. Remove the global early return when any worker is active. Build an active lease/session conflict set and continue processing independent candidates.
2. Classify each task independently and emit at most one action per task per tick, with project-aware stable ordering and configured concurrency bounds.
3. Fix contiguous-prefix review eligibility and add explicit tests for `completed,review,empty` and `review,empty`.
4. Route non-human `stuck` main/direct tasks with blocked subtasks to escalation instead of filtering them out.
5. Use full task IDs for idempotency/dedup keys.
6. Move reviewer retries and human notification state into the DB services. Legacy JSON remains diagnostic/migration compatibility only.
7. Keep harness-specific runtime adapters but consume a normalized `running/idle/stale/failed/completed/none` result plus evidence counters.

## Test and deployment gates

Operational monitoring, executable SQL probes, DEV evidence capture, and the forward-only rollback procedure are defined in [`hardened-orchestration-operations.md`](./hardened-orchestration-operations.md).

Focused tests:

- migration-chain and concrete constraints/indexes
- dependency race and same-task/same-resource double claim
- explicit `auto_start=false` non-claim
- independent non-conflicting claims
- Hermes/OpenClaw normalized runtime cases
- partial-review rejection and contiguous-prefix acceptance
- duplicate/delayed verdict idempotency
- reject below budget, reject at budget, timeout, escalation
- notification failure then receipt-backed retry
- dry-run zero-mutation assertions

Bounded integration gates:

- backend focused Jest paths, then full `--runInBand` with `NODE_OPTIONS=--max-old-space-size=2048`
- ClawBeat Python runner tests
- `git diff --check`, backend build, frontend build if UI/types change
- PostgreSQL custom-format DEV backup, archive listing, explicit migration runner, ledger and concrete schema verification
- canonical DEV deploy, health/dashboard 200, authenticated `/api/dev/workspace/version` branch `dev` plus exact commit
- disposable DEV matrix across both harnesses, dependency race, duplicate wake, review pass/reject/escalate, failed notification retry, and cleanup

Production is not part of this implementation task. Promotion waits for dependent independent E2E task `1a50938a` and reviewed evidence.

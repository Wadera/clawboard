# Hardened orchestration operations and rollback runbook

This runbook covers the DB-backed task claim, runtime adapter, independent review, and durable notification delivery introduced by task `a422c1eb`. PostgreSQL is authoritative. Filesystem retry/dedup files are compatibility diagnostics only.

## Safety boundary

- Deploy and prove this feature on DEV before production promotion.
- Keep `TASK_ORCHESTRATION_ENABLED=false` and `TASK_REVIEWER_HEARTBEAT_ENABLED=false` until migrations and the DEV evidence matrix pass.
- Never enable either controller when its startup validation fails. Do not substitute the legacy controller.
- Preserve `auto_start=false`, blocked subtasks, human/device/credential gates, and dependency failures exactly; do not force them through to create progress.
- Treat migrations 051–054 as forward-only. Rollback disables controllers and reverts application code; it does not drop receipt, attempt, or lease history.

## Pre-deploy gates

Run from the candidate worktree as its owning user:

```bash
cd backend
NODE_OPTIONS=--max-old-space-size=2048 npm test -- --runInBand
npm run build
cd ..
python3 cli/test_clawbeat_lifecycle.py
python3 cli/test_clawbeat_wake_delivery.py
git diff --check dev...HEAD
```

For migrations, take and list a PostgreSQL custom-format backup before applying anything. Run `npm run migrate`, then run `npm run test:migrations:hardened` against a disposable PostgreSQL database. Verify ledger rows and concrete objects rather than trusting runner output alone:

```sql
SELECT name FROM schema_migrations
WHERE name IN (
  '051_task_reviewer_fields.sql',
  '052_hardened_orchestration.sql',
  '053_hardened_orchestration_upgrade.sql',
  '054_task_notification_payload.sql'
)
ORDER BY name;

SELECT to_regclass('public.task_execution_leases'),
       to_regclass('public.task_review_attempts'),
       to_regclass('public.task_notification_deliveries');
```

The executable migration proof must cover historical upgrade, fresh install, replay/idempotence, invalid retry bounds, concurrent capacity claims, exactly-once verdicts, and failure-before-receipt notification retry.

## Runtime observability

### Controller logs

Expected structured log prefixes:

- `[TaskOrchestrationService]` for claim/lease decisions
- `[ReviewerHeartbeatService]` for reviewer outcomes and retry failures
- `[TaskNotificationService]` for transport delivery failures
- `[Tasks API]` for authenticated orchestration/reviewer route failures

A metadata session label is not liveness proof. Reconcile task/session metadata with the harness-specific runtime adapter evidence: session key, normalized state, message/tool counts, last activity, and process evidence.

### Lease health

```sql
SELECT harness, status, count(*)
FROM task_execution_leases
GROUP BY harness, status
ORDER BY harness, status;

SELECT task_id, harness, status, expires_at, heartbeat_at,
       session_key, failure_reason, metadata
FROM task_execution_leases
WHERE status = 'active'
  AND expires_at < now()
ORDER BY expires_at;
```

Investigate expired active leases before reclaiming. A task with `Session: None` and no runtime evidence has no active writer.

### Review health

```sql
SELECT status, count(*)
FROM task_review_attempts
GROUP BY status
ORDER BY status;

SELECT task_id, attempt_no, status, created_at, finished_at,
       reviewer_session_key
FROM task_review_attempts
WHERE status IN ('running','rejected','escalated')
ORDER BY created_at DESC
LIMIT 50;
```

Every verdict must bind to the exact task snapshot, canonical review-slice version/hash, implementation receipt, and reviewer identity. A timeout is no verdict. Do not approve a newer artifact using an older attempt.

### Notification health

```sql
SELECT kind, status, count(*)
FROM task_notification_deliveries
GROUP BY kind, status
ORDER BY kind, status;

SELECT task_id, kind, destination, attempt_count, next_attempt_at, last_error_code
FROM task_notification_deliveries
WHERE status = 'failed'
ORDER BY next_attempt_at NULLS FIRST;
```

`sent` is valid only with a non-empty transport receipt. Failed rows remain retryable with bounded backoff. Never manually mark a failed row sent or write legacy dedup state before a sent/deduplicated receipt.

## DEV evidence matrix

Use disposable DEV tasks and clean them up after proof:

1. `auto_start=false` task is not claimed.
2. Ready dependency chain progresses only after all parents complete.
3. Concurrent claims cannot exceed global or project capacity.
4. Same task/resource duplicate claims return one authoritative lease.
5. Hermes and OpenClaw adapters distinguish live, idle, stale, failed, completed, and missing runtime evidence.
6. Review PASS leaves operator completion gated; REJECT resets only failed review subtasks; retry exhaustion moves to `stuck`, sets `needsReview`, and reserves one escalation.
7. Concurrent duplicate verdicts create one authoritative verdict and one compatibility history projection.
8. Blocked-human and escalation delivery failures do not complete dedup; retry succeeds once and stores a transport receipt.
9. DEV health and dashboard return 200, and authenticated `/api/dev/workspace/version` reports branch `dev` and the exact deployed commit.

Record task IDs, exact commit, test counts, migration ledger/object proof, API status/content type, and cleanup evidence in the independent QA report.

## Rollback

### Application rollback

1. Stop new scheduling/review work by setting both hardened controller flags to `false` and recreating the backend so environment changes take effect.
2. Confirm logs show neither DB-backed controller starting. Verify no new lease/review-attempt timestamps appear during at least two configured poll intervals.
3. Allow already-running workers to reach a safe boundary or cancel them individually after checking task/session/process evidence. Do not bulk-complete, bulk-reject, or clear human gates.
4. Revert/cherry-pick application code to the last reviewed commit and rebuild only the affected services.
5. Verify health, dashboard, authenticated workspace version, and core task read/update flows.

### Database rollback policy

Do **not** drop migrations 051–054 during an operational rollback. The tables and columns are additive audit history and old code ignores them. Dropping them can destroy verdict, lease, or notification receipts and make retry behavior ambiguous.

If a schema defect itself requires remediation:

1. keep both controllers disabled;
2. preserve a restore-tested custom-format backup;
3. ship a reviewed forward migration;
4. prove historical upgrade, fresh chain, and rerun idempotence in disposable PostgreSQL;
5. apply on DEV, verify ledger and concrete constraints/indexes, and repeat the DEV evidence matrix.

### Rollback acceptance

Rollback is complete only when controllers are disabled, no new authoritative rows are being produced, existing task/subtask/dependency state is unchanged, the deployed version is truthful, and health/task routes pass. Production rollback or promotion remains a separate human gate.

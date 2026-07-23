# Archived dashboard tile trace

Task: `0d9ad929-5250-424c-829c-9f7d0ae3c032`

## Production evidence (2026-07-16 UTC)

- PostgreSQL source truth: `status='archived'` = **860** tasks.
- `archived_at IS NOT NULL` = **859** tasks.
- One task has `status='archived'` with a null `archived_at`; no task has a non-null `archived_at` with a non-archived status.
- Authenticated `GET /api/tasks?status=archived` returns **860** tasks.
- Authenticated `GET /api/tasks` returns **117** active/non-archived tasks.
- Authenticated `GET /api/dashboard/summary` returns a legacy direct payload with all task counters and total equal to zero. It omits both `success` and `summary`, and also omits `archived` entirely.

## Source-to-UI chain

1. `frontend/src/pages/DashboardPage.tsx` requests `/dashboard/summary`.
2. The frontend accepts the response only when `data.success && data.summary`. The deployed route does not satisfy that contract, so the page falls back to `/tasks`.
3. The fallback computes counts from the returned task array, but `/tasks` excludes archived tasks unless explicitly requested. Therefore `tasks.filter(t => t.status === 'archived')` is always zero.
4. `backend/src/routes/dashboard.ts` is the deeper source mismatch: it imports the legacy JSON-backed singleton from `services/TaskManager.ts`, calls synchronous `getAllTasks()`, and returns direct fields instead of the frontend contract.
5. The authoritative task API uses PostgreSQL-backed `TaskManagerDB`; its default query intentionally excludes archived rows, while an explicit archived status query returns all 860.
6. In the production backend, the legacy JSON task manager is empty for dashboard purposes (`/dashboard/summary total=0`) even though PostgreSQL contains the live board. This makes every legacy summary counter wrong, not only Archived.

## Root cause

The dashboard summary route and frontend disagree on both source and response schema. The route reads obsolete JSON-backed state and returns a direct object; the frontend expects `{ success: true, summary: {...} }`, rejects the response, then falls back to a PostgreSQL endpoint that intentionally excludes archived tasks. The visible Archived value of zero is therefore deterministic and is not a cache-refresh issue.

## Canonical archived semantics

The dashboard tile counts the lifecycle bucket, so its canonical predicate is
`tasks.status = 'archived'`. This is the same predicate used by the task API,
board column, restore flow, archive disposition, and dependency semantics. The
`archived_at` field is transition metadata for ordering and audit display; it is
not an alternative membership flag and must not make an archived task disappear
from the count.

The one mismatched production row is
`a870c84b-09a7-4fae-9b0a-2dcde83f7b50` (`TEST[prod-harness-default]: routing
check`). It is `status='archived'`, `archive_disposition='abandoned'`, and has a
null `archived_at`. Its task history ends at the earlier `review` transition and
does not record the later archive mutation, so the available evidence cannot
identify which historical/manual path wrote it. Current `TaskManagerDB.updateTask`
does set `archived_at` on entry into the archived status. The mismatch is legacy
data drift, not a reason to redefine archive membership from a nullable timestamp.
A separate guarded data repair may backfill the timestamp if the exact transition
time can be established; the count fix must remain correct before and after such
a repair.

## Follow-up boundary

The correction should make `/dashboard/summary` query PostgreSQL directly,
return the schema consumed by `DashboardPage`, and report `archived` from the
canonical lifecycle predicate above. Regression coverage must include an archived
row with a null `archived_at`, proving that lifecycle membership—not optional
timestamp metadata—drives the tile.

# Task 0d9ad929 — DEV validation evidence

Reviewed and deployed candidate: `8a3b1946c41e5ffc069d84debb5ce8faf832e8c1`.

## Independent implementation review

- Feature worktree was clean and matched `origin/feature/0d9ad929-archived-count`.
- `git diff --check origin/dev...HEAD` passed.
- Source review confirmed the dashboard summary now queries PostgreSQL and defines archive membership as `tasks.status = 'archived'`; `archived_at` remains transition metadata.
- Production source-query audit found 860 archived-status rows, including one legacy archived row with `archived_at IS NULL`, which explains the former 859/860 timestamp/status mismatch.
- Focused backend Jest: `DashboardSummary.test.ts` — 1 suite, 2/2 tests passed.
- Backend TypeScript `tsc --noEmit` passed.
- Frontend production build passed: 2,561 modules transformed.

## DEV deployment and live proof

- Fast-forwarded and pushed `dev` to `8a3b1946c41e5ffc069d84debb5ce8faf832e8c1`.
- Rebuilt/recreated DEV backend and frontend from `/srv/ai-stack/projects/nimspace/clawboard/dev/docker-compose.dev.yml`; restarted DEV nginx after upstream recreation.
- Public health: `/api/dev/health` HTTP 200; `/dashboard-dev/` HTTP 200.
- Authenticated `/api/dev/workspace/version`: branch `dev`, commit `8a3b1946c41e5ffc069d84debb5ce8faf832e8c1`.
- Authenticated `/api/dev/dashboard/summary`: `archived = 11`.
- Authenticated `/api/dev/tasks?status=archived`: 11 tasks.
- Executable DEV PostgreSQL source query `COUNT(*) WHERE status='archived'`: 11.
- Therefore the live DEV dashboard summary, task API, and source database agree exactly.

## Bounded suite status

- Full serial backend Jest on deployed DEV: 57 suites passed, 2 failed; 500 tests passed, 4 failed (59 suites / 504 tests total).
- The task-focused dashboard suite passed in that run.
- `JournalPublicationExactlyOnce.test.ts` reproduced unchanged on untouched pre-candidate baseline `e02a3e2` (2 failures), proving it is pre-existing and unrelated to this slice.
- `journalMediaRoot.test.ts` passes from the untouched source worktree but fails only inside the backend container because that test resolves compose files at container root where they are not mounted; this is an existing test-environment path issue, not a regression in the dashboard slice.

Subtask 3 is ready for next-fresh-tick independent review. This evidence does not self-approve that subtask.

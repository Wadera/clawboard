# Automated Task Reviewer

This document describes the live backend execution path for automated review in ClawBoard.

## Trigger path

1. An agent completes implementation and hands off with `clawboard review <task-id>`.
2. The task enters `review`.
3. `ReviewerHeartbeatService` polls review tasks every `REVIEWER_HEARTBEAT_INTERVAL_MS` (default 15s).
4. For each changed review fingerprint, the heartbeat calls `TaskReviewerService.runReview(..., { triggeredBy: 'system' })`.
5. After each run, the heartbeat stores the post-review fingerprint from the refreshed task record so `pass` outcomes do not get re-reviewed forever just because `updated` changed.
6. The reviewer records evidence and decides `pass`, `reject`, or `escalate`.

## Evidence sources

The reviewer evaluates:
- `successCriteria` / `definitionOfDone`
- linked reports for the task
- session refs and `completedBy`
- workspace evidence (cwd, git branch, changed files, diff stat)
- test-like command signals detected from reports/task/workspace evidence

## Safety rails

- timeout: `TASK_REVIEW_TIMEOUT_MS` (default 5 minutes)
- retry budget: `maxRetries` per task, default 3
- escalation behavior:
  - move task to `stuck`
  - set `needsReview=true`
  - append a `reviewHistory` entry
  - emit a stuck notification through `NotificationManager`
  - post a stuck lifecycle update into the task Discord thread when `discordThreadId` exists

## CLI behavior

- `clawboard review <task-id>`: hand off to review state only
- `clawboard review <task-id> --run-reviewer`: force an immediate reviewer execution via API
- `clawboard reject <task-id> --reason "..."`: structured reviewer rejection with attempt tracking

The CLI reviewer run timeout is 330 seconds to cover the 5-minute backend review budget.

## Automated regression coverage

Backend coverage now includes:
- `TaskReviewerService.test.ts`
  - pass
  - dry-run verification without task mutation
  - reject with attempt increment
  - missing criteria escalation
  - timeout escalation
- `ReviewerHeartbeatService.test.ts`
  - heartbeat dedupe
  - reject -> fix -> pass cycle
  - pass dedupe after the reviewer updates the task record
  - retry-budget exhaustion -> escalate
- `scripts/e2e-reviewer-smoke.sh`
  - create review task with criteria
  - heartbeat-driven reject
  - dry-run reviewer no-mutation check
  - explicit pass via `clawboard review --run-reviewer`

## Notes

- The heartbeat dedupe state is stored in `REVIEWER_HEARTBEAT_STATE_FILE` (default `/data/reviewer-heartbeat-state.json`).
- A task that stays in `review` after `pass` will not be re-reviewed until its fingerprint changes.
- Human/orchestrator signoff is still the final completion boundary.

## Independent QA rule

The automated reviewer is a separate QA/orchestration role. It should not accept an implementation attempt solely because the implementing subagent says it passed. The reviewer must gather its own evidence and write a durable review outcome.

Practical rule:
- implementation subagent: build and hand off with `clawboard review <task-id>`
- QA reviewer: verify, report, and decide `pass` / `reject` / `escalate`
- if QA spawns follow-up fix work, that new work must return to review for another independent pass

## QA runtime access on this homelab

When review requires authenticated UI validation or secret retrieval, the Hermes QA reviewer should use:

- shared Spark Chromium via `/home/hermes/tools/spark-browser-open` and `/home/hermes/tools/spark-cdp-tunnel`
- Bitwarden/Vaultwarden via `/home/hermes/tools/bw-ensure-session` and `/home/hermes/tools/bw-get`

Important operational constraint discovered in live validation:
- these helpers are currently mode `0700` and owned by `hermes`
- a process running as `clawd` cannot execute them (`Permission denied`)
- therefore the ClawBeat-driven Hermes QA path must run in the `hermes` OS-user context, or via a controlled wrapper that executes those helper steps as `hermes`

## Reviewer evidence expectations

When the task's acceptance depends on browser-visible behavior, login-gated flows, or secrets-backed integrations, a `pass` should include evidence from the real QA path rather than only local shell assertions. Good evidence includes:

- Spark screenshots or CDP-backed browser checks
- authenticated API/browser proof gathered independently of the implementation run
- clear references to success criteria and any linked reports/specs
- explicit findings and next action (`pass`, `reject`, `escalate`)

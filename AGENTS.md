# ClawBoard Agent Workflow

This repository uses ClawBoard task state as the source of truth. Agents must use the CLI, not raw API calls.

## Automated reviewer workflow

1. Work subtasks in order with:
   - `clawboard start-subtask <task-id> <index>`
   - `clawboard complete-subtask <task-id> <index>`
2. When implementation is ready, hand off with:
   - `clawboard review <task-id>`
3. Do not mark the task completed directly.
4. Do not treat the implementing subagent as the final verifier of its own work. Local checks are encouraged, but final acceptance belongs to the review gate.
5. The backend reviewer heartbeat now polls review tasks automatically and runs the automated reviewer for tasks in `review`.
6. The reviewer records `reviewHistory`, updates `attemptCount`, and returns one of:
   - `pass` — task stays in `review` for orchestrator/human signoff
   - `reject` — task moves back to `todo` for another attempt
   - `escalate` — task moves to `stuck`, sets `needsReview=true`, and emits a stuck notification

## Role separation

- **Implementation subagent**: build the feature/fix, run local validation, and hand off with `clawboard review <task-id>`.
- **QA reviewer/orchestrator**: independently verify the result, write a review report, and decide whether to pass, reject, escalate to a human, or spawn follow-up fix work.
- The same agent should not both implement the task and count as the final approving reviewer for that same attempt.
- If the reviewer spawns a follow-up fix subagent, the task must return to review after the fix and be re-verified independently before approval.

## QA reviewer runtime requirements

The Hermes-based QA reviewer used by ClawBeat should be treated as a privileged verification worker, not just another coding subagent. When UI/authenticated proof is required, it should use:

- the shared Spark Chromium browser for visible full-browser validation
- Bitwarden/Vaultwarden via the local helpers for runtime secret retrieval

Operational note: on this host the Spark/Bitwarden helpers under `/home/hermes/tools/` are `0700` and owned by `hermes`. A ClawBeat-driven Hermes QA run must therefore execute in the **hermes OS user context** (or an equivalent wrapper) rather than as `clawd`, otherwise those helpers fail with `Permission denied`.

## Reviewer contract

Tasks that should use the automated reviewer must define:
- `successCriteria`
- optional `maxRetries` (default 3)
- enough evidence for review: reports, task/session metadata, workspace/test signals

## Safety rails

- automated reviewer timeout defaults to 5 minutes (`TASK_REVIEW_TIMEOUT_MS`)
- heartbeat poll interval defaults to 15 seconds (`REVIEWER_HEARTBEAT_INTERVAL_MS`)
- escalations write structured history, set `needsReview`, and notify through the task thread when Discord thread wiring exists

## Manual commands

- Run reviewer now: `clawboard review <task-id> --run-reviewer`
- Manual reviewer reject: `clawboard reject <task-id> --reason "why"`

## Important

- `clawboard review --run-reviewer --dry-run` should be treated cautiously until the live DEV stack is verified against the updated backend.
- If automation escalates a task, a human/orchestrator must decide the next step.

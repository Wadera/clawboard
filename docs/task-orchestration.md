# Task Orchestration

This document describes the real task lifecycle used by ClawBoard today, including the automated reviewer handoff that now exists in the live backend and CLI.

## Status flow

Tasks move through these task-level states:

- `ideas` — rough notes or future work
- `todo` — ready to be picked up
- `in-progress` — an agent or human is actively working
- `review` — work is finished enough for reviewer/orchestrator checks
- `stuck` — blocked or waiting on human input
- `completed` — accepted and done
- `archived` — hidden historical record

Subtasks use a separate lifecycle:

- `empty`
- `in_progress`
- `review`
- `blocked`
- `skipped`
- `completed`

## Review-aware task fields

Automated review depends on these task fields:

- `successCriteria` — explicit acceptance checks for the automated reviewer
- `definitionOfDone` — extra completion notes for humans/orchestrators
- `constraints` — scope, safety, or execution boundaries
- `maxRetries` — retry budget before escalating to a human
- `attemptCount` — current number of reviewer attempts
- `reviewHistory` — structured pass/reject/escalate audit trail
- `needsReview` — set when the task needs human attention after review

## Normal agent workflow

1. A human or orchestrator creates a task.
2. The task should include concise instructions plus any linked reports for deep context.
3. If automated review is desired, set `successCriteria` and optionally `maxRetries`.
4. The implementation agent works the task and marks each subtask with `start-subtask` / `complete-subtask`.
5. The implementation agent hands off with `clawboard review <task-id>` when the work is ready for checking.
6. A separate reviewer/orchestrator run gathers independent evidence and records findings.
7. The orchestrator or human decides the final next action based on the reviewer outcome.

## Role separation: implementation vs QA

ClawBoard should not rely on a subagent to self-certify its own work as the final acceptance signal. Use these roles deliberately:

- **Implementation subagent**: writes code/config/docs, runs local checks, and hands the task to review.
- **QA reviewer/orchestrator**: verifies the result independently, writes a review report, and chooses `pass`, `reject`, or `escalate`.
- **Human**: remains the approval boundary for ambiguous, risky, or high-impact changes and for escalations.

If a QA run finds issues, it may spawn or steer follow-up implementation work, but that follow-up must come back through review again before approval.

## Task creation requirements for trustworthy review

Tasks intended for automated QA should include enough context for an independent reviewer, not just the implementing agent. Prefer to include:

- explicit `successCriteria` written as observable checks
- `definitionOfDone` and `constraints` that distinguish must-have behavior from optional polish
- links to reports/specs/mockups/issues so the reviewer can compare implementation against the intended outcome
- environment notes when verification needs authenticated UI access, external services, or browser checks

When browser/auth validation is expected, task instructions should explicitly allow the QA reviewer to use the shared QA browser and runtime password-vault retrieval rather than assuming the implementing agent's own claims are sufficient.

## CLI commands

Use the CLI, never raw API calls.

```bash
clawboard start-subtask <task-id> <index>
clawboard complete-subtask <task-id> <index>
clawboard review <task-id>
clawboard review <task-id> --run-reviewer
clawboard reject <task-id> --reason "Missing evidence"
```

## What `clawboard review` means

`clawboard review <task-id>` is the normal handoff command.

- It moves the task into `review`
- It does not mark the task completed
- It signals that the agent is done and the review gate should take over

`clawboard review <task-id> --run-reviewer` does more:

- ensures the task is in `review`
- executes the backend reviewer service
- gathers evidence from task metadata, reports, sessions, and workspace/test signals
- persists a structured `reviewHistory` entry
- updates `attemptCount`
- returns one of: `pass`, `reject`, or `escalate`

## Reviewer outcomes

### Pass

Typical result:
- task stays review-ready for human/orchestrator signoff
- review history gets a `pass` entry
- evidence shows what was checked

### Reject

Typical result:
- task moves back to `todo`
- findings explain what is missing or failing
- `attemptCount` increases
- the next worker should address the explicit review findings

### Escalate

Typical result:
- task remains visible for human attention
- `needsReview` is set or preserved
- retry budget has been exhausted or the reviewer found something that needs judgment

## Retry budget and escalation

- `maxRetries` defaults to `3`
- each reject/escalate attempt increments `attemptCount`
- once the retry budget is exhausted, automation should stop bouncing the task indefinitely
- exhausted or ambiguous reviews should be surfaced for a human

## Frontend expectations

The dashboard should make these states legible:

- create/edit forms expose `successCriteria`, `definitionOfDone`, `constraints`, and `maxRetries`
- task detail shows reviewer status, attempt count, review history, and the durable task/session timeline
- board/task cards visually distinguish:
  - review in progress
  - needs human review
  - blocked/stuck work
- Sessions should show truthful empty states for `runtime missing` and `transcript unavailable` instead of implying every `active` session is still starting

## Durable task/session timeline

Task detail now treats session history as an audit trail, not just a pointer to the latest active run.

Timeline entries merge these sources in reverse chronological order:

- `task_timeline_events` — durable stored orchestration events such as spawn, steer, cancel, and reviewer outcomes
- `agentHistoryService` — session spawn/finish records preserved across respawns
- `reviewHistory` — pass/reject/escalate reviewer outcomes
- legacy `sessionRefs` — fallback links for older tasks created before the durable timeline existed

This matters because `activeAgent` and `acpSessionKey` only describe the current linked run. As soon as a task respawns, retries, or finishes, relying on those fields alone hides previous runs. The timeline keeps prior sessions linkable from the task even after the latest active session changes.

## Hermes vs OpenClaw session truth model

The Sessions page now distinguishes runtime truth from task linkage truth.

OpenClaw and Hermes expose different live-session signals:

- OpenClaw can provide a live runtime heartbeat (`liveState`) plus session snapshot telemetry.
- Hermes often only provides persisted SQLite session/message state. A task may still be linked to a Hermes session even when no live runtime heartbeat exists.

Important mismatch cases:

- `status=active` + `runtimeState=starting`
  - Fresh session, still inside the startup grace window.
- `status=active` + `runtimeState=missing` + `transcriptState=none`
  - Task/session linkage exists, but no current runtime heartbeat or transcript has appeared yet.
- `status=active` + `runtimeState=missing` + `transcriptState=missing`
  - Persisted metadata claims recorded work, but the transcript file is unavailable.
- `status!=active` + `runtimeState=ended`
  - Historical session; no live runtime should be implied.

The UI should present those states literally. `active` alone is not proof that the runtime is still attached, especially for Hermes-linked sessions.

## Orchestrator policy

Recommended orchestration policy:

1. agents never mark a task completed directly
2. agents only hand off with `clawboard review <task-id>`
3. the backend reviewer heartbeat polls `review` tasks automatically and runs the reviewer without waiting for a manual CLI call
4. humans/orchestrators approve the final completion boundary after a `pass`
5. rejected tasks go back to work with explicit feedback, not silent status churn
6. escalated tasks move to `stuck`, set `needsReview=true`, and should be triaged by a human

## Reviewer heartbeat + safety rails

The backend now starts a reviewer heartbeat service on boot.

- poll interval: `REVIEWER_HEARTBEAT_INTERVAL_MS` (default `15000`)
- per-review timeout: `TASK_REVIEW_TIMEOUT_MS` (default `300000` / 5 minutes)
- state file: `REVIEWER_HEARTBEAT_STATE_FILE` (default `/data/reviewer-heartbeat-state.json`)
- dedupe: the heartbeat fingerprints each review task and only re-runs when the review payload changes
- escalation side effects:
  - status moves to `stuck`
  - `needsReview` becomes `true`
  - a `reviewHistory` entry is recorded
  - the task thread gets a stuck lifecycle message when Discord thread wiring exists
- `clawboard review --run-reviewer --dry-run` is intended for non-mutating reviewer inspection; this now has dedicated regression coverage in `TaskReviewerService.test.ts` and `scripts/e2e-reviewer-smoke.sh`

## Minimum evidence standard

A reviewer run is only useful if it cites real signals such as:

- success criteria checked
- linked reports used as requirements context
- session references
- changed files / diff summary
- test or command evidence
- authenticated browser evidence when the task depends on UI or login-gated behavior
- clear findings with severity

For Hermes-based QA, authenticated browser evidence should prefer the shared QA browser session plus runtime password-vault retrieval when needed. If the reviewer cannot reach the required browser/auth path independently, prefer `reject` or `escalate` over trusting the implementing subagent's own validation claims.

If the reviewer cannot gather enough evidence, prefer `escalate` over a vague pass.

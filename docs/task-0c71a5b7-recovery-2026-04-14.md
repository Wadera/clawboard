# Task 0c71a5b7 recovery brief (2026-04-14)

## Current verified state
- Task `0c71a5b7` was left in `stuck` with repeated `stale_agent` / `no_process` failures.
- Prior review feedback said the claimed fix referenced methods that did not exist in the working tree at review time: `extractAssistantDelta` and `isRecentDuplicateOutbound`.
- A cleanup stash was later found: `stash@{0}` (`pre-98e1cf71-cleanup-20260413T224420Z`).
- That stash contained relevant Discord thread loop-fix code mixed together with unrelated task-board / 98e1cf71 work.
- The relevant part was recovered onto branch `recovery/0c71a5b7-stash-20260414` as commit `d7cd911`.

## Already recovered on this branch
Recovered file:
- `backend/src/services/DiscordThreadService.ts`

Recovered safeguards now present in the branch:
- delta extraction for cumulative assistant stream snapshots via `extractAssistantDelta(...)`
- outbound duplicate suppression via `isRecentDuplicateOutbound(...)`
- listener cleanup in `setGatewayConnector(...)` to avoid stacking duplicate `agent:stream` subscriptions
- per-thread `lastAssistantText` tracking

## What still needs verification
1. Confirm whether the recovered logic actually matches the real loop symptom in production-like behavior.
2. Check whether there are additional loop sources beyond the recovered safeguards, especially:
   - repeated `agent:stream` listener registration
   - cumulative assistant payloads from `GatewayConnector`
   - duplicate outbound thread posts
   - thread polling / steer acknowledgements amplifying traffic
   - any delivery-mirror interaction, if relevant
3. Add a safe, controlled reproduction path.
4. Decide whether to add a runtime safety brake / feature flag for live thread streaming before production re-enable.
5. Verify bounded behavior with a fresh smoke run.

## Important scoping rules
- Stay strictly on task `0c71a5b7`.
- Do **not** mix in `98e1cf71` kanban / archived / board-loading work.
- Do **not** assume the recovered stash is fully correct just because it exists.
- Prefer minimal, bounded containment over broad refactors.
- Avoid spamming a real Discord task thread during reproduction.

## Suggested investigation focus
Primary files:
- `backend/src/services/DiscordThreadService.ts`
- `backend/src/services/GatewayConnector.ts`
- `backend/src/services/SubAgentTaskUpdater.ts`
- any tests touching Discord thread streaming behavior

## Outcome we want
A fresh agent should:
- audit the recovered changes
- verify what is genuinely fixed vs still missing
- finish the remaining implementation safely
- prove bounded, non-cumulative thread behavior
- leave rollout guidance for whether production streaming should remain gated

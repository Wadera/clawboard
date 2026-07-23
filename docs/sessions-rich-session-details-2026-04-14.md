# Sessions page richer spawned-task details

Date: 2026-04-14
Task: `357685b2` Sessions page richer spawned-task session details and capabilities visibility

## Audit findings

### Already available before this change
- `GET /api/sessions` exposed core session facts: key, kind, label, model, channel, status, token counts, cost, timestamps, transcript path, file size, and raw `spawn_info`.
- `GET /api/sessions/:key` already enriched a selected session with linked task basics: task id, title, status, execution mode, ACP session key, Discord thread id, active agent, and whether the match came from `acp_session_key` or `active_agent`.
- The Sessions detail UI already showed transcript, tool calls, task link fallback, spawn parent/depth, and inline task steering for interactive linked tasks.

### Gaps that made review/debugging harder
- You could not see the linked task's execution profile from Sessions, so access profile and required capabilities were hidden.
- Agent identity was fuzzy. Kind was visible, but agent type, active agent name, and execution mode were not presented as a clear "what is running" story.
- Thinking level lived on the task, not the session UI.
- Discord steering thread visibility was weak. The thread id existed, but the Sessions detail panel did not surface it as a first-class link.
- Context-window pressure was effectively invisible. Token totals were shown, but there was no pressure/health indicator.
- Delivery context in `spawn_info.deliveryContext` was available but not surfaced in a readable way.

## UI design delivered
- Keep the existing transcript-first Sessions layout.
- Expand the pinned header so the selected session shows three compact info cards before the transcript:
  - **Linked task**
  - **Capabilities and tools**
  - **Execution details**
- Keep top-row quick actions for:
  - dashboard task link
  - Discord steering thread link when present
  - stop button for live stoppable sessions
- Preserve inline steering above the transcript for interactive linked tasks.

## Backend changes needed
- Enrich linked task metadata returned by `GET /api/sessions/:key` with:
  - `executionProfile`
  - `model`
  - `thinking`
  - `agentName`
  - `agentType`
  - `discordThreadUrl`
- Continue resolving linked tasks by:
  1. exact `acp_session_key`
  2. fallback interactive `active_agent.sessionKey`

## Frontend changes needed
- Read richer `session.task` metadata from the session detail fetch.
- Show execution/access/capability metadata without requiring navigation to task detail.
- Estimate context pressure from model family + recorded token usage, and degrade to an explicit unavailable state when the provider/model is unknown.
- Surface `spawn_info.deliveryContext` only when present.

## Degraded-state rules
- If task linkage is missing, keep the old task-id-from-label fallback for the task button only.
- If execution profile is missing, render `Unavailable` instead of empty chips or broken layout.
- If context window cannot be estimated for a model family, show `Unavailable for this model` rather than inventing a percent.
- If Discord thread url cannot be built perfectly, still expose the stored thread id and best-effort link.
- If recent tool activity is absent, show `No tool activity yet`.

## Acceptance criteria
- Selected spawned-task sessions show linked task identity, execution profile, thinking level, runtime label, and recent tool/capability visibility in one place.
- Sessions detail exposes a direct task link and a Discord steering-thread link when thread metadata exists.
- Access profile and required capabilities are visible without opening the task page.
- Context-window pressure is surfaced as a readable health signal with explicit fallback behavior.
- Missing provider-specific fields degrade gracefully with neutral copy, not empty or broken UI.
- Existing steering flow and transcript/tool-call panels continue working.

## Implementation notes
- Context pressure is heuristic, based on model family, because per-session provider context limits are not currently stored in session rows.
- Discord thread URLs prefer `DISCORD_GUILD_ID` when present; otherwise the UI falls back to a best-effort Discord deep link using the thread id.
- This change enriches the detail endpoint first. If task badges are later desired in the session list itself, the same metadata can be projected into `GET /api/sessions` in a follow-up.

# Sessions page task steering design note

Date: 2026-04-14
Task: `6676578e` Sessions page inline task steering chat

## Goal

Allow the Sessions page to expose task steering directly inside the main Messages area when the selected session belongs to an interactive spawned task. The steering UX should feel native to Sessions, preserve transcript context, and reuse the existing task live-session plumbing instead of duplicating task-modal-only logic.

## Scope delivered

Implemented code paths:
- `backend/src/routes/sessionsApi.ts`
- `frontend/src/components/tasks/LiveSessionPanel.tsx`
- `frontend/src/components/tasks/LiveSessionPanel.css`
- `frontend/src/pages/SessionsPage.tsx`
- `frontend/src/pages/SessionsPage.css`

## Acceptance criteria

### Functional
- When a selected session is linked to an interactive task, Sessions shows an inline steering composer above the transcript.
- Sending a steering message from Sessions uses the existing task steering backend route, `POST /tasks/:id/steer`.
- The normal transcript remains visible below the steering controls, so users can steer and read the conversation in one place.
- Existing pause, resume, cancel, and Discord-thread affordances remain available through the reused live-session component.
- Task link in the Sessions header prefers backend-linked task metadata, not label parsing alone.

### Fallback behavior
- If backend task linkage is missing, Sessions falls back to the previous label-based task-id extraction for the task link only.
- If no linked interactive task is found, Sessions behaves exactly like a normal transcript viewer and does not render steering UI.
- If steering is unavailable because the task is not active, the transcript still renders normally.
- If transcript data is unavailable, the steering block can still render when task linkage exists, while the message panel shows the existing transcript-unavailable state.

### UX rules
- Steering controls are visually separated from transcript content.
- The steering block explicitly tells the user that steering goes to the linked task session and transcript remains below.
- Steering should appear only for interactive tasks, not for ordinary sessions or non-interactive tasks.
- Transcript remains the source of truth for historical messages. Steering UI is an action surface, not a second transcript renderer.

## Backend wiring

### Session to task linkage

`GET /api/sessions/:key` now enriches the returned session object with optional `task` metadata.

Link resolution strategy:
1. Match `tasks.acp_session_key = sessionKey`
2. Fallback: for interactive tasks, parse `active_agent` JSON and match `activeAgent.sessionKey === sessionKey`
3. Prefer direct `acp_session_key` matches over `active_agent` matches

Returned task summary fields:
- `id`
- `title`
- `status`
- `executionMode`
- `acpSessionKey`
- `discordThreadId`
- `activeAgent`
- `sessionMatch`

This keeps the Sessions page from depending on brittle label regexes for primary linkage.

## Frontend wiring

### Reused component

`LiveSessionPanel` was extended instead of duplicated.

New reuse points:
- exported `LiveSessionTaskRef` type for a minimal task-shaped object
- new `variant` prop with:
  - `full` for existing task modal behavior
  - `inline-controls` for Sessions embedding
- optional `title`, `description`, and `inputPlaceholder`
- lightweight inline notice area for send/pause/cancel feedback

### Sessions detail flow

`SessionDetailPanel` now:
1. seeds linked task state from `session.task` when present
2. refreshes session metadata with `GET /api/sessions/:key`
3. renders `LiveSessionPanel` above Messages only when `linkedTask.executionMode === 'interactive'`
4. leaves the transcript polling path unchanged below the steering controls

This keeps the transcript fetch and task steering fetch logically separate:
- transcript source: `/sessions/:key/messages`
- steering metadata source: `/sessions/:key`
- steering action source: `/tasks/:id/steer`

## Steering visibility and permissions

Show steering only when all of the following are true:
- a linked task is found
- `linkedTask.executionMode === 'interactive'`

Send input is only enabled when the reused `LiveSessionPanel` considers the task active, which currently means:
- task status is `in-progress`
- a session key is available via `acpSessionKey` or `activeAgent.sessionKey`

Permissions currently rely on the same auth path already used by task steering in the task modal:
- authenticated dashboard user
- backend authorization already enforced by the existing tasks routes

No new permission model was added in this change.

## Offline and degraded states

### Sessions metadata fetch fails
- The page keeps any already-known `session.task` value.
- If no task metadata is available, steering UI does not render.
- The task link can still fall back to label parsing.

### Transcript unavailable
- Existing transcript-unavailable message remains in the Messages panel.
- If linked task metadata exists, steering controls can still appear above that empty/unavailable transcript state.

### Session offline or inactive
- Transcript stays readable if present.
- Steering composer hides when the task is not active, because the reused live-session component only enables input for active interactive runs.

### No task linkage
- Sessions behaves as a plain session inspector.

## Known limitations

- Task linkage is currently added on `GET /sessions/:key`, not on the session list payload. Detail view fetches metadata after selection.
- Label parsing still exists as a compatibility fallback for the header link.
- Frontend build cleanup hit an existing permission issue in `frontend/dist`, unrelated to this feature.
- Backend TypeScript build is already failing on unrelated environment/type issues and was not introduced by this change.

## Suggested follow-ups

- Add task linkage directly to `GET /api/sessions` list results, so cards can show task-backed state without extra fetches.
- Add a small badge in the Sessions list for task-backed interactive sessions.
- Consider explicit backend field for steering availability instead of deriving from task status and execution mode in the client.
- Add an integration test covering: linked interactive session, transcript unavailable, and non-task session fallback.

## Verification performed

- `frontend: npx tsc --noEmit` passed
- `frontend: npm run build` reached Vite build but failed cleaning old `dist/` assets due to filesystem permissions
- backend build remains blocked by unrelated existing TypeScript environment issues

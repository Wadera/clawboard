# Task Execution Options Source of Truth

## Frontend
- `frontend/src/constants/taskExecution.ts`
  - Canonical frontend values for execution mode, access profile labels/hints, derived profile capabilities, and selectable extra capabilities.
- `frontend/src/hooks/useTaskModelOptions.ts`
  - Canonical frontend model list source.
  - Reads `/api/models/status` and listens for realtime `model:status` updates.
  - Preserves saved models that are no longer available as `(legacy/unavailable)`.
- Task option editors/views:
  - `frontend/src/components/tasks/CreateTaskModal.tsx`
  - `frontend/src/components/tasks/EditTaskModal.tsx`
  - `frontend/src/components/tasks/TaskDetailModal.tsx`

## Backend
- `backend/src/routes/models.ts`
  - Source of truth for available/configured OpenClaw models exposed to the UI.
  - Provides `preferredDefaultModel`, `defaultModel`, and `models.available`.
- `backend/src/routes/tasks.ts`
  - Source of truth for validating and normalizing task execution payloads.
  - Validates execution mode, access profile, required capabilities, and derives profile-implied capabilities.
  - Spawn flows now fall back to the configured preferred default model instead of stale hardcoded task-model lists.
- `backend/src/services/TaskManagerDB.ts`
  - Persists `executionProfile`, `executionMode`, `model`, and related task metadata.

## CLI
- `cli/clawboard`
  - No longer hardcodes a closed list of task models for create/update.
  - Defers to backend-configured default model on spawn when a task has no explicit model.
  - Supports both:
    - `--allow-override-at-spawn`
    - `--lock-spawn-profile`

## Current behavior rules
- Access-profile capabilities are auto-included and shown as derived.
- Users only toggle extra capabilities beyond those defaults.
- Saved legacy models remain visible/selectable in UI instead of disappearing.
- Spawn-time override policy is editable in create, edit, and task detail flows.

## Remaining follow-up
- `executionProfile.notes` is still backend/CLI-supported but not yet exposed in the dashboard task forms.
- There are still separate legacy references in older migration/tool-seed text describing `new` / `in_review`; they are historical docs, not runtime validation.

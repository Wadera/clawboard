# ClawBoard API — usage notes

_Last updated: 2026-07-04 (task 3c7da35b). Machine-readable spec: `GET /openapi.json` (auth required)._

## Basics

- Public base: `https://<your-domain>/api` (nginx strips `/api`; backend routes have no prefix). Direct backend: `http://localhost:3001/`. Dev stack: `/api/dev`.
- Auth: `Authorization: Bearer <JWT>` on everything except `/health`.
- Task ids in URLs must be **full UUIDs** — 8-char prefixes are resolved client-side by the CLI only (`INVALID_TASK_ID` otherwise).

## Error envelope

New-style errors (validation, webhooks, batch, uncaught-500s) return:

```json
{ "success": false, "error": "…", "code": "VALIDATION_FAILED", "message": "…",
  "suggestion": "what to do about it", "details": [{ "field": "title", "problem": "is required" }] }
```

`error` mirrors `message` for backward compatibility with older `{success,error,code}` consumers. Older routes migrate to `sendApiError` opportunistically — codes are stable either way.

## Validation

`POST`/`PATCH` bodies on the new endpoints are validated field-by-field
(`src/middleware/validate.ts`) — expect `400 VALIDATION_FAILED` with a
`details` array naming each offending field.

## Batch updates

`PATCH /tasks/batch` — `{ "ids": [<uuid>…max 100], "updates": { … } }`.
Allowed fields: `status`, `priority`, `project`, `autoStart`, `tags`, `notes`,
`blockedReason`. Per-id results; HTTP 200 if ≥1 succeeded, 422 if all failed.
Lifecycle gates apply per task exactly as in single PATCH.

## Webhooks (outbound)

Register: `POST /webhooks` `{ "url": "https://…", "secret": "…", "events": ["task.updated"], "description": "…" }`
Events: `task.created`, `task.updated`, `task.deleted`, `task.archived` (default: all).

Delivery: JSON `{event, data, timestamp}`; `data` is a task summary
(id/title/status/priority/project/autoStart/tags) or `{id}` for delete/archive.
Headers: `X-ClawBoard-Event`, `X-ClawBoard-Webhook-Id`, and — when a secret is
set — `X-ClawBoard-Signature: sha256=<hmac-sha256(body)>`. Verify by recomputing
the HMAC over the raw body. Best-effort delivery: 5s timeout, one retry, status
recorded on the webhook row (`GET /webhooks` shows `last_delivery_*`). n8n tip:
a Webhook-node URL + the signature check covers most automation flows.

## OpenAPI coverage

`/openapi.json` documents the **core** surface (tasks, batch, spawn/steer,
projects, agent-types, sessions, reports, models, webhooks, health). Routes not
listed there are internal/unstable — read the source before relying on them.

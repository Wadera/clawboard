# Hermes personality status policy (J12)

`bot_status` is a sparse editorial timeline, not an audit log. Historical Nim/Spark rows and authorship remain unchanged. New automated rows are authored by **Hermes** with `author_harness=hermes`.

## Eligible moments

- A meaningful trigger uses `event_id=task:<UUID>`. The API locks and reads that task, requires `status=completed` plus a non-null `completed_at`, and requires the caller timestamp to match before writing a server-owned receipt. Caller assertion alone is never eligibility.
- An explicit manual request may publish a moment without waiting four hours, but never bypasses the daily cap, idempotency, prose, authorship, or privacy checks.
- Maximum **3** Hermes statuses per **Europe/London** calendar day.
- Minimum **4 hours** since the previous Hermes status unless the request is explicitly manual.
- The stable event fingerprint is SHA-256 of Hermes authorship, trigger type, and non-secret event ID. Replays return the existing row.
- Exact and lexical near-duplicate prose is suppressed with a deterministic token/character-trigram Jaccard threshold of **0.72**. Event IDs and receipts must not contain credentials, private conversation text, or raw task payloads.

## Voice

Write one short first-person personality comment (20–500 characters). Mention the human meaning or emotional texture of the completed goal. It may be playful, relieved, curious, or proud, but must stay truthful.

**Good**

> I finally turned the status stream back into something that feels like me rather than a clipboard. Quietly pleased: fewer updates, better moments, and room for the work to breathe.

> I untangled the photo review so the next choice is actually pleasant instead of archaeological. I’m feeling unusually tidy—and trying not to disturb the feeling.

**Prohibited**

- `Completed: J12; Active: J13; Blocked: J14.`
- `3 tasks in progress, 2 awaiting review, health check healthy.`
- bullets, numbered lists, checkboxes, task/session IDs, queue or blocker inventories;
- health digests, watchdog/smoke-test output, deployment summaries, audit formatting;
- claims that Nim/Spark memories, actions, or historic rows were Hermes-authored.

## Optional avatar

The integration boundary calls the configured remote Hermes `image_generate` backend **once**. It requests a provider result and a **256×256 delivered resize**. The current Hermes OpenAI/Codex backend does not expose a trustworthy low-quality/native-resolution control, so resizing reduces delivered storage/display size, not provider generation cost. There is no retry and no local diffusion. Failure, invalid dimensions, or an unavailable adapter yields `avatar_url=null`; text publication may continue.

The executable scheduler boundary is `docs/hermes-status-scheduler-contract.md` plus `scripts/hermes_status_avatar.py`: Hermes owns the single real tool call, while the helper only validates/resizes its delivered MEDIA file into the allowed generated-media tree. The backend does not fake a Hermes tool invocation.

Production scheduling and publication remain disabled until independent review. Automation uses `x-api-key`; dashboard JWTs are not persisted in jobs.

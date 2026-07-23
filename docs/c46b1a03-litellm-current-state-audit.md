# c46b1a03 — LiteLLM current-state audit

Date: 2026-07-16 UTC
Scope: subtask 0, read-only audit of the running LiteLLM deployment. No secret values are recorded here.

## Result

LiteLLM already has a persistent PostgreSQL database and a non-empty master key. Database-backed model storage is enabled. However, the running master-key/encryption context cannot decrypt the seven existing database model records, so authenticated discovery currently returns zero usable models. This must be repaired or explicitly migrated before ClawBoard model administration can safely manage the existing inventory.

## Deployment topology

- Running container: `ai-litellm`, image `ghcr.io/berriai/litellm:main-latest`, host port 4000, up for four days at audit time.
- Compose source: `/srv/ai-stack/projects/docker-compose-core.yml`.
- Persistent database: `ai-postgres`, PostgreSQL 16, database/user `litellm` / `llm_user` on the external `ai_mesh` network.
- PostgreSQL data is persisted at `/srv/ai-stack/projects/data/postgres`.
- LiteLLM config is read-only mounted from `/srv/ai-stack/projects/configs/litellm/config.yaml`; it contains only `litellm_settings.drop_params: true`.
- Compose sets `STORE_MODEL_IN_DB=True` and supplies `DATABASE_URL`, `LITELLM_MASTER_KEY`, and admin UI credentials through runtime environment variables.

## Secret-safe runtime checks

Container-environment inspection reported:

- `DATABASE_URL`: present; PostgreSQL scheme; host `ai-postgres`; port 5432; database `litellm`.
- `LITELLM_MASTER_KEY`: present and has the expected `sk-` prefix. Its value was not printed or persisted.
- `STORE_MODEL_IN_DB=True`.
- Admin email/password variables: present. Values were not printed or persisted.

HTTP checks against `127.0.0.1:4000`:

- `GET /health/liveliness` without auth: HTTP 200.
- `GET /v1/models` without auth: HTTP 401.
- `GET /v1/models` with the runtime master key: HTTP 200, `data_count=0`.
- `GET /model/info` with the runtime master key: HTTP 200, `data_count=0`.
- `GET /key/list` with the runtime master key: HTTP 200, `total_count=3`.
- `GET /spend/logs` with the runtime master key: HTTP 200, 16,534 rows returned at audit time.

The key was held only in an ephemeral shell variable and unset after each probe.

## Database evidence

The Prisma/LiteLLM schema is installed and includes model, key, spend, budget, health, team, user, audit and migration tables. Relevant row counts at audit time:

| Table | Rows |
|---|---:|
| `LiteLLM_ProxyModelTable` | 7 |
| `LiteLLM_ModelTable` | 0 |
| `LiteLLM_VerificationToken` | 11 |
| `LiteLLM_SpendLogs` | 16,534 |
| `LiteLLM_HealthCheckTable` | 0 |

The seven proxy-model aliases are `gemini/*`, `stt/whisper`, `tts/kitten-tts-mini`, `tts/kokoro`, `tts/qwen3-0.6b-customvoice`, `tts/qwen3-1.7b-customvoice`, and `tts/qwen3-1.7b-voicedesign`.

## Critical finding: encryption-key continuity is broken

Authenticated model discovery returns zero records even though PostgreSQL contains seven proxy-model rows. The live LiteLLM logs reproduce `nacl.exceptions.CryptoError: Decryption failed. Ciphertext failed verification` for encrypted `api_key` and `api_base` fields, with LiteLLM's own diagnostic asking whether the master/salt key changed.

This means:

1. The current master key is valid for authenticating the admin API.
2. It is not sufficient to decrypt the existing model configuration ciphertext.
3. Existing model records must not be overwritten or deleted as a shortcut.
4. A database backup and a key-continuity/re-encryption recovery plan are required before model create/update/delete work.

## Implementation implications for later subtasks

- Put a ClawBoard backend adapter in front of LiteLLM; never expose the LiteLLM master key to the browser or CLI.
- Use server-side runtime secret injection and narrow operations for model listing/mutation, virtual keys, spend, and health.
- Treat the current empty model API response as a technical failure, not as an empty configured estate.
- Before mutating models, back up PostgreSQL and either restore the original encryption key context or perform a documented forward re-entry/migration of the seven aliases with independently retrieved provider credentials.
- Preserve existing verification-token and spend history rows.
- Health UI must report the current decrypt/discovery failure explicitly rather than marking all LiteLLM models healthy by default.

## Reproducible review targets

An independent reviewer should verify:

1. `ai-litellm` and `ai-postgres` topology from Docker/Compose.
2. Presence-only environment facts without printing values.
3. PostgreSQL model/key/spend row counts.
4. Unauthenticated 401 and authenticated 200 behavior.
5. Authenticated model discovery count of zero.
6. Recent LiteLLM log evidence for ciphertext verification failure.

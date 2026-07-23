# Discord thread links — derivation and fallback rules

_Last updated: 2026-07-04 (task a62eb292)._

## The bug this design fixes

ClawBoard used to render task/session Discord links as
`https://discord.com/channels/@me/<threadId>`. The `@me` path segment means
"DM channel" to Discord — it only resolves for direct-message channels. Task
threads are **guild** threads, so the links 404'd unless the user manually
swapped in the guild id. Correct form:

```
https://discord.com/channels/<guildId>/<threadId>
```

(For threads, the thread id is used directly in the channel position.)

## Where the metadata comes from

| Datum | Source | Notes |
|---|---|---|
| `threadId` | `tasks.discord_thread_id` (migration 032) | Persisted by `DiscordThreadService.createThreadForTask()` after the OpenClaw gateway `thread-create` call. |
| `threadId` fallback | OpenClaw session keys | `agent:main:discord:channel:<threadId>` or `agent:main:discord:thread:<parentChannelId>:<threadId>` — parsed from `acpSessionKey`, then `activeAgent.sessionKey`, then `completedBy.sessionKey`. Covers tasks whose thread-create raced the spawn and never persisted the column. DM keys (`discord:dm:<id>`) are deliberately ignored. |
| `guildId` | `DISCORD_GUILD_ID` env, default `1292093857038598155` | The homelab is single-guild (SKYDAY, the sole entry in `openclaw.json` → `channels.discord.guilds`). No guild id is stored per-task/session anywhere in the DB — the env/default is the only source. |

## Canonical builders

- Backend: `backend/src/utils/discordLinks.ts` — used by the sessions API
  (`LinkedTaskSummary.discordThreadUrl`) and task payload hydration
  (`TaskManagerDB.rowToTask` → `task.discordThreadUrl`).
- Frontend: `frontend/src/utils/discordLinks.ts` — prefers the backend URL when
  the payload carries one, builds the guild URL otherwise. Used by
  `TaskDetailModal`, `LiveSessionPanel`, and the Sessions page.

Do not hand-roll `discord.com/channels/...` URLs anywhere else.

## Fallback rules (explicit)

1. `discordThreadUrl` from the API payload → use as-is.
2. Else build from resolved thread id + guild id (env override → default).
3. `@me` is emitted **only** when `DISCORD_THREAD_URL_CONTEXT=dm`
   (backend) / `VITE_DISCORD_THREAD_URL_CONTEXT=dm` (frontend) is set —
   i.e. a deployment whose agent threads genuinely live in DMs.
4. No thread id resolvable → no link rendered (never a broken guess).

## Env configuration

`DISCORD_GUILD_ID=1292093857038598155` is set in `docker-compose.dev.yml` and
`docker-compose.prod.yml` next to the other Discord vars, making the default
explicit and overridable per deployment.

## Verification (QA criteria from report 13f0036e)

Authenticated dev API must return guild-scoped `discordThreadUrl` for real
thread-backed tasks, e.g. `d6832df4` (thread `1496456354553004032`) and
`74814717` (thread `1495383542320861305`); the served frontend bundle must
contain the guild id; both the task views and the Sessions page render the
guild-scoped link.

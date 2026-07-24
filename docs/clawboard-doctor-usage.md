# ClawBoard doctor

`clawboard doctor` runs a board-integrity audit from the canonical ClawBoard CLI. It reads tasks, projects, agent personas, and model status through the ClawBoard API using GET requests only — it never mutates board state.

## Usage

```bash
clawboard doctor                         # human-readable report
clawboard doctor --json                  # machine-readable report
clawboard doctor --discord-summary       # compact summary for Discord
clawboard doctor --deliver hermes-discord            # deliver summary via `hermes send`
clawboard doctor --deliver hermes-discord --dry-run  # preview delivery
clawboard doctor --post-discord --discord-webhook URL  # deliver via raw Discord webhook
clawboard doctor --install-cron          # install weekly user cron (Mondays 08:00)
clawboard doctor --install-cron --dry-run
```

## Delivery

The default output is stdout only. `--deliver hermes-discord` sends the compact
summary through the LLM-free `hermes send` CLI as the Hermes OS user
(`sudo -n -u <hermes-user> hermes send --to TARGET`).
The target uses the hermes target format
`platform:chat_id` (e.g. `discord:<channel-id>`) and can be set with
`--deliver-target` or `CLAWBOARD_DOCTOR_DELIVER_TARGET`. This requires NOPASSWD sudo
for the invoking user (true for `clawd` on the AI VM) and needs no webhook secret or
running gateway.

Webhook posting alternatively uses `--discord-webhook` or
`CLAWBOARD_DOCTOR_DISCORD_WEBHOOK_URL` / `CLAWBOARD_DOCTOR_DISCORD_WEBHOOK` at runtime.
Do not commit webhook URLs.

The installed cron runs Mondays at 08:00 and appends logs to `/tmp/clawboard-doctor.log`.
`scripts/clawboard-doctor-weekly.sh` is an equivalent wrapper that normalizes doctor
exit code 2 (findings present) to 0 for scheduler use.

## Checks

The check registry currently detects:

1. `dangling-depends-on` — active task depends on a missing task ID.
2. `archived-depends-on` — active task depends on an archived task.
3. `stale-blocked-flags` — task has blocked metadata after blockers/dependencies are gone.
4. `duplicate-project-names` — non-archived projects share a normalized name.
5. `duplicate-persona-names` — agent personas share a normalized name.
6. `duplicate-persona-slugs` — agent personas share a normalized slug.
7. `missing-dod` — active task lacks `definitionOfDone` and `successCriteria`.
8. `autostart-outside-todo` — `autoStart=true` on a task outside `todo`.
9. `task-without-project` — active task has no project or references an unknown project.
10. `unavailable-model-pin` — task model pin is absent from `/models/status` available/default model set.

Exit code is `2` when error-severity issues are found, `1` for command/delivery failures, and `0` otherwise.

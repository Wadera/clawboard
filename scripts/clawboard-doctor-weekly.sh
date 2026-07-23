#!/usr/bin/env bash
# Weekly ClawBoard doctor run + Discord summary delivery via hermes send.
# Intended to be run from cron on the AI VM host (as clawd, who has NOPASSWD sudo).
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
python3 cli/clawboard doctor --json --deliver hermes-discord
rc=$?
# doctor exits 2 when error-severity integrity findings are present. For weekly
# notification purposes, a delivered summary is success; reserve nonzero for
# command/runtime/delivery failure so cron logs can alert on broken plumbing.
if [ "$rc" = "2" ]; then
  exit 0
fi
exit "$rc"

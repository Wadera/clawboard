#!/usr/bin/env bash
# run-backfill.sh — Trigger a one-time backfill of historical JSONL sessions.
#
# BUG-08: 730 old-format (agent:main:...) sessions were indexed but never had
# their messages ingested into session_messages. Running this script will bulk-
# ingest those JSONL files so archived sessions can show messages in the UI.
#
# The backfill is idempotent — already-processed sessions are skipped.
# Large installs may take several minutes.
#
# Usage:
#   ./scripts/run-backfill.sh                    # uses default backend URL
#   BACKEND_URL=http://localhost:3001 ./scripts/run-backfill.sh
#   BACKEND_URL=http://localhost:3001 AUTH_TOKEN=mytoken ./scripts/run-backfill.sh
#
# The backend must be running and accessible at BACKEND_URL.

set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
TRANSCRIPTS_DIR="${TRANSCRIPTS_DIR:-}"

echo "🗂  ClawBoard — Historical Session Backfill"
echo "  Backend: $BACKEND_URL"
echo ""

PAYLOAD="{}"
if [[ -n "$TRANSCRIPTS_DIR" ]]; then
  PAYLOAD="{\"transcriptsDir\": \"$TRANSCRIPTS_DIR\"}"
  echo "  Transcripts dir: $TRANSCRIPTS_DIR"
fi

AUTH_HEADER=""
if [[ -n "$AUTH_TOKEN" ]]; then
  AUTH_HEADER="-H \"Authorization: Bearer $AUTH_TOKEN\""
fi

echo "  Triggering POST /sessions/backfill …"
echo "  (This may take several minutes for large installs. The request returns immediately.)"
echo ""

RESPONSE=$(curl -s -X POST \
  "${BACKEND_URL}/api/sessions/backfill" \
  -H "Content-Type: application/json" \
  ${AUTH_TOKEN:+-H "Authorization: Bearer $AUTH_TOKEN"} \
  -d "$PAYLOAD")

echo "Response: $RESPONSE" | python3 -m json.tool 2>/dev/null || echo "Response: $RESPONSE"
echo ""
echo "✅ Backfill triggered. Check backend logs for progress."
echo "   Sessions with kind='main' and zero messages will be ingested."

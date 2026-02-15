#!/bin/sh
# ClawBoard entrypoint — handles PUID/PGID for host file access
# If running as root, create a user with PUID/PGID and drop privileges.
# Otherwise, run as the current user.

set -e

PUID="${PUID:-1002}"
PGID="${PGID:-1002}"

# If running as root, create user and drop privileges
if [ "$(id -u)" = "0" ]; then
  echo "🔧 Entrypoint: Dropping to PUID=$PUID PGID=$PGID"
  
  # Create group if it doesn't exist
  addgroup -g "$PGID" -S appgroup 2>/dev/null || true
  
  # Create user if it doesn't exist
  adduser -S -u "$PUID" -G appgroup -h /app appuser 2>/dev/null || true
  
  exec su-exec "$PUID:$PGID" "$@"
else
  # Already running as non-root, just exec
  exec "$@"
fi

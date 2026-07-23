#!/bin/sh
# ClawBoard entrypoint — handles PUID/PGID for host file access
# If running as root, create a user with PUID/PGID and drop privileges.
# Otherwise, run as the current user.

set -e

PUID="${PUID:-1002}"
PGID="${PGID:-1002}"
HERMES_BOOTSTRAP_SOURCE="${HERMES_BOOTSTRAP_SOURCE:-/seed/hermes-config}"
HERMES_HOME_PATH="${HERMES_HOME_PATH:-/data/hermes-home}"
HERMES_RUNTIME_DIR="$HERMES_HOME_PATH/.hermes"

seed_hermes_runtime() {
  if [ ! -d "$HERMES_BOOTSTRAP_SOURCE" ]; then
    return 0
  fi

  mkdir -p "$HERMES_RUNTIME_DIR"

  # Seed the private runtime Hermes home from the host Hermes profile. Hermes v0.17
  # reads config.yaml and .env; copying only the older config.json/auth.json pair
  # makes task-spawned Hermes runs fail with "no API keys or providers found".
  for file in auth.json config.json config.yaml settings.json context_length_cache.yaml .env; do
    if [ -f "$HERMES_BOOTSTRAP_SOURCE/$file" ]; then
      cp "$HERMES_BOOTSTRAP_SOURCE/$file" "$HERMES_RUNTIME_DIR/$file"
    fi
  done

  chmod 600 "$HERMES_RUNTIME_DIR/.env" "$HERMES_RUNTIME_DIR/auth.json" 2>/dev/null || true
  chmod 644 "$HERMES_RUNTIME_DIR/config.yaml" "$HERMES_RUNTIME_DIR/config.json" "$HERMES_RUNTIME_DIR/settings.json" "$HERMES_RUNTIME_DIR/context_length_cache.yaml" 2>/dev/null || true
}

# If running as root, create user and drop privileges
if [ "$(id -u)" = "0" ]; then
  echo "🔧 Entrypoint: Dropping to PUID=$PUID PGID=$PGID"

  getent group "$PGID" >/dev/null 2>&1 || groupadd -g "$PGID" appgroup
  id -u appuser >/dev/null 2>&1 || useradd -M -u "$PUID" -g "$PGID" -d /app -s /bin/sh appuser

  seed_hermes_runtime || true
  mkdir -p "$HERMES_HOME_PATH" /data /data/hermes-task-runs /data/agent-workspace
  chown -R "$PUID:$PGID" "$HERMES_HOME_PATH" /data

  exec gosu "$PUID:$PGID" "$@"
else
  # Already running as non-root, just exec
  exec "$@"
fi

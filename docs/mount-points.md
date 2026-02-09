# ClawBoard Mount Points

This document describes all directories and files that need to be mounted into the ClawBoard containers.

## Overview

ClawBoard needs access to OpenClaw's data directories to read session transcripts, configurations, and other runtime data. All mounts are configured via environment variables in your `.env` file.

## Required Mounts

### 1. OpenClaw Sessions (read-only)

**Purpose:** Read session transcripts and conversation history

- **Host:** `${OPENCLAW_DIR}/agents/main/sessions/`
- **Container:** `/openclaw/sessions/`
- **Access:** Read-only (`ro`)
- **Contents:**
  - `sessions.json` - Session metadata
  - Individual `.jsonl` files - Session transcripts

**Example:**
```yaml
volumes:
  - ~/.openclaw/agents/main/sessions:/openclaw/sessions:ro
```

### 2. OpenClaw Config (read-only)

**Purpose:** Read gateway configuration and agent profiles

- **Host:** `${OPENCLAW_DIR}/`
- **Container:** `/openclaw/config/`
- **Access:** Read-only (`ro`)
- **Contents:**
  - `openclaw.json` - Gateway configuration
  - `agents/main/agent/auth-profiles.json` - Authentication profiles

**Example:**
```yaml
volumes:
  - ~/.openclaw:/openclaw/config:ro
```

### 3. Data Directory (read-write)

**Purpose:** Store dashboard data, session history, and generated content

- **Host:** `${DATA_DIR}` (default: `./data/`)
- **Container:** `/data/`
- **Access:** Read-write (`rw`)
- **Contents:**
  - Database backups
  - Session exports
  - Generated files
  - Temporary data

**Example:**
```yaml
volumes:
  - ./data:/data:rw
```

**Note:** This directory is created automatically if it doesn't exist.

### 4. ClawBoard Config (read-only)

**Purpose:** Dashboard configuration file

- **Host:** `./clawboard.config.json`
- **Container:** `/app/clawboard.config.json`
- **Access:** Read-only (`ro`)
- **Contents:** Dashboard settings, themes, feature flags

**Example:**
```yaml
volumes:
  - ./clawboard.config.json:/app/clawboard.config.json:ro
```

## Optional Mounts

These mounts are optional but provide additional functionality:

### 5. Media Directory (read-write)

**Purpose:** Store and serve generated media (images, audio, etc.)

- **Host:** `~/clawd/media/generated/`
- **Container:** `/media/generated/`
- **Access:** Read-write (`rw`)

**Example:**
```yaml
volumes:
  - ~/clawd/media/generated:/media/generated:rw
```

### 6. Memory Directory (read-only)

**Purpose:** Access agent memory files

- **Host:** `~/clawd/memory/`
- **Container:** `/memory/`
- **Access:** Read-only (`ro`)

**Example:**
```yaml
volumes:
  - ~/clawd/memory:/memory:ro
```

### 7. Project Sources (read-only)

**Purpose:** Access project source code directories

- **Host:** `~/clawd/projects/`
- **Container:** `/project-sources/`
- **Access:** Read-only (`ro`)

**Example:**
```yaml
volumes:
  - ~/clawd/projects:/project-sources:ro
```

### 8. NFS Projects Directory (read-write)

**Purpose:** Large project files and shared storage

- **Host:** `/mnt/nfs/NimsProjects/`
- **Container:** `/nfs-projects/`
- **Access:** Read-write (`rw`)

**Example:**
```yaml
volumes:
  - /mnt/nfs/NimsProjects:/nfs-projects:rw
```

## Environment Variables

Configure mount paths in your `.env` file:

```bash
# OpenClaw directory (required)
OPENCLAW_DIR=/home/user/.openclaw

# Data directory (required)
DATA_DIR=./data

# Sessions directory (derived from OPENCLAW_DIR)
SESSIONS_DIR=${OPENCLAW_DIR}/agents/main/sessions

# Optional: Custom paths for advanced setups
MEMORY_DIR=/home/user/clawd/memory
PROJECTS_DIR=/home/user/clawd/projects
NFS_DIR=/mnt/nfs/NimsProjects
```

## Docker Compose Configuration

Here's how these mounts appear in `docker-compose.yml`:

```yaml
services:
  clawboard-backend:
    volumes:
      # Required mounts
      - ${OPENCLAW_DIR:-~/.openclaw}/agents/main/sessions:/openclaw/sessions:ro
      - ${OPENCLAW_DIR:-~/.openclaw}:/openclaw/config:ro
      - ${DATA_DIR:-./data}:/data:rw
      - ./clawboard.config.json:/app/clawboard.config.json:ro
      
      # Optional mounts (uncomment if needed)
      # - ${MEMORY_DIR:-~/clawd/memory}:/memory:ro
      # - ${PROJECTS_DIR:-~/clawd/projects}:/project-sources:ro
      # - ${NFS_DIR:-/mnt/nfs/NimsProjects}:/nfs-projects:rw
```

## Permissions

### Linux/macOS

Ensure the user running Docker has read access to OpenClaw directories:

```bash
# Check permissions
ls -la ~/.openclaw/agents/main/sessions/

# Fix if needed
chmod -R u+r ~/.openclaw/
```

### Docker User Mapping

ClawBoard containers run as non-root user (UID 1002) for security. If you encounter permission issues:

1. **Option 1:** Match host UID to container UID (1002)
   ```bash
   sudo chown -R 1002:1002 ./data/
   ```

2. **Option 2:** Use Docker user mapping
   ```yaml
   services:
     clawboard-backend:
       user: "${UID}:${GID}"
   ```

## Troubleshooting

### "Permission denied" errors

**Symptom:** Container can't read OpenClaw files

**Solution:**
1. Check OpenClaw directory exists: `ls -la ~/.openclaw/`
2. Verify read permissions: `chmod -R u+r ~/.openclaw/`
3. Ensure mount path in `.env` is correct

### "File not found" errors

**Symptom:** Container can't find config files

**Solution:**
1. Verify `clawboard.config.json` exists in repo root
2. Check `OPENCLAW_DIR` environment variable is set correctly
3. Ensure Docker can access the host path (not a symlink issue)

### Container can't write to data directory

**Symptom:** Database backups or exports fail

**Solution:**
```bash
# Create data directory if missing
mkdir -p ./data

# Fix permissions
chmod -R u+rw ./data/
# Or match container UID
sudo chown -R 1002:1002 ./data/
```

### SELinux issues (RHEL/CentOS/Fedora)

If using SELinux:

```bash
# Allow Docker to access bind mounts
sudo chcon -Rt svirt_sandbox_file_t ./data/
sudo chcon -Rt svirt_sandbox_file_t ~/.openclaw/
```

Or use `:z` or `:Z` volume flags:

```yaml
volumes:
  - ~/.openclaw:/openclaw/config:ro,z
```

## Security Best Practices

1. **Read-only by default:** Mount OpenClaw directories as read-only unless write access is explicitly needed
2. **Minimal exposure:** Only mount directories the container actually needs
3. **Non-root containers:** ClawBoard runs as UID 1002 (non-root) for security
4. **Separate data:** Keep writable data in dedicated `./data/` directory, not mixed with source code
5. **Secrets:** Never store secrets in mounted config files - use environment variables instead

## Migration from ClawBoard

If migrating from ClawBoard, update your mount paths:

| ClawBoard | ClawBoard | Change |
|--------------|-----------|--------|
| `/clawdbot/sessions` | `/openclaw/sessions` | Renamed for clarity |
| `/clawdbot/clawdbot.json` | `/openclaw/config/openclaw.json` | New structure |
| `/clawdbot/memory` | `/memory` | Optional, clearer path |
| `/workspace` | `/project-sources` | Optional, clearer name |

## See Also

- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Docker Volumes](https://docs.docker.com/storage/volumes/)
- [OpenClaw Documentation](https://github.com/anthropics/openclaw)

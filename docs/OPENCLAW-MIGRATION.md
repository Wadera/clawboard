# OpenClaw Migration Guide

**From:** `clawdbot` v2026.1.24-3  
**To:** `openclaw` v2026.2.x  
**Created:** 2026-02-03  
**Status:** PLANNING (not yet executed)

---

## Table of Contents

1. [Overview](#overview)
2. [Pre-Migration Checklist](#pre-migration-checklist)
3. [Breaking Changes](#breaking-changes)
4. [Migration Steps](#migration-steps)
5. [ClawBoard Compatibility](#clawboard-compatibility)
6. [Known Issues](#known-issues)
7. [Rollback Procedure](#rollback-procedure)
8. [Post-Migration Verification](#post-migration-verification)
9. [References](#references)

---

## Overview

### Package Rename
The project was rebranded from `clawdbot` to `openclaw` in v2026.1.29 (January 30, 2026).

| Aspect | Old (Current) | New |
|--------|---------------|-----|
| npm package | `clawdbot` | `openclaw` |
| CLI command | `clawdbot` | `openclaw` |
| State directory | `~/.clawdbot/` | `~/.openclaw/` |
| Config file | `clawdbot.json` | `openclaw.json` |
| Extensions scope | `@clawdbot/*` | `@openclaw/*` |
| Service name | `clawdbot-gateway` | `openclaw-gateway` |
| launchd label | `com.clawdbot.*` | `bot.molt.*` |

### Version Gap
- **Current:** 2026.1.24-3 (January 25, 2026)
- **Latest:** 2026.2.1 (February 2, 2026)
- **Gap:** ~8 days, 4 releases (1.24 → 1.29 → 1.30 → 2.1)

---

## Pre-Migration Checklist

### 1. Backup Everything

```bash
# Create timestamped backup
BACKUP_DIR=~/clawdbot-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p $BACKUP_DIR

# Backup state directory
cp -r ~/.clawdbot $BACKUP_DIR/

# Backup workspace
cp -r ~/clawd $BACKUP_DIR/

# Backup systemd service
cp ~/.config/systemd/user/clawdbot-gateway.service $BACKUP_DIR/

# Verify backup
ls -la $BACKUP_DIR/
```

### 2. Create VM Snapshot (CRITICAL)

```bash
# From ai user on control machine
sudo su - ai
cd /home/ai/workspace/projects/HomeLab-Automation/ansible
ansible-playbook -i inventory create_snapshot_ai.yml \
  --vault-password-file=/home/ai/.ansible/vault_pass \
  -e "snapshot_description='Before OpenClaw migration from clawdbot 2026.1.24-3'"
```

### 3. Document Current State

```bash
# Record current version
clawdbot --version > ~/migration-state.txt

# Record running processes
ps aux | grep clawdbot >> ~/migration-state.txt

# Record service status
systemctl --user status clawdbot-gateway >> ~/migration-state.txt

# Record config checksum
md5sum ~/.clawdbot/clawdbot.json >> ~/migration-state.txt

# Record session count
find ~/.clawdbot/agents/ -name "*.jsonl" | wc -l >> ~/migration-state.txt
```

### 4. Verify Gateway is Stopped

```bash
clawdbot gateway stop
systemctl --user stop clawdbot-gateway
ps aux | grep -E "(clawdbot|openclaw)" | grep -v grep
```

---

## Breaking Changes

### 1. Auth Mode "none" Removed (v2026.1.29)

**BREAKING:** `gateway.auth.mode: "none"` is no longer supported.

**Our Status:** ✅ We already use token auth  
**Action Required:** None (verify `gateway.auth.token` is set)

### 2. State Directory Path Change

**Change:** `~/.clawdbot/` → `~/.openclaw/`

**Auto-Migration:** The `openclaw doctor` command handles this automatically.

**Manual Verification:**
```bash
# Check if auto-migration preserves:
# - Config: clawdbot.json → openclaw.json
# - Credentials: credentials/
# - Agents: agents/main/
# - Sessions: agents/main/sessions/
# - Browser profiles: browser/
```

### 3. Session Log Paths (v2026.2.1)

**Change:** Internal paths updated from `.clawdbot` to `.openclaw` in skill session-logs.

**Impact:** Session replay tools may need path updates.

### 4. Service Names

**Change:** 
- systemd: `clawdbot-gateway.service` → `openclaw-gateway.service`
- launchd: `com.clawdbot.*` → `bot.molt.*`

**Auto-Migration:** `openclaw doctor` handles service migration.

---

## Migration Steps

### Phase 1: Preparation (5 minutes)

```bash
# 1. Stop the gateway
clawdbot gateway stop

# 2. Verify stopped
systemctl --user status clawdbot-gateway

# 3. Note the current port (should be 18789)
grep '"port"' ~/.clawdbot/clawdbot.json
```

### Phase 2: Package Installation (2 minutes)

```bash
# 1. Uninstall old package
npm uninstall -g clawdbot

# 2. Install new package
npm install -g openclaw@latest

# 3. Verify installation
openclaw --version
which openclaw
```

### Phase 3: State Migration (5 minutes)

```bash
# 1. Run doctor for automatic migration
openclaw doctor

# Doctor will:
# - Detect legacy ~/.clawdbot directory
# - Migrate config file (clawdbot.json → openclaw.json)
# - Migrate sessions and agent directories
# - Update service configuration
# - Check auth profile health

# 2. Review migration output carefully
# - Look for any warnings or errors
# - Note any manual steps required

# 3. If prompted, accept migrations (or use --yes for automation)
openclaw doctor --yes
```

### Phase 4: Service Migration (3 minutes)

```bash
# 1. Remove old systemd service
systemctl --user stop clawdbot-gateway
systemctl --user disable clawdbot-gateway
rm ~/.config/systemd/user/clawdbot-gateway.service
systemctl --user daemon-reload

# 2. Install new service
openclaw gateway install

# 3. Verify new service
systemctl --user status openclaw-gateway
```

### Phase 5: Start and Verify (5 minutes)

```bash
# 1. Start the gateway
openclaw gateway start

# 2. Check status
openclaw status
openclaw gateway status

# 3. Verify health
openclaw health --verbose

# 4. Check logs
openclaw logs --follow
```

---

## ClawBoard Compatibility

### API Endpoint Changes

**No changes expected.** The ClawBoard connects to the gateway via WebSocket at `ws://host.docker.internal:18789` (configured via `CLAWDBOT_GATEWAY_WS_URL`).

**Verification Steps:**
1. After migration, check dashboard connectivity
2. Verify WebSocket connection in browser DevTools
3. Test status widget updates
4. Test task management

### Environment Variables

Current docker-compose.prod.yml references:
```yaml
CLAWDBOT_SESSIONS_PATH: /clawdbot/sessions/sessions.json
CLAWDBOT_TRANSCRIPTS_DIR: /clawdbot/sessions
CLAWDBOT_CONFIG_PATH: /clawdbot/clawdbot.json
CLAWDBOT_GATEWAY_WS_URL: ws://host.docker.internal:18789
```

**Expected:** These should continue to work as the WebSocket protocol hasn't changed.

**If Issues:** May need to update paths in docker-compose files:
```yaml
# Potential future update (if needed):
OPENCLAW_SESSIONS_PATH: /openclaw/sessions/sessions.json
OPENCLAW_TRANSCRIPTS_DIR: /openclaw/sessions
OPENCLAW_CONFIG_PATH: /openclaw/openclaw.json
OPENCLAW_GATEWAY_WS_URL: ws://host.docker.internal:18789
```

### Volume Mounts

Current mounts in docker-compose.prod.yml:
```yaml
volumes:
  - /home/clawd/.clawdbot/agents/main/sessions:/clawdbot/sessions:ro
  - /home/clawd/.clawdbot/clawdbot.json:/clawdbot/clawdbot.json:ro
```

**After Migration:** Update to new paths:
```yaml
volumes:
  - /home/clawd/.openclaw/agents/main/sessions:/clawdbot/sessions:ro
  - /home/clawd/.openclaw/openclaw.json:/clawdbot/clawdbot.json:ro
```

---

## Known Issues

### Issue 1: Telegram sendMessage Failures (v2026.1.30+)

**GitHub Issue:** #6350

**Symptoms:**
- `message` tool returns "Network request for 'sendMessage' failed!"
- Receiving works, sending fails
- Direct curl works fine

**Cause:** Node.js 22+ undici/fetch IPv4/IPv6 family selection issue

**Status:** Fixed in v2026.2.1

**Workaround (if needed):**
```bash
# Use curl fallback in agent prompts
exec curl -s -X POST "https://api.telegram.org/bot<token>/sendMessage" \
  -d "chat_id=<id>" -d "text=<message>"
```

### Issue 2: Update Panic (macOS, mise/nvm)

**GitHub Issue:** #4122

**Symptoms:**
```
The application panicked (crashed).
Message: called `Option::unwrap()` on a `None` value
Location: path-dedot-3.1.1/src/unsafe_cwd.rs:38
```

**Cause:** Path handling issue with version-managed Node

**Workaround:**
- Use system Node instead of nvm/mise/asdf
- Or: Fresh install instead of `clawdbot update`

### Issue 3: Control UI Assets Missing (npm global)

**GitHub Issue:** #4909

**Status:** Fixed in v2026.1.30

**Symptoms:** Dashboard shows blank/broken UI after upgrade

**Fix:** Run `openclaw doctor` to rebuild UI assets

---

## Rollback Procedure

### Quick Rollback (< 5 minutes)

```bash
# 1. Stop the new gateway
openclaw gateway stop 2>/dev/null || true
systemctl --user stop openclaw-gateway 2>/dev/null || true

# 2. Uninstall new package
npm uninstall -g openclaw

# 3. Install old package version
npm install -g clawdbot@2026.1.24-3

# 4. Restore backup if state was corrupted
BACKUP_DIR=~/clawdbot-backup-YYYYMMDD-HHMMSS  # Use actual backup dir
cp -r $BACKUP_DIR/.clawdbot ~/

# 5. Restore service
cp $BACKUP_DIR/clawdbot-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload

# 6. Start old gateway
systemctl --user start clawdbot-gateway

# 7. Verify
clawdbot --version
clawdbot status
```

### VM Snapshot Rollback (Nuclear Option)

If all else fails, restore from Proxmox snapshot:
1. Access Proxmox UI at https://
2. Navigate to VM 4114 (AI VM)
3. Find snapshot "Before OpenClaw migration..."
4. Click "Rollback"
5. Start VM

---

## Post-Migration Verification

### 1. Gateway Health

```bash
# Check version
openclaw --version

# Check status
openclaw status
openclaw gateway status

# Check health
openclaw health --verbose

# Check logs (no errors)
openclaw logs --follow
```

### 2. Channel Connectivity

```bash
# Discord should reconnect automatically
# Check in logs for:
# - "discord connected"
# - No auth errors
```

### 3. Session Persistence

```bash
# Verify sessions migrated
find ~/.openclaw/agents/ -name "*.jsonl" | wc -l

# Compare with pre-migration count
cat ~/migration-state.txt
```

### 4. ClawBoard

```bash
# Check dashboard connectivity
curl -s "https://your-domain.example.com/api/status" \
  -H "Authorization: Bearer <token>" | jq .

# Verify in browser:
# - https://your-domain.example.com/dashboard/ loads
# - Status widget shows current state
# - WebSocket indicator is green
```

### 5. Model Auth

```bash
# Check model availability
openclaw models status

# Test a simple prompt
openclaw agent --message "Hello, test after migration" --timeout 30
```

### 6. Cron Jobs

```bash
# List cron jobs
openclaw cron list

# Verify heartbeat still runs
# Wait for next heartbeat cycle
```

---

## References

### Official Documentation
- Updating Guide: https://docs.openclaw.ai/install/updating
- Doctor: https://docs.openclaw.ai/gateway/doctor
- FAQ: https://docs.openclaw.ai/help/faq
- Migration (machine): https://docs.openclaw.ai/install/migrating

### GitHub
- Repository: https://github.com/openclaw/openclaw
- Releases: https://github.com/openclaw/openclaw/releases
- Issues: https://github.com/openclaw/openclaw/issues

### Changelog Highlights (1.24 → 2.1)
- v2026.1.29: Package rename (clawdbot → openclaw)
- v2026.1.29: Auth mode "none" removed
- v2026.1.30: Shell completions, MiniMax OAuth
- v2026.2.1: 20+ security fixes, memory search fix

### Our Configuration
- State dir: `~/.clawdbot/`
- Workspace: `~/clawd/`
- Gateway port: 18789
- Service: systemd user (`clawdbot-gateway.service`)
- Channels: Discord
- Auth: Anthropic (setup-token), Google (OAuth), LiteLLM

---

## Execution Log

*(To be filled during actual migration)*

| Step | Time | Status | Notes |
|------|------|--------|-------|
| VM Snapshot | | | |
| Backup created | | | |
| Gateway stopped | | | |
| Old package removed | | | |
| New package installed | | | |
| Doctor migration | | | |
| Service updated | | | |
| Gateway started | | | |
| Health verified | | | |
| Dashboard tested | | | |
| Migration complete | | | |

---

*Last updated: 2026-02-09 by ClawBoard Contributors*

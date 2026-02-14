# ClawBoard V2.0.0 Test Plan

**Objective:** Verify ClawBoard works standalone (0 plugins) and with plugins enabled.

---

## Pre-Test Checklist

- [ ] Clean Docker environment (no existing ClawBoard containers)
- [ ] Fresh checkout of ClawBoard repo
- [ ] No local modifications
- [ ] `.env` file created from `.env.example`
- [ ] Ports 8082, 5432, 3003 available

---

## Test 1: Fresh Install (0 Plugins)

### Setup

```bash
git clone https://github.com/Wadera/clawboard.git clawboard-test
cd clawboard-test
cp .env.example .env
# Edit .env with your credentials
```

### Verify Config

```bash
# clawboard.plugins.json should have empty array
cat clawboard.plugins.json
# Expected: {"plugins": []}
```

### Start Services

```bash
docker compose up -d
docker compose logs -f
```

### Verify Startup

**Expected logs:**
```
🔌 Plugin Loader: Initializing...
🔌 Plugin config not found at .../clawboard.plugins.json — no plugins loaded
✅ Backend started on port 3003
✅ Database connected
✅ WebSocket server running
```

**Should NOT see:**
- Plugin loading messages
- Plugin health check errors
- Missing plugin errors

### Test Core Features

| Feature | Endpoint/URL | Expected Result |
|---------|--------------|-----------------|
| **Dashboard** | http://localhost:8082/ | Loads, shows login |
| **Login** | POST /api/auth/login | Success with valid creds |
| **Dashboard** | http://localhost:8082/dashboard | Shows core widgets (no plugin items) |
| **Tasks** | http://localhost:8082/tasks | Kanban board loads, no errors |
| **Projects** | http://localhost:8082/projects | Project list loads |
| **Tools** | http://localhost:8082/tools | Tool list loads from DB |
| **Journal** | http://localhost:8082/journal | Journal page loads (core feature) |
| **Audit** | http://localhost:8082/audit | Audit log loads |
| **Stats** | http://localhost:8082/stats | Stats page loads |
| **API: Tasks** | GET /api/tasks | Returns task list |
| **API: Plugins** | GET /api/plugins | Returns `{"plugins": []}` |
| **WebSocket** | ws://localhost:3003 | Connects successfully |

### Test Plugin System (with 0 plugins)

```bash
# Fetch plugin registry
curl http://localhost:8082/api/plugins

# Expected response:
{
  "plugins": []
}

# Sidebar should NOT have plugin items
# - Open browser dev tools → Network → fetch /api/plugins
# - Verify empty array
# - Verify sidebar has only core items (Dashboard, Tasks, Projects, Journal, Tools, Audit, Stats)
```

### Test Mobile

- [ ] Responsive layout works
- [ ] Sidebar collapses
- [ ] Tasks mobile tabs work
- [ ] Swipe from edge works
- [ ] No console errors

### Cleanup

```bash
docker compose down -v
```

---

## Test 2: With Example Plugin

### Setup

Create a minimal test plugin:

```bash
mkdir -p plugins/test-plugin
cat > plugins/test-plugin/plugin.json << 'EOF'
{
  "name": "test-plugin",
  "version": "1.0.0",
  "description": "Minimal test plugin",
  "docker": {
    "image": "nginx:alpine",
    "ports": { "80": "8090" }
  },
  "api": {
    "base_path": "/api/plugins/test",
    "internal_port": 80,
    "health": "/"
  },
  "ui": {
    "enabled": true,
    "sidebar": [
      {
        "label": "Test Plugin",
        "icon": "zap",
        "path": "/test"
      }
    ]
  }
}
EOF
```

### Enable Plugin

Edit `clawboard.plugins.json`:

```json
{
  "plugins": [
    {
      "name": "test-plugin",
      "source": "./plugins/test-plugin",
      "enabled": true
    }
  ]
}
```

### Start Services

```bash
# Start just the test plugin container
docker run -d --name test-plugin --network clawboard_default -p 8090:80 nginx:alpine

# Restart ClawBoard backend to reload plugins
docker restart clawboard-backend

# Check logs
docker logs clawboard-backend | grep "Plugin"
```

### Verify Plugin Loading

**Expected logs:**
```
🔌 Plugin Loader: Initializing...
🔌 Plugin Loader: Found 1 plugins (1 enabled)
  ✅ Loaded plugin: test-plugin v1.0.0
🔌 Plugin Loader: 1 plugins registered
```

### Test Plugin Integration

| Feature | Endpoint/URL | Expected Result |
|---------|--------------|-----------------|
| **Plugin API** | GET /api/plugins | Returns array with 1 plugin |
| **Health Check** | - | Plugin shows `healthy: true` |
| **Sidebar** | Frontend | "Test Plugin" item appears |
| **Proxy** | GET /api/plugins/test/ | Proxies to nginx (returns HTML) |

### Verify Frontend

```bash
# Fetch plugin registry
curl http://localhost:8082/api/plugins

# Expected response:
{
  "plugins": [
    {
      "name": "test-plugin",
      "version": "1.0.0",
      "description": "Minimal test plugin",
      "healthy": true,
      "sidebar": [
        {
          "label": "Test Plugin",
          "icon": "zap",
          "path": "/test"
        }
      ],
      "api_base": "/api/plugins/test",
      "internal_port": 80
    }
  ]
}
```

**Browser check:**
- Open http://localhost:8082/dashboard
- Verify "Test Plugin" appears in sidebar
- Click it → should navigate to `/test` (404 is fine, proxy is working)
- Check Network tab → request to `/plugins/test` proxied to nginx

### Test Health Checks

```bash
# Wait 60 seconds (default health check interval)
sleep 60

# Check plugin status
curl http://localhost:8082/api/plugins | jq '.plugins[0].healthy'
# Expected: true
```

### Cleanup

```bash
docker stop test-plugin
docker rm test-plugin
docker compose down -v
rm -rf plugins/test-plugin
git checkout clawboard.plugins.json
```

---

## Test 3: Plugin Failures (Error Handling)

### Test: Invalid Manifest

```bash
# Create plugin with invalid manifest
mkdir -p plugins/bad-plugin
echo '{"invalid json' > plugins/bad-plugin/plugin.json

# Edit clawboard.plugins.json to enable it
# Restart backend

# Expected:
# - Backend starts successfully
# - Logs show error loading bad-plugin
# - /api/plugins excludes bad-plugin
# - Dashboard still works
```

### Test: Missing Health Endpoint

```bash
# Create plugin that doesn't respond to health checks
# Plugin should be marked as unhealthy
# Proxy routes should still be registered
# Dashboard should show plugin as unhealthy
```

### Test: Port Conflict

```bash
# Create two plugins with same host port
# Expected:
# - Second plugin fails to load
# - Error logged
# - First plugin works fine
```

---

## Test 4: Plugin Proxy

### Setup

Use the test-plugin from Test 2.

### Test Proxying

```bash
# API route
curl http://localhost:8082/api/plugins/test/
# Should proxy to nginx container

# Check headers
curl -I http://localhost:8082/api/plugins/test/
# Should include X-Plugin-Name: test-plugin

# POST request
curl -X POST http://localhost:8082/api/plugins/test/ -d '{"test": true}' -H "Content-Type: application/json"
# Should proxy POST to nginx
```

### Test Error Handling

```bash
# Stop plugin container
docker stop test-plugin

# Try to access plugin
curl http://localhost:8082/api/plugins/test/
# Expected:
# - 502 Bad Gateway
# - Error response: {"error": "Plugin unavailable", "plugin": "test-plugin"}
```

---

## Test 5: Config Override

### Setup

Create plugin with configurable behavior:

```bash
# Use test-plugin
# Add config section to plugin.json
# Add config_override in clawboard.plugins.json
```

### Verify Override

```bash
# Check plugin config via API
curl http://localhost:8082/api/plugins/test-plugin

# Verify config_override was applied
# (Depends on plugin exposing config endpoint)
```

---

## Test 6: Blocked Task Sorting (Merged Feature)

### Setup

```bash
# Start ClawBoard
docker compose up -d

# Create tasks via API
curl -X POST http://localhost:8082/api/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title": "Task A", "status": "todo", "priority": "high"}'

curl -X POST http://localhost:8082/api/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title": "Task B", "status": "todo", "priority": "high", "blockedBy": ["task-a-id"]}'
```

### Verify Sorting

- [ ] Open http://localhost:8082/tasks
- [ ] Verify Task A appears above Task B in "To Do" column
- [ ] Both have "high" priority but blocked task is below unblocked
- [ ] Check browser console for errors (should be none)

---

## Test 7: Version Verification

### Check Version Numbers

```bash
# Backend package.json
cat backend/package.json | grep version
# Expected: "version": "2.0.0"

# Frontend package.json
cat frontend/package.json | grep version
# Expected: "version": "2.0.0"

# Git tag
git tag --list | grep v2
# Expected: v2.0.0
```

---

## Success Criteria

### Core (0 Plugins)

- [x] Dashboard loads without plugins
- [x] All core pages work (tasks, projects, journal, tools, audit, stats)
- [x] No plugin errors in logs
- [x] `/api/plugins` returns empty array
- [x] Sidebar shows only core items
- [x] Mobile layout works
- [x] WebSocket connects
- [x] Can create/edit/delete tasks
- [x] Can create/edit/delete projects

### Plugin System

- [x] Plugin loading from `clawboard.plugins.json`
- [x] Manifest validation
- [x] Health checks run automatically
- [x] `/api/plugins` returns plugin registry
- [x] Sidebar dynamically includes plugin items
- [x] Proxy routes work for plugin APIs
- [x] Proxy routes work for plugin UIs
- [x] Error handling (invalid manifest, missing health, port conflicts)
- [x] Plugin marked unhealthy when unreachable
- [x] Config overrides applied

### Merged Feature

- [x] Blocked tasks sort below unblocked in kanban

---

## Known Issues / Edge Cases

Document any issues found during testing:

- [ ] Issue 1: ...
- [ ] Issue 2: ...

---

## Test Environment

- **OS:** Ubuntu 22.04 / macOS / Windows + WSL2
- **Docker:** v24.0+
- **Docker Compose:** v2.0+
- **Browser:** Chrome 120+, Firefox 120+, Safari 17+

---

## Checklist for Release

- [ ] All tests pass
- [ ] No critical bugs
- [ ] Version bumped to 2.0.0
- [ ] CHANGELOG updated
- [ ] README updated
- [ ] Wiki updated
- [ ] Git tag created
- [ ] Release notes written

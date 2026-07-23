# ClawBoard Plugin Development Guide

## Overview

ClawBoard supports a plugin system where each plugin runs as its own Docker container. Plugins can expose API endpoints, add sidebar navigation items, and serve their own UI — all integrated seamlessly into the ClawBoard dashboard.

## Quick Start

### 1. Create Your Plugin Repository

```bash
mkdir claw-myplugin
cd claw-myplugin
npm init -y  # or use any language/framework you prefer
```

### 2. Create `plugin.json`

Every plugin needs a `plugin.json` manifest at its root:

```json
{
  "name": "claw-myplugin",
  "version": "1.0.0",
  "description": "My awesome ClawBoard plugin",

  "docker": {
    "image": "claw-myplugin",
    "build": ".",
    "ports": {
      "3020": "3020"
    },
    "environment": {
      "NODE_ENV": "production",
      "PORT": "3020"
    },
    "networks": ["clawboard"]
  },

  "api": {
    "base_path": "/api/plugins/myplugin",
    "internal_port": 3020,
    "health": "/health",
    "endpoints": [
      {
        "method": "GET",
        "path": "/data",
        "description": "Get plugin data"
      }
    ]
  },

  "ui": {
    "enabled": true,
    "sidebar": [
      {
        "label": "My Plugin",
        "icon": "box",
        "path": "/myplugin"
      }
    ],
    "routes": [
      {
        "path": "/myplugin",
        "proxy_to": "/ui/"
      }
    ],
    "embedding": "proxy"
  },

  "author": "Your Name",
  "license": "MIT",
  "clawboard": {
    "min_version": "2.0.0",
    "category": "productivity"
  }
}
```

### 3. Implement Health Endpoint

**Required:** Every plugin must expose a health endpoint.

```javascript
// Express example
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});
```

```python
# Flask example
@app.route('/health')
def health():
    return jsonify(status='ok', version='1.0.0')
```

### 4. Create Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3020
CMD ["node", "src/index.js"]
```

### 5. Register in `clawboard.plugins.json`

In your ClawBoard deployment repo:

```json
{
  "plugins": [
    {
      "name": "claw-myplugin",
      "source": "./plugins/claw-myplugin",
      "enabled": true,
      "config_override": {}
    }
  ]
}
```

### 6. Start

```bash
docker compose up --build
```

Your plugin's sidebar item will appear automatically in the ClawBoard dashboard!

---

## Manifest Schema Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique plugin identifier (kebab-case, e.g., `claw-journal`) |
| `version` | string | Semantic version (e.g., `1.0.0`) |
| `description` | string | Human-readable description |
| `docker.image` | string | Docker image name |
| `docker.ports` | object | Container-to-host port mapping |
| `api.base_path` | string | URL prefix for API proxy (e.g., `/api/plugins/journal`) |
| `api.internal_port` | number | Port the container listens on |
| `api.health` | string | Health check endpoint path (e.g., `/health`) |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `docker.build` | string | `"."` | Docker build context |
| `docker.volumes` | string[] | `[]` | Volume mounts |
| `docker.environment` | object | `{}` | Environment variables |
| `docker.networks` | string[] | `["clawboard"]` | Docker networks |
| `docker.runtime` | string | `null` | Container runtime (e.g., `"nvidia"`) |
| `docker.network_mode` | string | `null` | Network mode (e.g., `"host"`) |
| `ui.enabled` | boolean | `false` | Whether plugin has a UI |
| `ui.sidebar` | array | `[]` | Sidebar navigation items |
| `ui.routes` | array | `[]` | Frontend routes to proxy |
| `ui.embedding` | string | `"proxy"` | UI embedding method |
| `config.schema` | object | – | JSON Schema for plugin config |
| `config.defaults` | object | – | Default config values |
| `agent.tool_name` | string | – | Corresponding Tier 1 tool name |
| `agent.capabilities` | string[] | – | Agent capabilities |
| `clawboard.min_version` | string | – | Minimum ClawBoard version |
| `clawboard.category` | string | – | Plugin category |

### Sidebar Item Schema

```json
{
  "label": "Journal",          // Display label
  "icon": "book",              // Lucide icon name
  "path": "/journal",          // Frontend route path
  "badge": null                // Optional: API path for badge count
}
```

---

## Plugin Types

### API-Only Plugin

No UI, just backend endpoints. Good for data services, integrations, GPU workers.

```json
{
  "ui": { "enabled": false }
}
```

### API + UI Plugin

Full-stack plugin with its own frontend and backend.

```json
{
  "ui": {
    "enabled": true,
    "sidebar": [{ "label": "My Plugin", "icon": "box", "path": "/myplugin" }],
    "routes": [{ "path": "/myplugin", "proxy_to": "/ui/" }]
  }
}
```

---

## UI Integration

### How Proxying Works

ClawBoard's backend proxies requests to your plugin container:

```
Browser: GET /plugins/myplugin/page
  → ClawBoard backend proxy
  → http://claw-myplugin:3020/ui/page
```

### Shared Theme

Import the ClawBoard theme CSS for consistent styling:

```html
<link rel="stylesheet" href="/api/plugins/theme.css">
```

This provides CSS variables:
```css
:root {
  --cb-bg-primary: #0a0a0a;
  --cb-bg-secondary: #1a1a2e;
  --cb-text-primary: #e0e0e0;
  --cb-accent: #7c3aed;
  --cb-border: #2a2a3e;
  --cb-font-family: 'Inter', sans-serif;
}
```

### UI Requirements

- Serve frontend at container root (`/`) or `/ui/`
- Use **relative paths** for all assets
- Accept `BASE_PATH` environment variable for URL generation
- Authentication is handled by ClawBoard — your plugin receives pre-authenticated requests

---

## Communication

### Plugin → Core API

Access ClawBoard's core API via the internal Docker network:

```javascript
const CORE_URL = process.env.CLAWBOARD_CORE_URL || 'http://clawboard-backend:3003';
const API_KEY = process.env.CLAWBOARD_API_KEY;

const response = await fetch(`${CORE_URL}/tasks`, {
  headers: { 'Authorization': `Bearer ${API_KEY}` }
});
```

### Plugin → Plugin

**Don't.** Plugins should communicate through the core API, not directly. This keeps plugins decoupled.

---

## Configuration

### Plugin Config Schema

Define configurable options in your manifest:

```json
{
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "refresh_interval": {
          "type": "integer",
          "description": "Data refresh interval in seconds"
        }
      }
    },
    "defaults": {
      "refresh_interval": 300
    }
  }
}
```

### Deployment Overrides

Operators can override config in `clawboard.plugins.json`:

```json
{
  "name": "claw-myplugin",
  "source": "./plugins/claw-myplugin",
  "enabled": true,
  "config_override": {
    "config": {
      "refresh_interval": 60
    }
  }
}
```

### Priority Order

```
plugin.json defaults → clawboard.plugins.json overrides → environment variables
```

---

## Naming Conventions

| Type | Pattern | Example |
|------|---------|---------|
| Reusable plugin | `claw-{function}` | `claw-journal`, `claw-monitor` |
| Bot-specific plugin | `{bot}-{function}` | `nim-orb`, `nim-avatar` |
| API base path | `/api/plugins/{short-name}` | `/api/plugins/journal` |
| UI route | `/plugins/{short-name}` | `/plugins/journal` |
| Config dir | `config/{short-name}/` | `config/journal/` |

---

## Checklist

Before releasing your plugin:

- [ ] `plugin.json` at repo root with all required fields
- [ ] Dockerfile builds successfully
- [ ] `/health` endpoint returns `{"status": "ok", "version": "x.x.x"}`
- [ ] README.md with setup instructions
- [ ] If UI: serves frontend, uses relative asset paths
- [ ] If configurable: `config.schema` documents all options
- [ ] Tested with a clean ClawBoard installation

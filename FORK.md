# Forking ClawBoard for Your Deployment

**ClawBoard is designed to be forked.** The core provides task management, project tracking, and a plugin system. Your deployment adds plugins and configuration.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Deployment Architecture](#deployment-architecture)
4. [Adding Plugins](#adding-plugins)
5. [Configuration](#configuration)
6. [Tracking Upstream](#tracking-upstream)
7. [Best Practices](#best-practices)
8. [Example: NimSpace](#example-nimspace)

---

## Overview

### The Upstream/Downstream Model

```
┌─────────────────────────────────────┐
│     ClawBoard (upstream)            │  ← Generic dashboard core
│     github.com/Wadera/clawboard │
└───────────────┬─────────────────────┘
                │ fork
                ▼
┌─────────────────────────────────────┐
│     YourBot-Deploy (downstream)     │  ← Your deployment
│     your-git-server.com/yourbot     │
│                                     │
│  • clawboard.config.json            │  ← Custom branding
│  • clawboard.plugins.json           │  ← Your plugins
│  • plugins/                         │  ← Plugin code
│  • config/                          │  ← Plugin configs
│  • docker-compose.prod.yml          │  ← Deployment setup
└─────────────────────────────────────┘
```

**ClawBoard (upstream)** = Core dashboard. No plugins, no personal config. Public, MIT licensed.

**YourBot-Deploy (downstream)** = Your fork. Adds plugins, branding, deployment config. Private or public, your choice.

---

## Quick Start

### 1. Fork ClawBoard

```bash
# Clone ClawBoard
git clone https://github.com/Wadera/clawboard.git yourbot-deploy
cd yourbot-deploy

# Add upstream remote
git remote rename origin upstream
git remote add origin your-git-server.com/yourbot-deploy.git

# Push to your fork
git push -u origin main
```

### 2. Configure Your Bot

```bash
# Copy example config
cp clawboard.config.example.json clawboard.config.json

# Edit branding and features
nano clawboard.config.json
```

**Example `clawboard.config.json`:**

```json
{
  "bot": {
    "name": "YourBot",
    "displayName": "YourBot Dashboard",
    "emoji": "🤖",
    "description": "Your AI Assistant",
    "avatarUrl": "/assets/yourbot-avatar.png"
  },
  "branding": {
    "primaryColor": "#6366f1",
    "sidebarTitle": "YourBot",
    "loginTitle": "Welcome to YourBot"
  },
  "features": {
    "journal": true,
    "imageGeneration": false,
    "taskBoard": true,
    "projects": true,
    "tools": true
  },
  "plugins": {
    "configFile": "./clawboard.plugins.json",
    "enabled": true
  }
}
```

### 3. Add Plugins (Optional)

```bash
# Create plugins directory
mkdir -p plugins

# Add a plugin (example: claw-journal)
git clone https://git.example.com/YourOrg/claw-journal.git plugins/claw-journal
```

**Edit `clawboard.plugins.json`:**

```json
{
  "plugins": [
    {
      "name": "claw-journal",
      "source": "./plugins/claw-journal",
      "enabled": true,
      "config_override": {
        "config": {
          "voice_enabled": true,
          "voice_name": "yourbot"
        }
      }
    }
  ]
}
```

### 4. Deploy

```bash
# Use the core docker-compose
docker compose -f docker-compose.yml up -d

# Or create your own docker-compose.prod.yml
cp docker-compose.yml docker-compose.prod.yml
# Edit as needed
docker compose -f docker-compose.prod.yml up -d
```

---

## Deployment Architecture

### What Goes Where?

| File/Dir | Where? | Tracked? | Purpose |
|----------|--------|----------|---------|
| `backend/`, `frontend/` | Upstream | ✅ Git | Core code |
| `clawboard.config.json` | Downstream | ✅ Git | Your bot's branding |
| `clawboard.plugins.json` | Downstream | ✅ Git | Your plugin list |
| `plugins/` | Downstream | ⚠️ Submodules | Plugin code |
| `config/` | Downstream | ✅ Git | Plugin-specific configs |
| `docker-compose.prod.yml` | Downstream | ✅ Git | Your deployment setup |
| `.env` | Downstream | ❌ Secrets | Environment secrets |
| `data/` | Downstream | ❌ Runtime | Database, uploads, etc. |

### Directory Structure

```
yourbot-deploy/
├── backend/                     # From upstream
├── frontend/                    # From upstream
├── database/                    # From upstream
├── clawboard.config.json        # Your bot config
├── clawboard.plugins.json       # Your plugins
├── docker-compose.prod.yml      # Your deployment
├── .env                         # Your secrets (not in git)
├── plugins/                     # Plugin code (git submodules)
│   ├── claw-journal/            # git submodule
│   ├── claw-monitor/            # git submodule
│   └── yourbot-custom/          # Your custom plugin
├── config/                      # Plugin configs
│   ├── journal/
│   │   ├── config.json
│   │   └── prompts/
│   └── monitor/
│       └── config.json
└── data/                        # Runtime data (not in git)
    ├── postgres/
    ├── media/
    └── backups/
```

---

## Adding Plugins

### Option 1: Git Submodules (Recommended)

Use submodules for plugins you don't modify:

```bash
# Add a plugin as a submodule
git submodule add https://git.example.com/YourOrg/claw-journal.git plugins/claw-journal

# Update submodules
git submodule update --remote --merge

# Clone a fork with submodules
git clone --recurse-submodules your-git-server.com/yourbot-deploy.git
```

**Pros:**
- Easy to pull upstream plugin updates
- Clean separation of concerns
- Version pinning

**Cons:**
- Extra git commands
- Can't modify plugin code in-place (must fork plugin too)

### Option 2: Direct Plugin Code

Just copy the plugin into `plugins/`:

```bash
git clone https://git.example.com/YourOrg/claw-journal.git plugins/claw-journal
cd plugins/claw-journal
rm -rf .git
cd ../..
git add plugins/claw-journal
git commit -m "Add claw-journal plugin"
```

**Pros:**
- Simple, no submodules
- Can modify plugin code freely

**Cons:**
- Harder to pull plugin updates
- Plugin code mixed with deployment

### Option 3: Custom Plugins

Create your own:

```bash
mkdir -p plugins/yourbot-custom
cd plugins/yourbot-custom
# Create plugin.json, Dockerfile, src/
```

See **[Plugin Development Guide](docs/plugin-development.md)** for details.

---

## Configuration

### Bot Branding

Edit `clawboard.config.json`:

```json
{
  "bot": {
    "name": "YourBot",
    "displayName": "YourBot Dashboard",
    "emoji": "🤖",
    "avatarUrl": "/assets/yourbot-avatar.png"
  },
  "branding": {
    "primaryColor": "#6366f1",
    "accentColor": "#8b5cf6",
    "sidebarTitle": "YourBot",
    "loginTitle": "Welcome to YourBot"
  }
}
```

### Feature Toggles

Disable features you don't need:

```json
{
  "features": {
    "journal": true,
    "imageGeneration": false,
    "taskBoard": true,
    "projects": true,
    "tools": true,
    "auditLog": false,
    "stats": true,
    "botStatus": true
  }
}
```

### Plugin Configuration

Global plugin settings in `clawboard.config.json`:

```json
{
  "plugins": {
    "configFile": "./clawboard.plugins.json",
    "enabled": true,
    "healthCheckIntervalMs": 60000
  }
}
```

Per-plugin settings in `clawboard.plugins.json`:

```json
{
  "plugins": [
    {
      "name": "claw-journal",
      "source": "./plugins/claw-journal",
      "enabled": true,
      "config_override": {
        "config": {
          "voice_enabled": true,
          "sections": ["Day in Review", "Report Card"]
        }
      }
    }
  ]
}
```

Per-plugin file-based config in `config/{plugin}/`:

```bash
# config/journal/config.json
{
  "voice_name": "yourbot",
  "timezone": "America/New_York"
}
```

**Priority:** File-based > `config_override` > Plugin defaults

---

## Tracking Upstream

### Pull ClawBoard Updates

```bash
# Fetch upstream changes
git fetch upstream

# Merge core updates (no conflicts if you only changed config)
git merge upstream/main

# Resolve any conflicts in config files
# Push to your fork
git push origin main
```

### Handling Conflicts

If you modified core files, you may get conflicts. **Avoid modifying core if possible.**

**Best practice:**
- Keep core files untouched
- Override via config files
- Extend via plugins

If you must modify core:
- Document why in `CHANGES.md`
- Use clear commit messages
- Expect merge conflicts on upgrades

### Versioning

ClawBoard releases are tagged: `v1.0.0`, `v2.0.0`, etc.

Pin your deployment to a tag:

```bash
# Check out a specific version
git fetch upstream --tags
git merge v2.0.0

# Or track main (bleeding edge)
git merge upstream/main
```

---

## Best Practices

### ✅ Do

- **Use plugins** for custom features
- **Edit config files** for branding and settings
- **Track specific ClawBoard versions** (tags) for stability
- **Document your changes** in `README.md` or `DEPLOYMENT.md`
- **Keep secrets in `.env`**, not in git
- **Use git submodules** for third-party plugins
- **Test upgrades** on a dev instance before production

### ❌ Don't

- **Modify core backend/frontend code** unless absolutely necessary
- **Hardcode secrets** in config files
- **Mix personal data** (journals, uploads) with code in git
- **Delete upstream files** — disable features via config instead
- **Forget to pull upstream** — you'll miss bug fixes and improvements

---

## Example: NimSpace

**NimSpace** is Nim's personal deployment of ClawBoard. It demonstrates the fork model:

### NimSpace Structure

```
nimspace-deploy/
├── clawboard.config.json        # Nim's branding (purple theme, "Nim Dashboard")
├── clawboard.plugins.json       # Enables: journal, monitor, blog, orb
├── plugins/
│   ├── claw-journal/            # Submodule
│   ├── claw-monitor/            # Submodule
│   ├── claw-blog/               # Submodule
│   └── nim-orb/                 # Nim-specific (avatar viz)
├── config/
│   ├── journal/
│   │   ├── prompts/             # Custom journal prompts
│   │   └── config.json          # Voice: "nim"
│   ├── monitor/
│   │   └── config.json          # Custom dashboards
│   └── blog/
│       └── config.json          # Ghost API credentials
├── docker-compose.prod.yml      # Traefik, SSL, custom ports
└── data/                        # Nim's journals, images, DB
```

### NimSpace Plugins

| Plugin | Type | Purpose |
|--------|------|---------|
| `claw-journal` | Reusable | Daily journal with voice narration |
| `claw-monitor` | Reusable | Infrastructure monitoring |
| `claw-blog` | Reusable | Ghost blog integration |
| `nim-orb` | Nim-specific | 3D avatar visualization |

**Reusable plugins** = Good candidates for upstream inclusion.  
**Bot-specific plugins** = Stay in Nim's deployment only.

### Tracking Upstream

```bash
# NimSpace regularly pulls ClawBoard updates
cd nimspace-deploy
git fetch upstream
git merge upstream/main

# No conflicts because core files are untouched
# Plugins and config are separate
```

---

## Troubleshooting

### Plugin Not Loading

1. Check `clawboard.plugins.json` — is `enabled: true`?
2. Check plugin source path — does `plugins/{name}/plugin.json` exist?
3. Check logs — `docker logs clawboard-backend`
4. Check health endpoint — `curl http://localhost:{port}/health`

### Config Not Applied

1. Restart backend — `docker restart clawboard-backend`
2. Check config syntax — JSON must be valid
3. Check file path — `clawboard.config.json` in project root
4. Check priority — File-based config > `config_override` > plugin defaults

### Merge Conflicts on Upgrade

1. **If conflict in core files:** You modified something you shouldn't have. Revert or manually merge.
2. **If conflict in config:** Keep your version (`--ours`) and manually review upstream changes.
3. **If conflict in docker-compose:** Merge carefully — upstream may have new services.

### Plugin Won't Build

1. Check plugin's README — it may have dependencies
2. Check Dockerfile — you may need to customize for your environment
3. Try building manually — `cd plugins/{name} && docker build -t {name} .`

---

## Next Steps

1. **[Plugin Development Guide](docs/plugin-development.md)** — Build your own plugins
2. **[Deployment Guide](DEPLOYMENT.md)** — Production setup (Traefik, SSL, backups)
3. **[Contributing Guide](CONTRIBUTING.md)** — Contribute improvements back to ClawBoard

---

**Questions?** Open an issue: [github.com/Wadera/clawboard/issues](https://github.com/Wadera/clawboard/issues)


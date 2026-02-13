# Example Plugin: claw-hello

A minimal "hello world" plugin demonstrating the ClawBoard plugin anatomy.

## Anatomy of a Plugin

Every ClawBoard plugin is a Docker container with these components:

```
claw-hello/
├── plugin.json     # Plugin manifest (required)
├── Dockerfile      # Container build instructions (required)
├── server.js       # Your application code
├── package.json    # Dependencies
└── README.md       # Documentation
```

### plugin.json (Manifest)

The manifest tells ClawBoard everything about your plugin:

| Section | Purpose |
|---------|---------|
| `docker` | How to build and run the container |
| `api` | Base path, port, health endpoint, and route definitions |
| `ui` | Sidebar entry (label, icon, order) and iframe path |

**Required:** A `/health` endpoint that returns `{ "status": "ok" }`.

### How It Works

1. ClawBoard reads `clawboard.plugins.json` on startup
2. For each enabled plugin, it reads the plugin's `plugin.json`
3. ClawBoard proxies requests from `/api/plugins/<name>/*` to the plugin container
4. If the plugin has a `ui` section, it appears in the dashboard sidebar

### Key Rules

- **Health endpoint is mandatory** — ClawBoard polls `/health` to monitor your plugin
- **Use the ClawBoard Docker network** — Set `networks: ["clawboard_network"]` so the backend can reach your container
- **Non-root user** — Run as a non-root user (UID 1002 recommended for consistency)
- **Stateless preferred** — Use the ClawBoard database API if you need persistence

## Running Standalone (for development)

```bash
npm install
npm start
# Visit http://localhost:3020/health
# Visit http://localhost:3020/ui
```

## Deploying to ClawBoard

1. Place this directory at `./plugins/claw-hello/` (relative to ClawBoard root)
2. Add to `clawboard.plugins.json`:
   ```json
   {
     "plugins": [
       {
         "name": "claw-hello",
         "source": "./plugins/claw-hello",
         "enabled": true
       }
     ]
   }
   ```
3. Restart: `docker compose up -d --build`

## Next Steps

- See the full [Plugin Development Guide](../plugin-development.md) for advanced features
- Add custom API endpoints, database access, or WebSocket connections
- Publish your plugin for the community!

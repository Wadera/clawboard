# Contributing to ClawBoard

## Upstream / Downstream Workflow

ClawBoard is designed to be forked for custom deployments. The recommended workflow keeps your private customizations separate from the core while still pulling upstream updates.

### Architecture

```
┌──────────────────────────────────────────────────┐
│              ClawBoard (upstream)                 │
│  git.example.com/ClawBoard/ClawBoard.git         │
│  • Core dashboard features                       │
│  • Plugin system                                 │
│  • Generic, no deployment-specific code          │
│  • Tags: v1.0.0, v2.0.0, etc.                  │
└──────────────────────┬───────────────────────────┘
                       │ fork
                       ▼
┌──────────────────────────────────────────────────┐
│          Your Deployment (downstream)            │
│  git.example.com/YourOrg/my-dashboard.git        │
│  • Custom branding (clawboard.config.json)       │
│  • Plugin configuration (clawboard.plugins.json) │
│  • Deployment-specific docker-compose            │
│  • Plugin source repos as submodules/clones      │
└──────────────────────────────────────────────────┘
```

### Setting Up Your Fork

```bash
# 1. Clone ClawBoard as your starting point
git clone <clawboard-repo-url> my-dashboard
cd my-dashboard

# 2. Add ClawBoard as upstream remote
git remote rename origin upstream
git remote add origin <your-private-repo-url>

# 3. Push to your private repo
git push -u origin main

# 4. Customize for your deployment
cp clawboard.config.example.json clawboard.config.json
# Edit clawboard.config.json with your branding, features, etc.
```

### Pulling Upstream Updates

When ClawBoard releases a new version:

```bash
# 1. Fetch upstream changes
git fetch upstream

# 2. Check what changed
git log --oneline upstream/main..main

# 3. Merge upstream (or rebase)
git merge upstream/main

# 4. Resolve any conflicts (usually in config files)
# Your custom clawboard.config.json may conflict — keep your version

# 5. Test your deployment
docker compose up --build

# 6. Push updated fork
git push origin main
```

### What to Customize (Safe to Change)

These files are yours to modify — upstream won't touch them:

| File | Purpose |
|------|---------|
| `clawboard.config.json` | Bot name, branding, features, deployment |
| `clawboard.plugins.json` | Which plugins to enable |
| `docker-compose.prod.yml` | Production deployment config |
| `.env` | Environment variables (secrets) |
| `config/` directory | Per-plugin configuration overrides |
| `plugins/` directory | Plugin source repos |

### What Not to Change (Upstream Files)

These files receive upstream updates — avoid modifying directly:

| File | Purpose |
|------|---------|
| `frontend/src/` | Core frontend code |
| `backend/src/` | Core backend code |
| `database/` | Database schema and migrations |
| `proxy/` | Proxy configuration templates |

If you need to extend core behavior, consider:
1. **Feature flags** in `clawboard.config.json`
2. **Plugins** for new functionality
3. **Config overrides** instead of code changes
4. **PR to upstream** if the change benefits everyone

### Contributing Back to ClawBoard

If you've built something useful:

1. Create a branch from the latest upstream/main
2. Make your changes (keeping them generic, no deployment-specific code)
3. Test with a clean `clawboard.config.json` (default values)
4. Submit a Pull Request to the upstream repo

### Plugin Development

See `docs/plugin-development.md` for how to create ClawBoard plugins.

## Development Setup

```bash
# Clone
git clone <repo-url>
cd clawboard

# Start development environment
docker compose -f docker-compose.dev.yml up

# Frontend: http://localhost:8082/dashboard-dev/
# Backend: http://localhost:3001/api/
# Database: localhost:5433
```

## Code Style

- TypeScript throughout (frontend + backend)
- React for frontend
- Express for backend
- PostgreSQL for database
- Docker for deployment

## Testing

```bash
# Backend tests
cd backend && npm test

# Frontend build check
cd frontend && npm run build
```

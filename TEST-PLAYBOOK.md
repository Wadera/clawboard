# ClawBoard Integration Test Playbook

> Reusable agent instructions for end-to-end deployment testing on ClawTests LXC.
> Copy this into a `sessions_spawn` task prompt, or reference it with "Follow TEST-PLAYBOOK.md".

## Prerequisites

- **ClawTests LXC:** 192.168.40.141 (LXC 101 on Proxmox)
- **SSH:** `nim@192.168.40.141` (has sudo)
- **OpenClaw bot** running on ClawTests (port 18789, loopback)
- **Proxy:** https://clawtests.skyday.eu → http://192.168.40.141:8080
- **Upstream repo:** `ssh://git@git.skyday.eu:222/Homelab/ClawBoard.git`
- **Fork repo:** `ssh://git@git.skyday.eu:222/paulina/ClawBoard-test.git`
- **Semaphore:** https://semaphore.skyday.eu (admin / F#C#K8g@yNVN5*&m)

---

## CRITICAL RULES

1. **DO NOT install anything on the LXC yourself.** No `docker compose`, `git clone`, `npm install`, or ANY setup commands via SSH.
2. **The local OpenClaw bot on ClawTests must do ALL installation.** You INSTRUCT it and OBSERVE results.
3. **Communicate with the bot via:** `ssh nim@192.168.40.141 "openclaw agent -m 'your message' 2>&1"`
4. **SSH is allowed ONLY to check status** — `docker ps`, `curl`, `ls`, `cat logs` — never to modify.
5. **Document everything** — what worked, what didn't, what's unclear. This tests the deployment experience.

---

## Phase 1: Restore Clean Snapshot

Restore ClawTests to a known-good baseline before testing.

```bash
# Authenticate with Semaphore
COOKIE=$(curl -s -c - https://semaphore.skyday.eu/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"auth":"admin","password":"F#C#K8g@yNVN5*&m"}' \
  | grep semaphore | awk '{print $NF}')

# List available snapshots
ssh nim@192.168.40.141 "echo 'checking'" # verify SSH works first
sudo -u ai ssh ai@192.168.40.11 "sudo pct listsnapshot 101"

# Restore baseline snapshot
curl -s -X POST "https://semaphore.skyday.eu/api/project/2/tasks" \
  -H "Cookie: semaphore=$COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"template_id": 21, "environment": "{\"snapshot_name\": \"SNAPSHOT_NAME_HERE\"}"}'

# Wait for restore to complete (~1-2 min), then verify SSH
sleep 90
ssh nim@192.168.40.141 "uptime && openclaw gateway status 2>&1 | head -5"
```

**Baseline backup (if snapshots expired):**
`vzdump-lxc-101-2026_02_13-15_31_26.tar.zst` (Docker + OpenClaw + SSH keys)

---

## Phase 2: Sync Fork with Upstream

Ensure the downstream fork has all latest changes from upstream.

```bash
cd /tmp && rm -rf clawboard-sync
git clone ssh://git@git.skyday.eu:222/paulina/ClawBoard-test.git clawboard-sync
cd clawboard-sync
git remote add upstream ssh://git@git.skyday.eu:222/Homelab/ClawBoard.git
git fetch upstream

# Check what's different
git log --oneline HEAD..upstream/main
git log --oneline HEAD..upstream/dev 2>/dev/null

# Merge upstream (prefer dev if it exists, otherwise main)
git merge upstream/dev --no-edit 2>/dev/null || git merge upstream/main --no-edit
git push origin main
```

**Verify:** `git log --oneline -5` should show upstream commits merged.

---

## Phase 3: Instruct Bot to Deploy

Send the ClawTests bot a clear deployment instruction:

```bash
ssh nim@192.168.40.141 "openclaw agent -m '
Please clone and deploy ClawBoard dashboard:

1. Clone repo: git clone ssh://git@git.skyday.eu:222/paulina/ClawBoard-test.git /opt/clawboard
2. Read the README.md for setup instructions
3. Set up the environment (.env file) and configure as needed
4. Run docker compose to start the dashboard
5. The dashboard should be accessible on port 8080
6. Report back what you did and any issues you hit

Important: Follow the README exactly. If something is unclear or missing, note it.
' 2>&1"
```

**Wait for the bot to work** (give it 2-5 minutes), then check progress.

---

## Phase 4: Monitor & Verify

```bash
# Check containers
ssh nim@192.168.40.141 "docker ps --format '{{.Names}} {{.Status}}' 2>&1"

# Check dashboard responds
ssh nim@192.168.40.141 "curl -s -o /dev/null -w '%{http_code}' http://localhost:8080 2>&1"

# Check from outside via proxy
curl -s -o /dev/null -w "%{http_code}" https://clawtests.skyday.eu

# Check bot logs
ssh nim@192.168.40.141 "tail -50 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>&1"
```

---

## Phase 5: Test Core Features

Verify these work (via browser at https://clawtests.skyday.eu or curl):

- [ ] Dashboard loads (login page or main page)
- [ ] Tasks page renders
- [ ] Projects page renders
- [ ] Kanban board works
- [ ] Journal page works
- [ ] Sessions page works (if enabled)
- [ ] Sidebar navigation complete
- [ ] No console errors (check browser dev tools)
- [ ] No OOM or container restarts after 5 minutes

---

## Phase 6: Test Plugins (if applicable)

- [ ] Add `clawboard.plugins.json` with test plugin config
- [ ] Plugin appears in sidebar
- [ ] Plugin health check passes
- [ ] Plugin API proxying works
- [ ] Enable/disable toggle works

---

## Phase 7: Report

Create a structured report covering:

### ✅ What Worked
- List everything that went smoothly

### ❌ What Failed
- Exact error messages
- What step it failed at
- Root cause if identifiable

### 📝 Documentation Gaps
- Missing instructions in README
- Unclear setup steps
- Missing dependencies or prerequisites
- Assumptions that weren't documented

### 🔧 Recommendations
- Changes needed to README, docker-compose, or setup scripts
- Improvements to the first-time deployment experience
- Things the bot couldn't figure out on its own

---

## Completing Subtasks (nimtasks)

```bash
export PATH="/home/clawd/clawd/tools:$PATH"
nimtasks complete-subtask <TASK_ID> 4   # Deploy fresh on ClawTests
nimtasks complete-subtask <TASK_ID> 5   # Core dashboard works
nimtasks complete-subtask <TASK_ID> 6   # Plugin discovery
nimtasks complete-subtask <TASK_ID> 7   # Plugin health
nimtasks complete-subtask <TASK_ID> 8   # Plugin API proxy
nimtasks complete-subtask <TASK_ID> 9   # All plugins
nimtasks complete-subtask <TASK_ID> 10  # Enable/disable toggle
nimtasks complete-subtask <TASK_ID> 11  # Load test
nimtasks complete-subtask <TASK_ID> 12  # Bug fixes
```

---

## Snapshot After Success

If testing passes, create a new snapshot as the "tested" baseline:

```bash
COOKIE=$(curl -s -c - https://semaphore.skyday.eu/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"auth":"admin","password":"F#C#K8g@yNVN5*&m"}' \
  | grep semaphore | awk '{print $NF}')

curl -s -X POST "https://semaphore.skyday.eu/api/project/2/tasks" \
  -H "Cookie: semaphore=$COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"template_id": 20, "environment": "{\"snapshot_description\": \"ClawBoard V2 tested and working\"}"}'
```
